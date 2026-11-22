//! Talks to the self-hosted sync server. Same protocol as the Electron version and server/server.js.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use super::crypto::{decrypt_blob, derive_sync_keys, encrypt_blob, is_valid_username, normalize_username, SealedBlob};
use super::merge::{canonical, empty_state, is_sync_state};
use crate::core::{Core, Event};
use crate::error::{bail, Error, Result};
use crate::password_policy::assert_strong;
use crate::types::{now_iso, SyncConfig, SyncStatus};
use crate::vault::crypto::KdfParams;
use crate::vault::SyncKeys;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const SCHEDULE_DELAY: Duration = Duration::from_secs(3);

/// Only https, except plain http to this machine for development. Returns the origin to store.
pub fn check_server_url(input: &str) -> Result<String> {
    let Ok(u) = url::Url::parse(input.trim()) else {
        bail!("The server address is not a valid URL, e.g. https://sync.example.com")
    };
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1"));
    if u.scheme() != "https" && !(local && u.scheme() == "http") {
        bail!("The sync server must use https://");
    }
    if !u.username().is_empty() || u.password().is_some() {
        bail!("The server address must not contain a user name or password");
    }
    Ok(u.origin().ascii_serialization())
}

fn check_username(input: &str) -> Result<String> {
    let name = normalize_username(input);
    if !is_valid_username(&name) {
        bail!("User name: 3 to 32 characters from a-z, 0-9, dot, underscore and dash");
    }
    Ok(name)
}

/// scrypt takes a moment, so it runs off the async threads.
async fn derive(username: String, password: String, kdf: KdfParams) -> Result<SyncKeys> {
    tokio::task::spawn_blocking(move || derive_sync_keys(&username, &password, kdf))
        .await
        .map_err(|e| Error::msg(e.to_string()))?
}

fn b64(k: &[u8; 32]) -> String {
    B64.encode(k)
}

pub struct SyncService {
    kdf: KdfParams,
    http: reqwest::Client,
    /// Held while a sync runs. A sync requested meanwhile sets `again` and waits for it.
    running: tokio::sync::Mutex<()>,
    again: AtomicBool,
    last_run: Mutex<Option<String>>,
    /// Bumped by schedule() and stop(), so only the newest timer fires.
    timer: AtomicU64,
}

