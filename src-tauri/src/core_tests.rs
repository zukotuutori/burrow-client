//! Tests for Core, ported from tests/core.test.ts.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::core::{Ask, Core, Event};
use crate::ssh::test_server;
use crate::types::*;
use crate::vault::crypto::KdfParams;

pub const FAST: KdfParams = KdfParams { n: 1024, r: 8, p: 1 };
pub const MASTER: &str = "Correct-Horse-9";

pub struct Device {
    pub core: Arc<Core>,
    pub events: Arc<Mutex<Vec<Event>>>,
    _dir: tempfile::TempDir,
}

pub fn device() -> Device {
    let dir = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let e = events.clone();
    let core = Core::new(dir.path(), Arc::new(move |ev| e.lock().unwrap().push(ev)), FAST, FAST);
    core.init().unwrap();
    core.create_vault(MASTER).unwrap();
    Device { core, events, _dir: dir }
}

pub fn profile(id: &str) -> Value {
    json!({ "id": id, "name": format!("Host {id}"), "group": "", "host": "10.0.0.1", "port": 22, "user": "alice", "authType": "password" })
}

/// Answers prompts from a list, in order, and records them.
fn asker(answers: Vec<PromptAnswer>) -> (Ask, Arc<Mutex<Vec<Prompt>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let queue = Arc::new(Mutex::new(answers));
    let s = seen.clone();
    let ask: Ask = Arc::new(move |p| {
        s.lock().unwrap().push(p);
        let mut q = queue.lock().unwrap();
        let a = if q.is_empty() { PromptAnswer::cancel() } else { q.remove(0) };
        Box::pin(async move { a })
    });
    (ask, seen)
}

fn yes() -> PromptAnswer {
    PromptAnswer { ok: true, value: None, save: false }
}

fn value(v: &str, save: bool) -> PromptAnswer {
    PromptAnswer { ok: true, value: Some(v.into()), save }
}

fn host_profile(id: &str, port: u16) -> Value {
    let mut p = profile(id);
    p["host"] = json!("127.0.0.1");
    p["port"] = json!(port);
    p["user"] = json!("dev");
    p
}

#[test]
fn rejects_a_weak_master_password() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new(dir.path(), Arc::new(|_| {}), FAST, FAST);
    let e = core.create_vault("short").unwrap_err().to_string();
    assert!(e.starts_with("Master password needs: at least 12 characters"), "{e}");
    assert_eq!(core.vault_status().unwrap(), VaultStatus::Missing);
    core.create_vault(MASTER).unwrap();
    assert_eq!(core.vault_status().unwrap(), VaultStatus::Unlocked);
}

#[test]
fn change_master_password_checks_the_current_one_and_the_rules() {
    let d = device();
    d.core.save_profile(&profile("p1"), Some("pw")).unwrap();
    assert_eq!(d.core.change_master_password("wrong", "Another-Pass-1").unwrap_err().to_string(), "The current password is wrong");
    assert!(d.core.change_master_password(MASTER, "weak").is_err());
    d.core.change_master_password(MASTER, "Another-Pass-1").unwrap();
    d.core.lock();
    d.core.unlock("Another-Pass-1").unwrap();
    assert!(d.core.has_password("p1").unwrap());
}

#[test]
fn refuses_to_reset_a_healthy_vault() {
    let d = device();
    assert_eq!(d.core.reset_vault().unwrap_err().to_string(), "The vault can only be reset when it cannot be read");
}

#[test]
fn exports_snippets_with_host_labels_and_imports_them_elsewhere() {
    let a = device();
    a.core.save_profile(&profile("p1"), None).unwrap();
    a.core.save_snippet(&json!({ "id": "s1", "name": "ls", "command": "ls -la", "tags": ["fs"], "profileIds": ["p1"] })).unwrap();
    a.core.save_snippet(&json!({ "id": "s2", "name": "up", "command": "uptime" })).unwrap();
    let export = serde_json::to_value(a.core.export_snippets()).unwrap();
    assert_eq!(
        export,
        json!({ "format": "burrow-snippets", "version": 1, "snippets": [
            { "name": "ls", "command": "ls -la", "tags": ["fs"], "hosts": ["Host p1"] },
            { "name": "up", "command": "uptime" }
        ]})
    );

    let b = device();
    let mut p = profile("other");
    p["name"] = json!("host P1");
    b.core.save_profile(&p, None).unwrap();
    let r = b.core.import_snippets(&export).unwrap();
    assert_eq!((r.imported, r.skipped), (2, 0));
    let s = b.core.snippets();
    assert_eq!(s.iter().find(|s| s.name == "ls").unwrap().profile_ids, Some(vec!["other".to_string()]));
    let again = b.core.import_snippets(&export).unwrap();
    assert_eq!((again.imported, again.skipped), (0, 2));
    assert!(b.core.import_snippets(&json!({ "format": "nope" })).is_err());
}

