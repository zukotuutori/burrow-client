//! Everything the window can ask for, without any Tauri types, so it can be tested on its own.
//!
//! Locks are taken in the order docs, then vault, and never held across an await. Methods that may run
//! scrypt are synchronous; the command layer calls them on a blocking thread.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::error::{bail, Error, Result};
use crate::keys::{self, KeyMaterial, KeyType};
use crate::local_shell::LocalShell;
use crate::password_policy::assert_strong;
use crate::ssh::hostkeys::{check_host_key, host_id};
use crate::ssh::reachable::is_reachable;
use crate::ssh::session::{Auth, ConnectOptions, OnClose, OnData, SshSession, VerifyHostKey};
use crate::store::json_doc::JsonDoc;
use crate::store::json_file::file_name;
use crate::store::repo::{Entry, Repo, Tombstone};
use crate::sync::merge::merge_state;
use crate::sync::service::SyncService;
use crate::types::*;
use crate::validate::{
    is_safe_id, validate_key_meta, validate_known_hosts, validate_profile, validate_settings, validate_snippet,
    validate_snippet_export,
};
use crate::vault::crypto::KdfParams;
use crate::vault::{KeySecret, Vault};

/// Something the window should hear about.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    SessionData { id: String, data: String },
    SessionClosed { id: String, reason: String },
    /// A sync changed local data or the sync status.
    SyncChanged,
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;
pub type Ask = Arc<dyn Fn(Prompt) -> Pin<Box<dyn Future<Output = PromptAnswer> + Send>> + Send + Sync>;

pub struct Docs {
    pub profiles: Repo<Profile>,
    pub snippets: Repo<Snippet>,
    pub keys: Repo<KeyMeta>,
    pub known_hosts: JsonDoc<KnownHosts>,
    pub settings: JsonDoc<Settings>,
    pub sync_config: JsonDoc<SyncConfig>,
}

enum Session {
    Ssh(Arc<SshSession>),
    Local(Arc<LocalShell>),
}

pub struct Core {
    docs: Mutex<Docs>,
    vault: Mutex<Vault>,
    sessions: Mutex<HashMap<String, Session>>,
    load_errors: Mutex<Vec<LoadError>>,
    /// Bumped on every lock, so a connect that started before the lock can tell.
    lock_generation: AtomicU64,
    pub sync: SyncService,
    emit: Emit,
    me: Weak<Core>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Core {
    pub fn new(dir: &Path, emit: Emit, kdf: KdfParams, sync_kdf: KdfParams) -> Arc<Core> {
        Arc::new_cyclic(|me| Core {
            docs: Mutex::new(Docs {
                profiles: Repo::new(dir.join("profiles.json")),
                snippets: Repo::new(dir.join("snippets.json")),
                keys: Repo::new(dir.join("keys.json")),
                known_hosts: JsonDoc::new(dir.join("known_hosts.json"), KnownHosts::new()),
                settings: JsonDoc::new(dir.join("settings.json"), Settings::default()),
                sync_config: JsonDoc::new(dir.join("sync.json"), SyncConfig::default()),
            }),
            vault: Mutex::new(Vault::new(dir.join("vault.enc"), kdf)),
            sessions: Mutex::new(HashMap::new()),
            load_errors: Mutex::new(Vec::new()),
            lock_generation: AtomicU64::new(0),
            sync: SyncService::new(sync_kdf),
            emit,
            me: me.clone(),
        })
    }

    pub fn docs(&self) -> MutexGuard<'_, Docs> {
        lock(&self.docs)
    }

