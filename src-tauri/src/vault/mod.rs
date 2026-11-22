//! The encrypted vault with passwords, private keys, passphrases and the sync keys.
//!
//! Every method is synchronous and some run scrypt, so callers keep the vault behind a lock and call the slow
//! ones from a blocking thread. Holding the lock through a password change means a lock request waits for it
//! instead of racing it.

pub mod crypto;

use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{bail, Error, Result};
use crate::store::json_file::{backup_file, corrupt, read_text, write_file_atomic};
use crate::types::VaultStatus;
use crypto::{derive_key, open, parse_vault_file, random_bytes, seal, KdfParams, Key, DEFAULT_KDF};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct KeySecret {
    pub private_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Zeroize)]
#[serde(rename_all = "camelCase")]
struct SyncKeysJson {
    auth_key: String,
    enc_key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct VaultData {
    version: u32,
    passwords: BTreeMap<String, String>,
    keys: BTreeMap<String, KeySecret>,
    /// Base64 keys of the sync account. Missing when this device is not logged in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sync: Option<SyncKeysJson>,
}

impl Drop for VaultData {
    /// Overwrites the secrets when the vault locks, instead of leaving them in freed memory.
    fn drop(&mut self) {
        for v in self.passwords.values_mut() {
            v.zeroize();
        }
        for v in self.keys.values_mut() {
            v.zeroize();
        }
        self.sync.zeroize();
    }
}

pub struct SyncKeys {
    pub auth_key: Key,
    pub enc_key: Key,
}

fn key_from_b64(s: &str) -> Option<Key> {
    let bytes = Zeroizing::new(B64.decode(s).ok()?);
    let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
    Some(Zeroizing::new(arr))
}

struct Unlocked {
    key: Key,
    salt: Vec<u8>,
    params: KdfParams,
    data: VaultData,
}

pub struct Vault {
    file: PathBuf,
    params: KdfParams,
    state: Option<Unlocked>,
}

impl Vault {
    pub fn new(file: PathBuf, params: KdfParams) -> Self {
        Vault { file, params, state: None }
    }

    pub fn with_defaults(file: PathBuf) -> Self {
        Self::new(file, DEFAULT_KDF)
    }

    pub fn status(&self) -> Result<VaultStatus> {
        if self.state.is_some() {
            return Ok(VaultStatus::Unlocked);
        }
        self.file_status()
    }

    /// State of vault.enc on disk, ignoring whether it is unlocked in memory.
    pub fn file_status(&self) -> Result<VaultStatus> {
        let Some(text) = read_text(&self.file)? else { return Ok(VaultStatus::Missing) };
        let ok = serde_json::from_str(&text).ok().and_then(|v| parse_vault_file(&v)).is_some();
        Ok(if ok { VaultStatus::Locked } else { VaultStatus::Broken })
    }