#[test]
fn passwords_live_in_the_vault_not_in_profiles_json() {
    let d = device();
    d.core.save_profile(&profile("p1"), Some("hunter2")).unwrap();
    let dir = d._dir.path();
    let profiles = std::fs::read_to_string(dir.join("profiles.json")).unwrap();
    assert!(!profiles.contains("hunter2"));
    assert!(!std::fs::read_to_string(dir.join("vault.enc")).unwrap().contains("hunter2"));
    assert!(d.core.has_password("p1").unwrap());
    d.core.forget_password("p1").unwrap();
    assert!(!d.core.has_password("p1").unwrap());
    assert!(!d.core.has_password("constructor").unwrap());
}

#[test]
fn host_snippets_and_deleting_hosts() {
    let d = device();
    d.core.save_profile(&profile("p1"), None).unwrap();
    d.core.save_profile(&profile("p2"), None).unwrap();
    assert_eq!(d.core.save_snippet(&json!({ "id": "s0", "name": "a", "command": "b", "profileIds": ["nope"] })).unwrap_err().to_string(), "Host not found");
    d.core.save_snippet(&json!({ "id": "s1", "name": "a", "command": "b", "profileIds": ["p1"] })).unwrap();
    d.core.save_snippet(&json!({ "id": "s2", "name": "c", "command": "d", "profileIds": ["p1", "p2"] })).unwrap();
    d.core.delete_profile("p1").unwrap();
    let s = d.core.snippets();
    assert_eq!(s.iter().find(|s| s.id == "s1").unwrap().profile_ids, None);
    assert_eq!(s.iter().find(|s| s.id == "s2").unwrap().profile_ids, Some(vec!["p2".to_string()]));
    assert_eq!(d.core.profiles().len(), 1);
}

#[test]
fn refuses_to_delete_a_key_in_use() {
    let d = device();
    let k = d.core.generate_key("laptop", crate::keys::KeyType::Ed25519).unwrap();
    let mut p = profile("p1");
    p["authType"] = json!("key");
    p["keyId"] = json!(k.id);
    d.core.save_profile(&p, None).unwrap();
    assert_eq!(d.core.delete_key(&k.id).unwrap_err().to_string(), "Key is used by: Host p1");
    d.core.delete_profile("p1").unwrap();
    d.core.delete_key(&k.id).unwrap();
    assert!(d.core.keys().is_empty());
}

#[test]
fn corrupt_file_is_reported_blocks_writes_and_resets_with_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("snippets.json"), "{nope").unwrap();
    let core = Core::new(dir.path(), Arc::new(|_| {}), FAST, FAST);
    core.init().unwrap();
    core.create_vault(MASTER).unwrap();
    let errors = core.load_errors();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].file, "snippets.json");
    assert!(core.save_snippet(&json!({ "id": "s1", "name": "a", "command": "b" })).unwrap_err().to_string().contains("Reset it first"));
    assert!(core.reset_file("profiles.json").unwrap_err().to_string().contains("can be read"));
    core.reset_file("snippets.json").unwrap();
    assert!(core.load_errors().is_empty());
    core.save_snippet(&json!({ "id": "s1", "name": "a", "command": "b" })).unwrap();
    let backups = std::fs::read_dir(dir.path()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".broken-")).count();
    assert_eq!(backups, 1);
}

#[test]
fn settings_written_before_new_fields_existed_get_defaults() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), r#"{"fontFamily":"Menlo","fontSize":14,"theme":"light","autoLockMinutes":5,"showHostStatus":true}"#).unwrap();
    let core = Core::new(dir.path(), Arc::new(|_| {}), FAST, FAST);
    core.init().unwrap();
    let s = core.settings();
    assert_eq!((s.font_size, s.block_screenshots, s.check_updates_on_startup), (14, true, false));
}

#[tokio::test]
async fn reports_whether_a_saved_host_accepts_connections() {
    let d = device();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    d.core.save_profile(&host_profile("p1", l.local_addr().unwrap().port()), None).unwrap();
    assert!(d.core.is_reachable("p1").await.unwrap());
    assert_eq!(d.core.is_reachable("nope").await.unwrap_err().to_string(), "Host not found");
}