impl SyncService {
    pub fn new(kdf: KdfParams) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent("Burrow-Client")
            .build()
            .expect("the HTTP client settings are valid");
        SyncService {
            kdf,
            http,
            running: tokio::sync::Mutex::new(()),
            again: AtomicBool::new(false),
            last_run: Mutex::new(None),
            timer: AtomicU64::new(0),
        }
    }

    fn config(core: &Core) -> SyncConfig {
        core.docs().sync_config.value().clone()
    }

    fn update_config(core: &Core, f: impl FnOnce(&mut SyncConfig)) -> Result<()> {
        let mut d = core.docs();
        let mut c = d.sync_config.value().clone();
        f(&mut c);
        d.sync_config.set(c)
    }

    fn keys(core: &Core) -> Option<SyncKeys> {
        Self::config(core).server_url.as_ref()?;
        let v = core.vault();
        if !v.is_unlocked() {
            return None;
        }
        v.get_sync_keys().ok().flatten()
    }

    pub fn logged_in(&self, core: &Core) -> bool {
        Self::keys(core).is_some()
    }

    pub fn status(&self, core: &Core) -> SyncStatus {
        let c = Self::config(core);
        SyncStatus {
            logged_in: self.logged_in(core),
            server_url: c.server_url,
            username: c.username,
            last_sync_at: c.last_sync_at,
            last_error: c.last_error,
        }
    }

    pub async fn register(&self, core: &Arc<Core>, server_url: &str, username: &str, password: &str, code: &str) -> Result<()> {
        let origin = check_server_url(server_url)?;
        let name = check_username(username)?;
        assert_strong(password, "Account password")?;
        let keys = derive(name.clone(), password.to_string(), self.kdf).await?;
        let body = json!({ "username": name, "authKey": b64(&keys.auth_key), "code": code.trim() });
        self.request(core, "POST", "/api/register", None, Some(body), Some(&origin)).await?;
        self.save_login(core, origin, name, keys).await
    }

    pub async fn login(&self, core: &Arc<Core>, server_url: &str, username: &str, password: &str) -> Result<()> {
        let origin = check_server_url(server_url)?;
        let name = check_username(username)?;
        let keys = derive(name.clone(), password.to_string(), self.kdf).await?;
        match self.request(core, "POST", "/api/login", Some(&keys.auth_key), None, Some(&origin)).await {
            Err(e) if e.http_status() == Some(401) => bail!("Wrong user name or password"),
            r => r?,
        };
        self.save_login(core, origin, name, keys).await
    }

    async fn save_login(&self, core: &Arc<Core>, server_url: String, username: String, keys: SyncKeys) -> Result<()> {
        core.vault().set_sync_keys(Some(&keys))?;
        core.docs().sync_config.set(SyncConfig { server_url: Some(server_url), username: Some(username), ..Default::default() })?;
        self.sync_now(core).await
    }

    /// This device stops syncing. Local data stays as it is.
    pub fn logout(&self, core: &Core, last_error: Option<String>) -> Result<()> {
        self.stop();
        {
            let mut v = core.vault();
            if v.is_unlocked() {
                v.set_sync_keys(None)?;
            }
        }
        core.docs().sync_config.set(SyncConfig { last_error, ..Default::default() })?;
        core.emit(Event::SyncChanged);
        Ok(())
    }

    /// Call after every local change. A burst of changes becomes one sync a few seconds later.
    pub fn schedule(&self, core: &Arc<Core>) {
        let ticket = self.timer.fetch_add(1, Ordering::SeqCst) + 1;
        if !self.logged_in(core) {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let weak = Arc::downgrade(core);
        rt.spawn(async move {
            tokio::time::sleep(SCHEDULE_DELAY).await;
            let Some(core) = weak.upgrade() else { return };
            if core.sync.timer.load(Ordering::SeqCst) == ticket {
                core.sync.sync_if_logged_in(&core).await;
            }
        });
    }

    pub fn stop(&self) {
        self.timer.fetch_add(1, Ordering::SeqCst);
    }

    /// For timers and unlock: syncs when logged in and never fails (the error is kept in the status).
    pub async fn sync_if_logged_in(&self, core: &Arc<Core>) {
        if self.logged_in(core) {
            let _ = self.sync_now(core).await;
        }
    }

    /// Runs one sync. If one is already running, waits for it and the one more round it then runs.
    pub async fn sync_now(&self, core: &Arc<Core>) -> Result<()> {
        self.again.store(true, Ordering::SeqCst);
        let guard = match self.running.try_lock() {
            Ok(g) => g,
            Err(_) => {
                // Another call is running and will see `again`. Its result is ours too.
                let _wait = self.running.lock().await;
                return match self.last_run.lock().unwrap().clone() {
                    None => Ok(()),
                    Some(e) => Err(Error::msg(e)),
                };
            }
        };
        let result: Result<()> = async {
            while self.again.swap(false, Ordering::SeqCst) {
                self.sync_once(core).await?;
            }
            Ok(())
        }
        .await;
        let result = match result {
            Ok(()) => {
                Self::update_config(core, |c| {
                    c.last_sync_at = Some(now_iso());
                    c.last_error = None;
                })?;
                core.emit(Event::SyncChanged);
                Ok(())
            }
            Err(e) => {
                if e.http_status() == Some(401) {
                    let msg = "The account password was changed or the account was deleted. Log in again.";
                    let _ = self.logout(core, Some(msg.into()));
                } else if Self::config(core).server_url.is_some() {
                    let _ = Self::update_config(core, |c| c.last_error = Some(e.to_string()));
                    core.emit(Event::SyncChanged);
                }
                Err(e)
            }
        };
        *self.last_run.lock().unwrap() = result.as_ref().err().map(|e| e.to_string());
        drop(guard);
        result
    }

    async fn sync_once(&self, core: &Arc<Core>) -> Result<()> {
        for _ in 0..3 {
            let Some(keys) = Self::keys(core) else { bail!("Not logged in to a sync server") };
            let remote = self.request(core, "GET", "/api/blob", Some(&keys.auth_key), None, None).await?;
            let remote_version = remote.get("version").and_then(Value::as_i64).unwrap_or(0);
            let remote_data = remote.get("data").filter(|d| !d.is_null());
            let remote_state = match remote_data {
                None => empty_state(&core.settings()),
                Some(data) => {
                    let blob: SealedBlob = serde_json::from_value(data.clone()).map_err(|_| Error::msg("The synced data could not be decrypted"))?;
                    let state = decrypt_blob(&blob, &keys.enc_key)?;
                    if !is_sync_state(&state) {
                        bail!("The synced data has an unknown format. Update Burrow on all devices.");
                    }
                    state
                }
            };

            core.apply_sync_state(&remote_state)?;
            core.emit(Event::SyncChanged);

            let merged = core.export_sync_state()?;
            if remote_data.is_some() && canonical(&merged) == canonical(&remote_state) {
                Self::update_config(core, |c| c.version = Some(remote_version))?;
                return Ok(());
            }
            let body = json!({ "version": remote_version, "data": encrypt_blob(&merged, &keys.enc_key) });
            match self.request(core, "PUT", "/api/blob", Some(&keys.auth_key), Some(body), None).await {
                Ok(r) => {
                    let version = r.get("version").and_then(Value::as_i64);
                    Self::update_config(core, |c| c.version = version)?;
                    return Ok(());
                }
                // 409: another device uploaded in between. Fetch again and merge its changes too.
                Err(e) if e.http_status() == Some(409) => continue,
                Err(e) => return Err(e),
            }
        }
        bail!("Sync failed three times in a row because other devices kept uploading. Try again.")
    }

    /// Checks the account password against the keys stored on this device.
    async fn verify_password(&self, core: &Core, password: &str) -> Result<SyncKeys> {
        let (Some(stored), Some(username)) = (Self::keys(core), Self::config(core).username) else {
            bail!("Not logged in to a sync server")
        };
        let keys = derive(username, password.to_string(), self.kdf).await?;
        if !bool::from(keys.auth_key.ct_eq(stored.auth_key.as_ref())) {
            bail!("The account password is wrong");
        }
        Ok(keys)
    }

    pub async fn change_password(&self, core: &Arc<Core>, current: &str, next: &str) -> Result<()> {
        let old = self.verify_password(core, current).await?;
        assert_strong(next, "Account password")?;
        let username = Self::config(core).username.unwrap_or_default();
        let fresh = derive(username, next.to_string(), self.kdf).await?;
        for _ in 0..3 {
            // Upload everything first, so the re-encrypted copy is complete.
            self.sync_now(core).await?;
            let body = json!({
                "newAuthKey": b64(&fresh.auth_key),
                "version": Self::config(core).version.unwrap_or(0),
                "data": encrypt_blob(&core.export_sync_state()?, &fresh.enc_key),
            });
            match self.request(core, "POST", "/api/password", Some(&old.auth_key), Some(body), None).await {
                Ok(r) => {
                    core.vault().set_sync_keys(Some(&fresh))?;
                    let version = r.get("version").and_then(Value::as_i64);
                    Self::update_config(core, |c| c.version = version)?;
                    core.emit(Event::SyncChanged);
                    return Ok(());
                }
                Err(e) if e.http_status() == Some(409) => continue,
                Err(e) => return Err(e),
            }
        }
        bail!("Could not change the password because other devices kept uploading. Try again.")
    }

    pub async fn delete_account(&self, core: &Arc<Core>, password: &str) -> Result<()> {
        let keys = self.verify_password(core, password).await?;
        self.request(core, "DELETE", "/api/account", Some(&keys.auth_key), None, None).await?;
        self.logout(core, None)
    }

    async fn request(
        &self,
        core: &Core,
        method: &str,
        path: &str,
        auth_key: Option<&[u8; 32]>,
        body: Option<Value>,
        server_url: Option<&str>,
    ) -> Result<Value> {
        let base = match server_url {
            Some(s) => s.to_string(),
            None => match Self::config(core).server_url {
                Some(s) => s,
                None => bail!("No sync server set"),
            },
        };
        let url = format!("{base}{path}");
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| Error::msg(e.to_string()))?;
        let mut req = self.http.request(method, &url).header("content-type", "application/json");
        if let Some(k) = auth_key {
            req = req.header("authorization", format!("Bearer {}", b64(k)));
        }
        if let Some(b) = body {
            req = req.body(b.to_string());
        }
        let Ok(res) = req.send().await else { bail!("Could not reach the sync server at {base}") };
        let status = res.status();
        let json: Value = res.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            let message = json
                .get("error")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("The sync server answered with status {}", status.as_u16()));
            return Err(Error::Http { status: status.as_u16(), message });
        }
        Ok(json)
    }
}