    pub fn create(&mut self, password: &str) -> Result<()> {
        if self.status()? != VaultStatus::Missing {
            bail!("A vault already exists");
        }
        if password.is_empty() {
            bail!("Password must not be empty");
        }
        let salt = random_bytes::<16>().to_vec();
        let key = derive_key(password, &salt, self.params)?;
        let data = VaultData { version: 1, passwords: BTreeMap::new(), keys: BTreeMap::new(), sync: None };
        self.state = Some(Unlocked { key, salt, params: self.params, data });
        if let Err(e) = self.save() {
            self.state = None;
            return Err(e);
        }
        Ok(())
    }

    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let Some(text) = read_text(&self.file)? else { bail!("No vault exists yet") };
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| corrupt(&self.file, e))?;
        let file = parse_vault_file(&json).ok_or_else(|| corrupt(&self.file, "unexpected format"))?;
        let salt = B64.decode(&file.salt).map_err(|_| corrupt(&self.file, "unexpected format"))?;
        let key = derive_key(password, &salt, file.params())?;
        let plain = open(&file, &key)?;
        let data: VaultData = serde_json::from_str(&plain).map_err(|e| corrupt(&self.file, e))?;
        self.state = Some(Unlocked { key, salt, params: file.params(), data });
        Ok(())
    }

    /// Re-encrypts the vault under a new password with a fresh salt. Fails with `WrongPassword` if `current` is wrong.
    pub fn change_password(&mut self, current: &str, next: &str) -> Result<()> {
        let s = self.unlocked()?;
        let check = derive_key(current, &s.salt, s.params)?;
        if !bool::from(check.ct_eq(s.key.as_ref())) {
            return Err(Error::WrongPassword);
        }
        let salt = random_bytes::<16>().to_vec();
        let key = derive_key(next, &salt, self.params)?;
        let s = self.state.as_mut().ok_or(Error::VaultLocked)?;
        let old_key = std::mem::replace(&mut s.key, key);
        let old_salt = std::mem::replace(&mut s.salt, salt);
        let old_params = std::mem::replace(&mut s.params, self.params);
        if let Err(e) = self.save() {
            // The file still holds the old encryption, so keep using the old key.
            let s = self.state.as_mut().ok_or(Error::VaultLocked)?;
            s.key = old_key;
            s.salt = old_salt;
            s.params = old_params;
            return Err(e);
        }
        Ok(())
    }

    /// Forgets the key and every secret. Both are overwritten with zeros when dropped.
    pub fn lock(&mut self) {
        self.state = None;
    }

    pub fn is_unlocked(&self) -> bool {
        self.state.is_some()
    }

    pub fn get_password(&self, profile_id: &str) -> Result<Option<String>> {
        Ok(self.unlocked()?.data.passwords.get(profile_id).cloned())
    }

    pub fn set_password(&mut self, profile_id: &str, password: Option<&str>) -> Result<()> {
        let data = &mut self.unlocked_mut()?.data;
        match password {
            None => {
                if let Some(mut old) = data.passwords.remove(profile_id) {
                    old.zeroize();
                }
            }
            Some(p) => {
                data.passwords.insert(profile_id.into(), p.into());
            }
        }
        self.save()
    }

    pub fn get_key(&self, key_id: &str) -> Result<Option<KeySecret>> {
        Ok(self.unlocked()?.data.keys.get(key_id).cloned())
    }

    pub fn set_key(&mut self, key_id: &str, secret: Option<KeySecret>) -> Result<()> {
        let data = &mut self.unlocked_mut()?.data;
        match secret {
            None => {
                if let Some(mut old) = data.keys.remove(key_id) {
                    old.zeroize();
                }
            }
            Some(s) => {
                data.keys.insert(key_id.into(), s);
            }
        }
        self.save()
    }

    pub fn get_sync_keys(&self) -> Result<Option<SyncKeys>> {
        let Some(s) = &self.unlocked()?.data.sync else { return Ok(None) };
        Ok(match (key_from_b64(&s.auth_key), key_from_b64(&s.enc_key)) {
            (Some(auth_key), Some(enc_key)) => Some(SyncKeys { auth_key, enc_key }),
            _ => None,
        })
    }

    pub fn set_sync_keys(&mut self, keys: Option<&SyncKeys>) -> Result<()> {
        let data = &mut self.unlocked_mut()?.data;
        data.sync.zeroize();
        data.sync = keys.map(|k| SyncKeysJson { auth_key: B64.encode(k.auth_key.as_ref()), enc_key: B64.encode(k.enc_key.as_ref()) });
        self.save()
    }

    /// Every saved password and key secret, for sync.
    pub fn secrets(&self) -> Result<(BTreeMap<String, String>, BTreeMap<String, KeySecret>)> {
        let d = &self.unlocked()?.data;
        Ok((d.passwords.clone(), d.keys.clone()))
    }

    /// Replaces every saved password and key secret in one write. Used when applying data from sync.
    pub fn replace_secrets(&mut self, passwords: BTreeMap<String, String>, keys: BTreeMap<String, KeySecret>) -> Result<()> {
        let data = &mut self.unlocked_mut()?.data;
        let mut old_pw = std::mem::replace(&mut data.passwords, passwords);
        let mut old_keys = std::mem::replace(&mut data.keys, keys);
        old_pw.values_mut().for_each(Zeroize::zeroize);
        old_keys.values_mut().for_each(Zeroize::zeroize);
        self.save()
    }

    /// Backs up the current file and deletes it, so a new vault can be created.
    pub fn reset(&mut self) -> Result<Option<PathBuf>> {
        self.lock();
        let backup = backup_file(&self.file)?;
        match std::fs::remove_file(&self.file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        Ok(backup)
    }

    fn unlocked(&self) -> Result<&Unlocked> {
        self.state.as_ref().ok_or(Error::VaultLocked)
    }

    fn unlocked_mut(&mut self) -> Result<&mut Unlocked> {
        self.state.as_mut().ok_or(Error::VaultLocked)
    }

    fn save(&self) -> Result<()> {
        let s = self.unlocked()?;
        let plain = Zeroizing::new(serde_json::to_string(&s.data).map_err(|e| Error::msg(e.to_string()))?);
        let sealed = seal(&plain, &s.key, &s.salt, s.params);
        let text = serde_json::to_string_pretty(&sealed).map_err(|e| Error::msg(e.to_string()))?;
        write_file_atomic(&self.file, text.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams { n: 1024, r: 8, p: 1 };
    const PW: &str = "Correct horse 1!";

    fn vault(dir: &tempfile::TempDir) -> Vault {
        Vault::new(dir.path().join("vault.enc"), FAST)
    }

    #[test]
    fn create_lock_unlock_keeps_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = vault(&dir);
        assert_eq!(v.status().unwrap(), VaultStatus::Missing);
        v.create(PW).unwrap();
        v.set_password("p1", Some("secret")).unwrap();
        v.set_key("k1", Some(KeySecret { private_key: "PK".into(), passphrase: None })).unwrap();
        v.lock();
        assert_eq!(v.status().unwrap(), VaultStatus::Locked);
        assert!(matches!(v.get_password("p1"), Err(Error::VaultLocked)));
        assert!(matches!(v.unlock("wrong"), Err(Error::WrongPassword)));
        v.unlock(PW).unwrap();
        assert_eq!(v.get_password("p1").unwrap().as_deref(), Some("secret"));
        assert_eq!(v.get_key("k1").unwrap().unwrap().private_key, "PK");
        assert!(v.create(PW).is_err());
    }

    #[test]
    fn opens_a_vault_written_by_the_electron_version() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("vault.enc");
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vault-electron.enc"), &file).unwrap();
        let mut v = Vault::new(file, FAST);
        v.unlock(PW).unwrap();
        assert_eq!(v.get_password("p1").unwrap().as_deref(), Some("hunter2-ü"));
        assert_eq!(v.get_key("k1").unwrap(), Some(KeySecret { private_key: "PRIVATE".into(), passphrase: Some("pp".into()) }));
    }

    #[test]
    fn change_password_reencrypts() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = vault(&dir);
        v.create(PW).unwrap();
        v.set_password("p1", Some("secret")).unwrap();
        assert!(matches!(v.change_password("nope", "New password 2?"), Err(Error::WrongPassword)));
        v.change_password(PW, "New password 2?").unwrap();
        v.lock();
        assert!(v.unlock(PW).is_err());
        v.unlock("New password 2?").unwrap();
        assert_eq!(v.get_password("p1").unwrap().as_deref(), Some("secret"));
    }

    #[test]
    fn broken_file_is_reported_and_can_be_reset() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = vault(&dir);
        std::fs::write(dir.path().join("vault.enc"), "garbage").unwrap();
        assert_eq!(v.status().unwrap(), VaultStatus::Broken);
        assert!(matches!(v.unlock(PW), Err(Error::CorruptFile { .. })));
        let backup = v.reset().unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "garbage");
        assert_eq!(v.status().unwrap(), VaultStatus::Missing);
    }

    #[test]
    fn sync_keys_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = vault(&dir);
        v.create(PW).unwrap();
        assert!(v.get_sync_keys().unwrap().is_none());
        let keys = SyncKeys { auth_key: Zeroizing::new([1; 32]), enc_key: Zeroizing::new([2; 32]) };
        v.set_sync_keys(Some(&keys)).unwrap();
        v.lock();
        v.unlock(PW).unwrap();
        let k = v.get_sync_keys().unwrap().unwrap();
        assert_eq!((*k.auth_key, *k.enc_key), ([1; 32], [2; 32]));
    }
}