    pub fn vault(&self) -> MutexGuard<'_, Vault> {
        lock(&self.vault)
    }

    pub(crate) fn emit(&self, e: Event) {
        (self.emit)(e)
    }

    /// Loads every file. Files that cannot be read are listed in `load_errors` instead of failing.
    pub fn init(&self) -> Result<()> {
        let mut errors = Vec::new();
        let mut d = self.docs();
        let Docs { profiles, snippets, keys, known_hosts, settings, sync_config } = &mut *d;
        let results = [
            (file_name(profiles.doc.file()), profiles.doc.load()),
            (file_name(snippets.doc.file()), snippets.doc.load()),
            (file_name(keys.doc.file()), keys.doc.load()),
            (file_name(known_hosts.file()), known_hosts.load()),
            (file_name(settings.file()), settings.load()),
            (file_name(sync_config.file()), sync_config.load()),
        ];
        for (file, r) in results {
            match r {
                Ok(()) => {}
                Err(e @ Error::CorruptFile { .. }) => errors.push(LoadError { file, message: e.to_string() }),
                Err(e) => return Err(e),
            }
        }
        *lock(&self.load_errors) = errors;
        Ok(())
    }

    pub fn load_errors(&self) -> Vec<LoadError> {
        lock(&self.load_errors).clone()
    }

    pub fn reset_file(&self, file: &str) -> Result<()> {
        let mut d = self.docs();
        let Docs { profiles, snippets, keys, known_hosts, settings, sync_config } = &mut *d;
        let broken = |name: &str, is_broken: bool| -> Result<()> {
            if !is_broken {
                bail!("{name} can be read, so it cannot be reset");
            }
            Ok(())
        };
        macro_rules! reset {
            ($doc:expr) => {{
                broken(file, $doc.is_broken())?;
                $doc.reset()?;
            }};
        }
        match file {
            _ if file == file_name(profiles.doc.file()) => reset!(profiles.doc),
            _ if file == file_name(snippets.doc.file()) => reset!(snippets.doc),
            _ if file == file_name(keys.doc.file()) => reset!(keys.doc),
            _ if file == file_name(known_hosts.file()) => reset!(known_hosts),
            _ if file == file_name(settings.file()) => reset!(settings),
            _ if file == file_name(sync_config.file()) => reset!(sync_config),
            _ => bail!("Unknown file: {file}"),
        }
        lock(&self.load_errors).retain(|e| e.file != file);
        Ok(())
    }

    // Vault

    pub fn vault_status(&self) -> Result<VaultStatus> {
        self.vault().status()
    }

    /// Creates a new vault; the master password must meet the password policy.
    pub fn create_vault(&self, password: &str) -> Result<()> {
        assert_strong(password, "Master password")?;
        self.vault().create(password)
    }

    pub fn unlock(&self, password: &str) -> Result<()> {
        self.vault().unlock(password)
    }

    /// Re-encrypts the vault under a new master password; the new one must meet the password policy.
    pub fn change_master_password(&self, current: &str, next: &str) -> Result<()> {
        assert_strong(next, "Master password")?;
        match self.vault().change_password(current, next) {
            Err(Error::WrongPassword) => bail!("The current password is wrong"),
            r => r,
        }
    }

    /// Backs up and removes vault.enc. Only allowed when the file cannot be read, so a healthy vault is never wiped.
    pub fn reset_vault(&self) -> Result<()> {
        if self.vault().file_status()? != VaultStatus::Broken {
            bail!("The vault can only be reset when it cannot be read");
        }
        self.lock();
        self.vault().reset()?;
        Ok(())
    }

    /// Closes every session and forgets the vault key.
    pub fn lock(&self) {
        self.sync.stop();
        self.lock_generation.fetch_add(1, Ordering::SeqCst);
        self.close_all();
        self.vault().lock();
    }

    pub fn is_unlocked(&self) -> bool {
        self.vault().is_unlocked()
    }

    /// Called after every change the user makes, so sync can upload it.
    pub(crate) fn changed(&self) {
        if let Some(me) = self.me.upgrade() {
            self.sync.schedule(&me);
        }
    }

    // Profiles

    pub fn profiles(&self) -> Vec<Profile> {
        self.docs().profiles.list()
    }

    pub fn save_profile(&self, input: &Value, password: Option<&str>) -> Result<()> {
        let p = validate_profile(input)?;
        let mut d = self.docs();
        if p.auth_type == AuthType::Key && p.key_id.as_deref().and_then(|id| d.keys.get(id)).is_none() {
            bail!("Key not found");
        }
        d.profiles.upsert(p.clone())?;
        let mut v = self.vault();
        if p.auth_type == AuthType::Key {
            v.set_password(&p.id, None)?;
        } else if let Some(pw) = password.filter(|pw| !pw.is_empty()) {
            v.set_password(&p.id, Some(pw))?;
        }
        drop((v, d));
        self.changed();
        Ok(())
    }

    /// Only saved hosts can be probed, so the window cannot use this to scan arbitrary addresses.
    pub async fn is_reachable(&self, profile_id: &str) -> Result<bool> {
        let (host, port) = match self.docs().profiles.get(profile_id) {
            Some(p) => (p.host.clone(), p.port),
            None => bail!("Host not found"),
        };
        Ok(is_reachable(&host, port, Duration::from_secs(3)).await)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let mut d = self.docs();
        d.profiles.remove(id)?;
        self.vault().set_password(id, None)?;
        // Snippets left without any host become global again instead of disappearing.
        if d.snippets.list().iter().any(|s| s.profile_ids.as_ref().is_some_and(|p| p.iter().any(|x| x == id))) {
            let now = now_ms();
            let next: Vec<Entry<Snippet>> = d
                .snippets
                .all()
                .iter()
                .map(|e| match e {
                    Entry::Live(s) if s.profile_ids.as_ref().is_some_and(|p| p.iter().any(|x| x == id)) => {
                        let mut s = s.clone();
                        let remaining: Vec<String> = s.profile_ids.take().unwrap_or_default().into_iter().filter(|x| x != id).collect();
                        s.profile_ids = Some(remaining).filter(|r| !r.is_empty());
                        s.updated_at = Some(now);
                        Entry::Live(s)
                    }
                    other => other.clone(),
                })
                .collect();
            d.snippets.doc.set(next)?;
        }
        drop(d);
        self.changed();
        Ok(())
    }

    pub fn has_password(&self, id: &str) -> Result<bool> {
        Ok(self.vault().get_password(id)?.is_some())
    }

    pub fn forget_password(&self, id: &str) -> Result<()> {
        self.vault().set_password(id, None)?;
        self.touch_profile(id)
    }

    /// Marks a host as changed after its saved password changed, so the change wins on other devices.
    fn touch_profile(&self, id: &str) -> Result<()> {
        let mut d = self.docs();
        if let Some(p) = d.profiles.get(id).cloned() {
            d.profiles.upsert(p)?;
        }
        drop(d);
        self.changed();
        Ok(())
    }

    // Snippets and settings

    pub fn snippets(&self) -> Vec<Snippet> {
        self.docs().snippets.list()
    }

    pub fn save_snippet(&self, input: &Value) -> Result<()> {
        let s = validate_snippet(input)?;
        let mut d = self.docs();
        if s.profile_ids.iter().flatten().any(|id| d.profiles.get(id).is_none()) {
            bail!("Host not found");
        }
        d.snippets.upsert(s)?;
        drop(d);
        self.changed();
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        self.docs().snippets.remove(id)?;
        self.changed();
        Ok(())
    }

    /// All snippets without ids; host links are written as host labels so they can be matched on another machine.
    pub fn export_snippets(&self) -> SnippetExport {
        let d = self.docs();
        let snippets = d
            .snippets
            .list()
            .into_iter()
            .map(|s| {
                let hosts: Vec<String> =
                    s.profile_ids.iter().flatten().filter_map(|id| d.profiles.get(id).map(|p| p.name.clone())).collect();
                SnippetExportEntry {
                    name: s.name,
                    command: s.command,
                    tags: s.tags.filter(|t| !t.is_empty()),
                    hosts: Some(hosts).filter(|h| !h.is_empty()),
                }
            })
            .collect();
        SnippetExport { format: "burrow-snippets", version: 1, snippets }
    }

    /// Adds the snippets from an export file. Hosts are matched by label (case-insensitive); snippets whose hosts
    /// are all unknown here become global. Snippets with the same name and command as an existing one are skipped.
    pub fn import_snippets(&self, data: &Value) -> Result<SnippetImportResult> {
        let entries = validate_snippet_export(data)?;
        let mut d = self.docs();
        let key = |name: &str, command: &str| (name.trim().to_string(), command.to_string());
        let mut seen: HashSet<(String, String)> = d.snippets.list().iter().map(|s| key(&s.name, &s.command)).collect();
        let profiles = d.profiles.list();
        let mut added = Vec::new();
        let mut skipped = 0;
        for e in entries {
            if !seen.insert(key(&e.name, &e.command)) {
                skipped += 1;
                continue;
            }
            let mut ids: Vec<String> = Vec::new();
            for label in e.hosts.iter().flatten() {
                for p in profiles.iter().filter(|p| p.name.to_lowercase() == label.to_lowercase()) {
                    if !ids.contains(&p.id) {
                        ids.push(p.id.clone());
                    }
                }
            }
            let raw = json!({ "id": uuid::Uuid::new_v4().to_string(), "name": e.name, "command": e.command, "tags": e.tags, "profileIds": ids });
            let mut s = validate_snippet(&raw)?;
            s.updated_at = Some(now_ms());
            added.push(Entry::Live(s));
        }
        let imported = added.len();
        if imported > 0 {
            let mut next = d.snippets.all().to_vec();
            next.extend(added);
            d.snippets.doc.set(next)?;
            drop(d);
            self.changed();
        }
        Ok(SnippetImportResult { imported, skipped })
    }

    pub fn settings(&self) -> Settings {
        self.docs().settings.value().clone()
    }

    pub fn save_settings(&self, input: &Value) -> Result<()> {
        let mut s = validate_settings(input)?;
        s.updated_at = Some(now_ms());
        self.docs().settings.set(s)?;
        self.changed();
        Ok(())
    }

    // Keys

    pub fn keys(&self) -> Vec<KeyMeta> {
        self.docs().keys.list()
    }

    pub fn generate_key(&self, name: &str, key_type: KeyType) -> Result<KeyMeta> {
        let name = name.trim();
        if name.is_empty() {
            bail!("Name is required");
        }
        self.add_key(name, keys::generate_key(key_type, name)?, None)
    }

    pub fn import_key(&self, name: &str, private_key: &str, passphrase: Option<&str>) -> Result<KeyMeta> {
        let name = name.trim();
        if name.is_empty() {
            bail!("Name is required");
        }
        let text = format!("{}\n", private_key.trim());
        self.add_key(name, keys::import_key(&text, passphrase, name)?, passphrase)
    }

    fn add_key(&self, name: &str, m: KeyMaterial, passphrase: Option<&str>) -> Result<KeyMeta> {
        let meta = KeyMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            key_type: m.key_type,
            public_key: m.public_key,
            fingerprint: m.fingerprint,
            created_at: now_iso(),
            updated_at: None,
        };
        let mut d = self.docs();
        let secret = KeySecret { private_key: m.private_key.to_string(), passphrase: passphrase.filter(|p| !p.is_empty()).map(String::from) };
        self.vault().set_key(&meta.id, Some(secret))?;
        d.keys.upsert(meta.clone())?;
        drop(d);
        self.changed();
        Ok(meta)
    }

    pub fn delete_key(&self, id: &str) -> Result<()> {
        let mut d = self.docs();
        let users: Vec<String> =
            d.profiles.list().into_iter().filter(|p| p.auth_type == AuthType::Key && p.key_id.as_deref() == Some(id)).map(|p| p.name).collect();
        if !users.is_empty() {
            bail!("Key is used by: {}", users.join(", "));
        }
        d.keys.remove(id)?;
        self.vault().set_key(id, None)?;
        drop(d);
        self.changed();
        Ok(())
    }

    // Known hosts

    /// Known hosts without tombstones.
    pub fn known_hosts(&self) -> KnownHosts {
        self.docs().known_hosts.value().iter().filter(|(_, h)| !h.deleted).map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn remove_known_host(&self, id: &str) -> Result<()> {
        let mut d = self.docs();
        let mut next = d.known_hosts.value().clone();
        let Some(entry) = next.get_mut(id).filter(|e| !e.deleted) else { return Ok(()) };
        entry.deleted = true;
        entry.updated_at = Some(now_ms());
        d.known_hosts.set(next)?;
        drop(d);
        self.changed();
        Ok(())
    }

    // Sync

    fn export_locked(d: &Docs, v: &Vault) -> Result<Value> {
        let (passwords, secrets) = v.secrets()?;
        let profiles: Vec<Value> = d
            .profiles
            .all()
            .iter()
            .map(|e| {
                let mut x = serde_json::to_value(e).unwrap_or_default();
                if let Entry::Live(p) = e {
                    if let Some(pw) = passwords.get(&p.id) {
                        x["password"] = json!(pw);
                    }
                }
                x
            })
            .collect();
        let keys: Vec<Value> = d
            .keys
            .all()
            .iter()
            .map(|e| {
                let mut x = serde_json::to_value(e).unwrap_or_default();
                if let Entry::Live(k) = e {
                    if let Some(s) = secrets.get(&k.id) {
                        x["privateKey"] = json!(s.private_key);
                        if let Some(pp) = &s.passphrase {
                            x["passphrase"] = json!(pp);
                        }
                    }
                }
                x
            })
            .collect();
        Ok(json!({
            "v": 1,
            "profiles": profiles,
            "keys": keys,
            "snippets": d.snippets.all(),
            "knownHosts": d.known_hosts.value(),
            "settings": d.settings.value(),
        }))
    }

    /// Everything that is synced, including tombstones and the secrets from the vault.
    pub fn export_sync_state(&self) -> Result<Value> {
        let d = self.docs();
        let v = self.vault();
        Self::export_locked(&d, &v)
    }

    /// Merges data from the server into the local files and the vault, under one lock, so a change made while
    /// sync was talking to the server is merged too instead of being lost.
    pub fn apply_sync_state(&self, incoming: &Value) -> Result<()> {
        let mut d = self.docs();
        let mut v = self.vault();
        let s = merge_state(&Self::export_locked(&d, &v)?, incoming);
        let list = |k: &str| s.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
        let id_of = |raw: &Value| -> Result<String> {
            match raw.get("id").and_then(Value::as_str) {
                Some(id) if is_safe_id(id) => Ok(id.to_string()),
                _ => bail!("The synced data contains an invalid id"),
            }
        };
        let tomb = |raw: &Value, id: String| Tombstone { id, updated_at: raw.get("updatedAt").and_then(Value::as_f64).map(|f| f as i64) };
        let deleted = |raw: &Value| raw.get("deleted") == Some(&Value::Bool(true));

        let mut passwords = BTreeMap::new();
        let mut profiles = Vec::new();
        for raw in list("profiles") {
            let id = id_of(&raw)?;
            if deleted(&raw) {
                profiles.push(Entry::Deleted(tomb(&raw, id)));
                continue;
            }
            let p = validate_profile(&raw)?;
            if let (Some(pw), AuthType::Password) = (raw.get("password").and_then(Value::as_str), p.auth_type) {
                passwords.insert(p.id.clone(), pw.to_string());
            }
            profiles.push(Entry::Live(p));
        }

        let mut secrets = BTreeMap::new();
        let mut keys = Vec::new();
        for raw in list("keys") {
            let id = id_of(&raw)?;
            if deleted(&raw) {
                keys.push(Entry::Deleted(tomb(&raw, id)));
                continue;
            }
            let k = validate_key_meta(&raw)?;
            if let Some(pk) = raw.get("privateKey").and_then(Value::as_str) {
                let passphrase = raw.get("passphrase").and_then(Value::as_str).filter(|p| !p.is_empty()).map(String::from);
                secrets.insert(k.id.clone(), KeySecret { private_key: pk.to_string(), passphrase });
            }
            keys.push(Entry::Live(k));
        }

        let mut snippets = Vec::new();
        for raw in list("snippets") {
            let id = id_of(&raw)?;
            snippets.push(if deleted(&raw) { Entry::Deleted(tomb(&raw, id)) } else { Entry::Live(validate_snippet(&raw)?) });
        }
        let known_hosts = validate_known_hosts(s.get("knownHosts").unwrap_or(&Value::Null))?;
        let settings = validate_settings(s.get("settings").unwrap_or(&Value::Null))?;

        d.profiles.doc.set(profiles)?;
        d.keys.doc.set(keys)?;
        d.snippets.doc.set(snippets)?;
        d.known_hosts.set(known_hosts)?;
        d.settings.set(settings)?;
        v.replace_secrets(passwords, secrets)?;
        Ok(())
    }

    // Sessions

    pub async fn connect(&self, session_id: &str, profile_id: &str, cols: u32, rows: u32, ask: Ask) -> Result<()> {
        if lock(&self.sessions).contains_key(session_id) {
            bail!("Session id already in use");
        }
        let Some(p) = self.docs().profiles.get(profile_id).cloned() else { bail!("Host not found in profiles") };
        let generation = self.lock_generation.load(Ordering::SeqCst);

        // What to save in the vault once the login worked.
        enum Persist {
            Nothing,
            Password(Zeroizing<String>),
            Passphrase(String, KeySecret),
        }
        let mut persist = Persist::Nothing;

        let auth = match p.auth_type {
            AuthType::Password => match self.vault().get_password(&p.id)? {
                Some(pw) => Auth::Password(Zeroizing::new(pw)),
                None => {
                    let ans = ask(Prompt::Password { label: format!("{}@{}", p.user, p.host) }).await;
                    let (true, Some(value)) = (ans.ok, ans.value) else { bail!("Cancelled") };
                    let value = Zeroizing::new(value);
                    if ans.save {
                        persist = Persist::Password(value.clone());
                    }
                    Auth::Password(value)
                }
            },
            AuthType::Key => {
                let key_id = p.key_id.clone().unwrap_or_default();
                let Some(secret) = self.vault().get_key(&key_id)? else { bail!("The key for this host is missing") };
                let mut passphrase = secret.passphrase.clone();
                if passphrase.is_none() && keys::is_encrypted(&secret.private_key)? {
                    let label = self.docs().keys.get(&key_id).map(|k| k.name.clone()).unwrap_or_else(|| "key".into());
                    let ans = ask(Prompt::Passphrase { label }).await;
                    let value = match (ans.ok, ans.value) {
                        (true, Some(v)) if !v.is_empty() => v,
                        _ => bail!("Cancelled"),
                    };
                    if ans.save {
                        persist = Persist::Passphrase(key_id.clone(), KeySecret { passphrase: Some(value.clone()), ..secret.clone() });
                    }
                    passphrase = Some(value);
                }
                // Fails with "Could not read key" on a wrong passphrase.
                Auth::Key(Arc::new(keys::parse_private(&secret.private_key, passphrase.as_deref())?))
            }
        };

        let verify: VerifyHostKey = {
            let me = self.me.clone();
            let (host, port) = (p.host.clone(), p.port);
            Arc::new(move |algo: String, fingerprint: String| {
                let me = me.clone();
                let host = host.clone();
                let ask = ask.clone();
                Box::pin(async move {
                    let Some(core) = me.upgrade() else { return false };
                    let check = check_host_key(core.docs().known_hosts.value(), &host, port, &algo, &fingerprint);
                    if check == HostKeyCheck::Match {
                        return true;
                    }
                    if !ask(Prompt::Hostkey { host: host.clone(), port, check }).await.ok {
                        return false;
                    }
                    let mut d = core.docs();
                    let mut next = d.known_hosts.value().clone();
                    let entry = KnownHost { algo, fingerprint, added_at: now_iso(), updated_at: Some(now_ms()), deleted: false };
                    next.insert(host_id(&host, port), entry);
                    let saved = d.known_hosts.set(next).is_ok();
                    drop(d);
                    core.changed();
                    saved
                })
            })
        };

        let registered = Arc::new(AtomicBool::new(false));
        let on_data: OnData = {
            let me = self.me.clone();
            let id = session_id.to_string();
            Arc::new(move |data| {
                if let Some(core) = me.upgrade() {
                    core.emit(Event::SessionData { id: id.clone(), data });
                }
            })
        };
        let on_close: OnClose = {
            let me = self.me.clone();
            let id = session_id.to_string();
            let registered = registered.clone();
            Box::new(move |reason| {
                let Some(core) = me.upgrade() else { return };
                if !registered.load(Ordering::SeqCst) {
                    return;
                }
                lock(&core.sessions).remove(&id);
                core.emit(Event::SessionClosed { id, reason: reason.unwrap_or_else(|| "Connection closed".into()) });
            })
        };

        let opts = ConnectOptions {
            host: p.host.clone(),
            port: p.port,
            username: p.user.clone(),
            auth,
            cols,
            rows,
            handshake_timeout: Duration::from_secs(20),
        };
        let session = Arc::new(SshSession::open(opts, verify, on_data, on_close).await?);
        if !self.is_unlocked() || generation != self.lock_generation.load(Ordering::SeqCst) {
            session.close();
            bail!("Cancelled");
        }
        {
            let mut sessions = lock(&self.sessions);
            if sessions.contains_key(session_id) {
                session.close();
                bail!("Session id already in use");
            }
            sessions.insert(session_id.to_string(), Session::Ssh(session.clone()));
            registered.store(true, Ordering::SeqCst);
        }

        let saved = match persist {
            Persist::Nothing => Ok(()),
            Persist::Password(pw) => self.vault().set_password(&p.id, Some(&pw)).and_then(|_| self.touch_profile(&p.id)),
            Persist::Passphrase(key_id, secret) => (|| {
                self.vault().set_key(&key_id, Some(secret))?;
                let mut d = self.docs();
                if let Some(meta) = d.keys.get(&key_id).cloned() {
                    d.keys.upsert(meta)?;
                }
                drop(d);
                self.changed();
                Ok(())
            })(),
        };
        if let Err(e) = saved {
            session.close();
            return Err(e);
        }
        Ok(())
    }

    pub fn open_local(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let mut sessions = lock(&self.sessions);
        if sessions.contains_key(session_id) {
            bail!("Session id already in use");
        }
        let me = self.me.clone();
        let id = session_id.to_string();
        let on_data: OnData = {
            let me = me.clone();
            let id = id.clone();
            Arc::new(move |data| {
                if let Some(core) = me.upgrade() {
                    core.emit(Event::SessionData { id: id.clone(), data });
                }
            })
        };
        let on_close: OnClose = Box::new(move |reason| {
            let Some(core) = me.upgrade() else { return };
            lock(&core.sessions).remove(&id);
            core.emit(Event::SessionClosed { id, reason: reason.unwrap_or_else(|| "Shell closed".into()) });
        });
        let shell = LocalShell::spawn(cols, rows, on_data, on_close)?;
        sessions.insert(session_id.to_string(), Session::Local(Arc::new(shell)));
        Ok(())
    }

    fn session(&self, id: &str) -> Option<Session> {
        lock(&self.sessions).get(id).map(|s| match s {
            Session::Ssh(x) => Session::Ssh(x.clone()),
            Session::Local(x) => Session::Local(x.clone()),
        })
    }

    pub fn write(&self, id: &str, data: &str) {
        match self.session(id) {
            Some(Session::Ssh(s)) => s.write(data),
            Some(Session::Local(s)) => s.write(data),
            None => {}
        }
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) {
        match self.session(id) {
            Some(Session::Ssh(s)) => s.resize(cols, rows),
            Some(Session::Local(s)) => s.resize(cols.min(u16::MAX as u32) as u16, rows.min(u16::MAX as u32) as u16),
            None => {}
        }
    }

    /// Closing runs the session's close callback, which takes it out of the list. That callback locks the
    /// session list itself, so the sessions are collected first and closed without holding the lock.
    pub fn close_session(&self, id: &str) {
        match self.session(id) {
            Some(Session::Ssh(s)) => s.close(),
            Some(Session::Local(s)) => s.close(),
            None => {}
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        for id in ids {
            self.close_session(&id);
        }
    }

    pub async fn sftp(&self, id: &str) -> Result<Arc<russh_sftp::client::SftpSession>> {
        match self.session(id) {
            Some(Session::Ssh(s)) => s.sftp().await,
            _ => bail!("Session is not connected"),
        }
    }
}
