//! vault.enc: JSON encrypted with AES-256-GCM under a key from scrypt. Same format as the Electron version.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub n: u64,
    pub r: u32,
    pub p: u32,
}

pub const DEFAULT_KDF: KdfParams = KdfParams { n: 131072, r: 8, p: 1 };

/// Upper limits for settings read from a vault file, so a tampered file cannot make unlocking use gigabytes of
/// memory or run for minutes. scrypt needs about 128 * N * r bytes; the defaults use 128 MiB.
const MAX_SCRYPT_MEMORY: u64 = 1024 * 1024 * 1024;
const MAX_SCRYPT_P: u32 = 4;

pub type Key = Zeroizing<[u8; 32]>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VaultFile {
    pub version: u32,
    pub kdf: String,
    #[serde(rename = "N")]
    pub n: u64,
    pub r: u32,
    pub p: u32,
    pub salt: String,
    pub iv: String,
    pub tag: String,
    pub ciphertext: String,
}

impl VaultFile {
    pub fn params(&self) -> KdfParams {
        KdfParams { n: self.n, r: self.r, p: self.p }
    }
}

/// scrypt with a 32-byte output, like Node's `crypto.scrypt`. N must be a power of two.
pub fn derive_key(password: &str, salt: &[u8], params: KdfParams) -> Result<Key> {
    if !params.n.is_power_of_two() || params.n < 2 {
        return Err(Error::msg("Invalid scrypt settings"));
    }
    let log_n = params.n.trailing_zeros() as u8;
    let p = scrypt::Params::new(log_n, params.r, params.p, 32).map_err(|e| Error::msg(e.to_string()))?;
    let mut key = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(password.as_bytes(), salt, &p, key.as_mut()).map_err(|e| Error::msg(e.to_string()))?;
    Ok(key)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

/// AES-256-GCM with a fresh 12-byte IV. Returns (iv, ciphertext, tag) like Node's createCipheriv.
pub fn gcm_encrypt(plaintext: &[u8], key: &[u8; 32]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let iv: [u8; 12] = random_bytes();
    let cipher = Aes256Gcm::new(key.into());
    let mut out = cipher.encrypt(Nonce::from_slice(&iv), plaintext).expect("AES-GCM encryption cannot fail");
    let tag = out.split_off(out.len() - 16);
    (iv.to_vec(), out, tag)
}

/// Fails when the key is wrong or anything was changed.
pub fn gcm_decrypt(iv: &[u8], ciphertext: &[u8], tag: &[u8], key: &[u8; 32]) -> Option<Vec<u8>> {
    if iv.len() != 12 || tag.len() != 16 {
        return None;
    }
    let mut msg = ciphertext.to_vec();
    msg.extend_from_slice(tag);
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(iv), Payload { msg: &msg, aad: &[] }).ok()
}

pub fn seal(plaintext: &str, key: &[u8; 32], salt: &[u8], params: KdfParams) -> VaultFile {
    let (iv, ciphertext, tag) = gcm_encrypt(plaintext.as_bytes(), key);
    VaultFile {
        version: 1,
        kdf: "scrypt".into(),
        n: params.n,
        r: params.r,
        p: params.p,
        salt: B64.encode(salt),
        iv: B64.encode(iv),
        tag: B64.encode(tag),
        ciphertext: B64.encode(ciphertext),
    }
}

/// Fails with `WrongPassword` when the key is wrong or the file was modified (GCM cannot tell these apart).
pub fn open(file: &VaultFile, key: &[u8; 32]) -> Result<Zeroizing<String>> {
    let dec = |s: &str| B64.decode(s).map_err(|_| Error::WrongPassword);
    let plain = gcm_decrypt(&dec(&file.iv)?, &dec(&file.ciphertext)?, &dec(&file.tag)?, key).ok_or(Error::WrongPassword)?;
    String::from_utf8(plain).map(Zeroizing::new).map_err(|_| Error::WrongPassword)
}

/// The parsed file if it looks like a vault and its scrypt settings are within limits.
pub fn parse_vault_file(v: &Value) -> Option<VaultFile> {
    let f: VaultFile = serde_json::from_value(v.clone()).ok()?;
    let ok = f.version == 1
        && f.kdf == "scrypt"
        && f.n > 0
        && f.r > 0
        && f.p > 0
        && 128u64.saturating_mul(f.n).saturating_mul(f.r as u64) <= MAX_SCRYPT_MEMORY
        && f.p <= MAX_SCRYPT_P;
    ok.then_some(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams { n: 1024, r: 8, p: 1 };

    #[test]
    fn round_trips_and_detects_a_wrong_key() {
        let salt = random_bytes::<16>();
        let key = derive_key("pw", &salt, FAST).unwrap();
        let file = seal("{\"a\":1}", &key, &salt, FAST);
        assert_eq!(open(&file, &key).unwrap().as_str(), "{\"a\":1}");
        let other = derive_key("other", &salt, FAST).unwrap();
        assert!(matches!(open(&file, &other), Err(Error::WrongPassword)));
    }

    #[test]
    fn detects_a_changed_ciphertext() {
        let salt = random_bytes::<16>();
        let key = derive_key("pw", &salt, FAST).unwrap();
        let mut file = seal("hello world", &key, &salt, FAST);
        let mut c = B64.decode(&file.ciphertext).unwrap();
        c[0] ^= 1;
        file.ciphertext = B64.encode(c);
        assert!(matches!(open(&file, &key), Err(Error::WrongPassword)));
    }

    #[test]
    fn matches_node_scrypt() {
        // crypto.scryptSync('password', 'salt', 32, { N: 1024, r: 8, p: 1 }).toString('hex')
        let key = derive_key("password", b"salt", FAST).unwrap();
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "16dbc8906763c7f048977a68f9d305f7710e068ca2cd95dab372125bb3f19608");
    }

    #[test]
    fn rejects_files_that_would_use_too_much_memory() {
        let salt = random_bytes::<16>();
        let key = derive_key("pw", &salt, FAST).unwrap();
        let mut v = serde_json::to_value(seal("x", &key, &salt, FAST)).unwrap();
        assert!(parse_vault_file(&v).is_some());
        v["N"] = serde_json::json!(1u64 << 21);
        v["r"] = serde_json::json!(8);
        assert!(parse_vault_file(&v).is_none());
        v["N"] = serde_json::json!(1024);
        v["p"] = serde_json::json!(5);
        assert!(parse_vault_file(&v).is_none());
    }
}
