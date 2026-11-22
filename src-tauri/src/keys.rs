//! Generating and importing SSH keys. Reads OpenSSH, PEM (PKCS#1 and PKCS#8, also encrypted) and PuTTY keys.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData, RsaKeypair};
use russh::keys::ssh_key::LineEnding;
use russh::keys::{decode_secret_key, HashAlg, PrivateKey, PublicKey};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyType {
    Ed25519,
    Rsa,
}

pub struct KeyMaterial {
    /// The SSH name, like `ssh-ed25519`.
    pub key_type: String,
    /// One line for authorized_keys, with the key name as comment.
    pub public_key: String,
    pub fingerprint: String,
    pub private_key: Zeroizing<String>,
}

/// `SHA256:` and the unpadded base64 hash of the key, like `ssh-keygen -l`.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn parse_private(private_key: &str, passphrase: Option<&str>) -> Result<PrivateKey> {
    match decode_secret_key(private_key, passphrase.filter(|p| !p.is_empty())) {
        Ok(k) => Ok(k),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(Error::NeedsPassphrase),
        Err(e) => Err(Error::KeyParse(e.to_string())),
    }
}

fn public_line(key: &PublicKey, comment: &str) -> Result<String> {
    let blob = key.to_bytes().map_err(|e| Error::KeyParse(e.to_string()))?;
    let algo = key.algorithm();
    let mut line = format!("{} {}", algo.as_str(), B64.encode(blob));
    if !comment.is_empty() {
        line.push(' ');
        line.push_str(comment);
    }
    Ok(line)
}

/// Reads a private key. The stored text stays as the user gave it.
pub fn import_key(private_key: &str, passphrase: Option<&str>, comment: &str) -> Result<KeyMaterial> {
    let key = parse_private(private_key, passphrase)?;
    let public = key.public_key();
    Ok(KeyMaterial {
        key_type: public.algorithm().as_str().to_string(),
        public_key: public_line(public, comment)?,
        fingerprint: fingerprint(public),
        private_key: Zeroizing::new(private_key.to_string()),
    })
}

pub fn is_encrypted(private_key: &str) -> Result<bool> {
    match parse_private(private_key, None) {
        Ok(_) => Ok(false),
        Err(Error::NeedsPassphrase) => Ok(true),
        Err(e) => Err(e),
    }
}

/// A new unencrypted key in OpenSSH format. RSA keys have 4096 bits.
pub fn generate_key(key_type: KeyType, comment: &str) -> Result<KeyMaterial> {
    let fail = |e: russh::keys::ssh_key::Error| Error::msg(format!("Could not generate the key: {e}"));
    let data = match key_type {
        KeyType::Ed25519 => {
            let seed = Zeroizing::new(crate::vault::crypto::random_bytes::<32>());
            KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed))
        }
        KeyType::Rsa => KeypairData::Rsa(RsaKeypair::random(&mut rand::rng(), 4096).map_err(fail)?),
    };
    let key = PrivateKey::new(data, comment).map_err(fail)?;
    let text = key.to_openssh(LineEnding::LF).map_err(fail)?;
    import_key(&text, None, comment)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENCRYPTED: &str = include_str!("../tests/fixtures/ed25519-encrypted");
    const PKCS1: &str = include_str!("../tests/fixtures/rsa-pkcs1.pem");

    fn is_fingerprint(s: &str) -> bool {
        s.len() == 50 && s.starts_with("SHA256:")
    }

    #[test]
    fn generates_an_ed25519_key() {
        let k = generate_key(KeyType::Ed25519, "laptop").unwrap();
        assert_eq!(k.key_type, "ssh-ed25519");
        assert!(k.public_key.starts_with("ssh-ed25519 AAAA") && k.public_key.ends_with(" laptop"), "{}", k.public_key);
        assert!(is_fingerprint(&k.fingerprint), "{}", k.fingerprint);
        assert!(k.private_key.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert_eq!(import_key(&k.private_key, None, "").unwrap().fingerprint, k.fingerprint);
    }

    #[test]
    fn generates_an_rsa_key() {
        let k = generate_key(KeyType::Rsa, "old-box").unwrap();
        assert_eq!(k.key_type, "ssh-rsa");
        assert!(is_fingerprint(&k.fingerprint));
    }

    #[test]
    fn imports_a_pem_rsa_key() {
        let k = import_key(PKCS1, None, "").unwrap();
        assert_eq!(k.key_type, "ssh-rsa");
        assert_eq!(k.fingerprint, "SHA256:iWnvjohwTSWvn1k55jIR7NiVpAwttCbxxEjQDSywcfo");
    }

    #[test]
    fn encrypted_keys_need_the_passphrase() {
        assert!(is_encrypted(ENCRYPTED).unwrap());
        assert!(!is_encrypted(PKCS1).unwrap());
        assert!(matches!(import_key(ENCRYPTED, None, ""), Err(Error::NeedsPassphrase)));
        let k = import_key(ENCRYPTED, Some("secret"), "fixture").unwrap();
        assert_eq!(k.fingerprint, "SHA256:y8AIFw1HUdL3r0bWDpI614Nsz1ZH4ITBFLKUPZRVOFc");
        assert_eq!(k.public_key, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDrUO7em0ObV8syJwyNIbx+aM5aubjEoWW8g5x+EzLYs fixture");
        assert!(matches!(import_key(ENCRYPTED, Some("wrong"), ""), Err(Error::KeyParse(_))));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(import_key("not a key", None, ""), Err(Error::KeyParse(_))));
    }
}