#[tokio::test]
async fn trusts_a_new_host_once_then_connects_silently() {
    let server = test_server::start("dev", None).await;
    let d = device();
    d.core.save_profile(&host_profile("p1", server.port), Some("dev")).unwrap();
    let (ask, seen) = asker(vec![yes()]);
    d.core.connect("s1", "p1", 80, 24, ask.clone()).await.unwrap();
    assert!(matches!(&seen.lock().unwrap()[0], Prompt::Hostkey { check: HostKeyCheck::Unknown { .. }, .. }));
    assert!(d.core.known_hosts().contains_key(&format!("127.0.0.1:{}", server.port)));
    assert_eq!(d.core.connect("s1", "p1", 80, 24, ask.clone()).await.unwrap_err().to_string(), "Session id already in use");
    d.core.connect("s2", "p1", 80, 24, ask).await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    d.core.lock();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let closed = d.events.lock().unwrap().iter().filter(|e| matches!(e, Event::SessionClosed { .. })).count();
    assert_eq!(closed, 2);
}

#[tokio::test]
async fn a_changed_host_key_warns_and_declining_aborts() {
    let server = test_server::start("dev", None).await;
    let d = device();
    d.core.save_profile(&host_profile("p1", server.port), Some("dev")).unwrap();
    let id = format!("127.0.0.1:{}", server.port);
    let mut known = KnownHosts::new();
    known.insert(id.clone(), KnownHost { algo: "ssh-ed25519".into(), fingerprint: "SHA256:old".into(), added_at: now_iso(), updated_at: None, deleted: false });
    d.core.docs().known_hosts.set(known).unwrap();
    let (ask, seen) = asker(vec![PromptAnswer::cancel()]);
    assert_eq!(d.core.connect("s1", "p1", 80, 24, ask).await.unwrap_err().to_string(), "Host key rejected");
    assert!(matches!(&seen.lock().unwrap()[0], Prompt::Hostkey { check: HostKeyCheck::Changed { .. }, .. }));
    assert_eq!(d.core.known_hosts()[&id].fingerprint, "SHA256:old");
}

#[tokio::test]
async fn prompts_for_a_missing_password_and_saves_it_only_when_asked() {
    let server = test_server::start("dev", None).await;
    let d = device();
    d.core.save_profile(&host_profile("p1", server.port), None).unwrap();
    let (ask, _) = asker(vec![value("dev", false), yes()]);
    d.core.connect("s1", "p1", 80, 24, ask).await.unwrap();
    assert!(!d.core.has_password("p1").unwrap());
    let (ask, seen) = asker(vec![value("dev", true)]);
    d.core.connect("s2", "p1", 80, 24, ask).await.unwrap();
    assert!(matches!(&seen.lock().unwrap()[0], Prompt::Password { label } if label == "dev@127.0.0.1"));
    assert!(d.core.has_password("p1").unwrap());
    let (ask, _) = asker(vec![PromptAnswer::cancel()]);
    d.core.forget_password("p1").unwrap();
    assert_eq!(d.core.connect("s3", "p1", 80, 24, ask).await.unwrap_err().to_string(), "Cancelled");
}

#[tokio::test]
async fn connects_with_a_stored_encrypted_key_and_saves_the_passphrase() {
    let d = device();
    let key_text = include_str!("../tests/fixtures/ed25519-encrypted");
    let k = d.core.import_key("fixture", key_text, None).err();
    assert!(k.is_some(), "an encrypted key without passphrase must not import");
    let meta = {
        // Import with the passphrase, then forget it, so connecting has to ask.
        let m = d.core.import_key("fixture", key_text, Some("secret")).unwrap();
        let secret = d.core.vault().get_key(&m.id).unwrap().unwrap();
        d.core.vault().set_key(&m.id, Some(crate::vault::KeySecret { passphrase: None, ..secret })).unwrap();
        m
    };
    let public = crate::keys::parse_private(key_text, Some("secret")).unwrap().public_key().clone();
    let server = test_server::start("unused", Some(public)).await;
    let mut p = host_profile("p1", server.port);
    p["authType"] = json!("key");
    p["keyId"] = json!(meta.id);
    d.core.save_profile(&p, None).unwrap();
    let (ask, _) = asker(vec![value("wrong", false)]);
    assert!(d.core.connect("s1", "p1", 80, 24, ask).await.unwrap_err().to_string().starts_with("Could not read key"));
    let (ask, seen) = asker(vec![value("secret", true), yes()]);
    d.core.connect("s2", "p1", 80, 24, ask).await.unwrap();
    assert!(matches!(&seen.lock().unwrap()[0], Prompt::Passphrase { label } if label == "fixture"));
    assert_eq!(d.core.vault().get_key(&meta.id).unwrap().unwrap().passphrase.as_deref(), Some("secret"));
}

#[tokio::test]
async fn local_shell_sessions_close_on_lock() {
    let d = device();
    d.core.open_local("l1", 80, 24).unwrap();
    assert_eq!(d.core.open_local("l1", 80, 24).unwrap_err().to_string(), "Session id already in use");
    d.core.lock();
    let closed = d.events.lock().unwrap().iter().any(|e| matches!(e, Event::SessionClosed { id, reason } if id == "l1" && reason == "Shell closed"));
    assert!(closed);
}
