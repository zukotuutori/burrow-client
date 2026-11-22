use crate::types::{HostKeyCheck, KnownHosts};

pub fn host_id(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// Compares a server's key with the one trusted for `host:port`. Deleted entries count as unknown.
pub fn check_host_key(known: &KnownHosts, host: &str, port: u16, algo: &str, fingerprint: &str) -> HostKeyCheck {
    match known.get(&host_id(host, port)).filter(|e| !e.deleted) {
        None => HostKeyCheck::Unknown { algo: algo.into(), fingerprint: fingerprint.into() },
        Some(e) if e.fingerprint == fingerprint => HostKeyCheck::Match,
        Some(e) => HostKeyCheck::Changed {
            algo: algo.into(),
            fingerprint: fingerprint.into(),
            old_fingerprint: e.fingerprint.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::KnownHost;

    fn known(deleted: bool) -> KnownHosts {
        let e = KnownHost { algo: "ssh-ed25519".into(), fingerprint: "SHA256:a".into(), added_at: "t".into(), updated_at: None, deleted };
        KnownHosts::from([("h:22".to_string(), e)])
    }

    #[test]
    fn match_unknown_and_changed() {
        assert_eq!(check_host_key(&known(false), "h", 22, "ssh-ed25519", "SHA256:a"), HostKeyCheck::Match);
        assert!(matches!(check_host_key(&known(false), "h", 2222, "x", "SHA256:a"), HostKeyCheck::Unknown { .. }));
        assert!(matches!(check_host_key(&known(true), "h", 22, "x", "SHA256:a"), HostKeyCheck::Unknown { .. }));
        assert_eq!(
            check_host_key(&known(false), "h", 22, "ssh-rsa", "SHA256:b"),
            HostKeyCheck::Changed { algo: "ssh-rsa".into(), fingerprint: "SHA256:b".into(), old_fingerprint: "SHA256:a".into() }
        );
    }

    #[test]
    fn serializes_like_the_typescript_union() {
        let v = serde_json::to_value(HostKeyCheck::Changed { algo: "a".into(), fingerprint: "f".into(), old_fingerprint: "o".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "state": "changed", "algo": "a", "fingerprint": "f", "oldFingerprint": "o" }));
    }
}
