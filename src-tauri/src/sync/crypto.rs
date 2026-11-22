//! Keys and encryption for sync. Must stay identical to the Electron version, or devices stop understanding each
//! other.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::vault::crypto::{derive_key, gcm_decrypt, gcm_encrypt, KdfParams};
use crate::vault::SyncKeys;

/// Never change these: every device must derive the same keys from the same username and password.
pub const SYNC_KDF: KdfParams = KdfParams { n: 131072, r: 8, p: 1 };

pub fn normalize_username(username: &str) -> String {
    username.trim().to_lowercase()
}

/// 3 to 32 characters from a-z, 0-9, dot, underscore and dash.
pub fn is_valid_username(username: &str) -> bool {
    (3..=32).contains(&username.len())
        && username.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-')
}

/// The salt comes from the username, so a new device can compute it before it logs in.
fn salt_for(username: &str) -> [u8; 32] {
    Sha256::digest(format!("burrow-sync-v1:{}", normalize_username(username))).into()
}

/// Turns the account password into two independent keys. The auth key is sent to the server to log in. The
/// encryption key encrypts the data and never leaves the device, so the server cannot read anything.
pub fn derive_sync_keys(username: &str, password: &str, kdf: KdfParams) -> Result<SyncKeys> {
    let master = derive_key(password, &salt_for(username), kdf)?;
    let hk = Hkdf::<Sha256>::new(None, master.as_ref());
    let mut auth_key = Zeroizing::new([0u8; 32]);
    let mut enc_key = Zeroizing::new([0u8; 32]);
    hk.expand(b"burrow-auth", auth_key.as_mut()).expect("32 bytes is a valid HKDF length");
    hk.expand(b"burrow-enc", enc_key.as_mut()).expect("32 bytes is a valid HKDF length");
    Ok(SyncKeys { auth_key, enc_key })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SealedBlob {
    pub v: u32,
    pub iv: String,
    pub tag: String,
    pub data: String,
}

pub fn encrypt_blob(plain: &Value, key: &[u8; 32]) -> SealedBlob {
    let text = Zeroizing::new(plain.to_string());
    let (iv, data, tag) = gcm_encrypt(text.as_bytes(), key);
    SealedBlob { v: 1, iv: B64.encode(iv), tag: B64.encode(tag), data: B64.encode(data) }
}

/// Fails when the key is wrong or the blob was changed.
pub fn decrypt_blob(blob: &SealedBlob, key: &[u8; 32]) -> Result<Value> {
    let fail = || Error::msg("The synced data could not be decrypted");
    let dec = |s: &str| B64.decode(s).map_err(|_| fail());
    let plain = Zeroizing::new(gcm_decrypt(&dec(&blob.iv)?, &dec(&blob.data)?, &dec(&blob.tag)?, key).ok_or_else(fail)?);
    serde_json::from_slice(&plain).map_err(|_| fail())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../tests/fixtures/sync-electron.json");

    #[test]
    fn derives_the_same_keys_and_reads_blobs_from_the_electron_version() {
        let f: Value = serde_json::from_str(FIXTURE).unwrap();
        let kdf = KdfParams { n: 1024, r: 8, p: 1 };
        let keys = derive_sync_keys(f["username"].as_str().unwrap(), f["password"].as_str().unwrap(), kdf).unwrap();
        assert_eq!(B64.encode(keys.auth_key.as_ref()), f["authKey"].as_str().unwrap());
        assert_eq!(B64.encode(keys.enc_key.as_ref()), f["encKey"].as_str().unwrap());
        let blob: SealedBlob = serde_json::from_value(f["blob"].clone()).unwrap();
        assert_eq!(decrypt_blob(&blob, &keys.enc_key).unwrap(), json!({ "hello": "wörld", "n": 1 }));
    }

    #[test]
    fn rejects_a_wrong_key_or_changed_data() {
        let key = [7u8; 32];
        let mut blob = encrypt_blob(&json!({ "a": 1 }), &key);
        assert_eq!(decrypt_blob(&blob, &key).unwrap(), json!({ "a": 1 }));
        assert!(decrypt_blob(&blob, &[8u8; 32]).is_err());
        blob.data = B64.encode(b"x");
        assert_eq!(decrypt_blob(&blob, &key).unwrap_err().to_string(), "The synced data could not be decrypted");
    }

    #[test]
    fn usernames() {
        assert_eq!(normalize_username("  Alice "), "alice");
        assert!(is_valid_username("a.b_c-1"));
        assert!(!is_valid_username("ab"));
        assert!(!is_valid_username("Alice"));
    }
}
