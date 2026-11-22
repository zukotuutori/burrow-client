//! Two devices against the real sync server (server/server.js, needs Node.js). Ported from tests/sync.test.ts.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use serde_json::json;

use super::service::check_server_url;
use crate::core_tests::{device, profile};
use crate::types::{KnownHost, KnownHosts};

const PASSWORD: &str = "Correct-Horse-9";
const CODE: &str = "invite-123";

struct Server {
    url: String,
    child: Child,
    _dir: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn server() -> Server {
    let dir = tempfile::tempdir().unwrap();
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../server/server.js");
    let mut child = Command::new("node")
        .args(["--no-warnings", script])
        .env("PORT", "0")
        .env("DB_PATH", dir.path().join("sync.db"))
        .env("REGISTRATION_CODE", CODE)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node must be installed to run the sync tests");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let port = loop {
        let line = lines.next().expect("the server exited").unwrap();
        if let Some(p) = line.split("listening on port ").nth(1) {
            break p.trim().parse::<u16>().unwrap();
        }
    };
    Server { url: format!("http://127.0.0.1:{port}"), child, _dir: dir }
}

fn user() -> String {
    format!("user{}", uuid::Uuid::new_v4().simple().to_string().get(..8).unwrap())
}

fn ids(core: &crate::core::Core) -> Vec<String> {
    let mut v: Vec<String> = core.profiles().into_iter().map(|p| p.id).collect();
    v.sort();
    v
}

#[tokio::test]
async fn moves_everything_to_the_other_device() {
    let s = server();
    let (a, b, user) = (device(), device(), user());
    a.core.save_profile(&profile("p1"), Some("secret-pw")).unwrap();
    let key = a.core.generate_key("laptop", crate::keys::KeyType::Ed25519).unwrap();
    let mut p2 = profile("p2");
    p2["authType"] = json!("key");
    p2["keyId"] = json!(key.id);
    a.core.save_profile(&p2, None).unwrap();
    a.core.save_snippet(&json!({ "id": "s1", "name": "uptime", "command": "uptime" })).unwrap();
    let kh = KnownHost { algo: "ssh-ed25519".into(), fingerprint: "SHA256:x".into(), added_at: "now".into(), updated_at: Some(1), deleted: false };
    a.core.docs().known_hosts.set(KnownHosts::from([("10.0.0.1:22".to_string(), kh)])).unwrap();
    let mut settings = serde_json::to_value(a.core.settings()).unwrap();
    settings["fontSize"] = json!(17);
    a.core.save_settings(&settings).unwrap();

    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    b.core.sync.login(&b.core, &s.url, &user, PASSWORD).await.unwrap();

    assert_eq!(ids(&b.core), vec!["p1", "p2"]);
    assert_eq!(b.core.vault().get_password("p1").unwrap().as_deref(), Some("secret-pw"));
    assert_eq!(b.core.vault().get_key(&key.id).unwrap(), a.core.vault().get_key(&key.id).unwrap());
    assert_eq!(b.core.snippets().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["uptime"]);
    assert_eq!(b.core.known_hosts()["10.0.0.1:22"].fingerprint, "SHA256:x");
    assert_eq!(b.core.settings().font_size, 17);
}

#[tokio::test]
async fn merges_both_sides_and_carries_deletes_over() {
    let s = server();
    let (a, b, user) = (device(), device(), user());
    a.core.save_profile(&profile("a1"), None).unwrap();
    b.core.save_profile(&profile("b1"), None).unwrap();
    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    b.core.sync.login(&b.core, &s.url, &user, PASSWORD).await.unwrap();
    a.core.sync.sync_now(&a.core).await.unwrap();
    assert_eq!(ids(&a.core), vec!["a1", "b1"]);

    b.core.delete_profile("a1").unwrap();
    b.core.sync.sync_now(&b.core).await.unwrap();
    a.core.sync.sync_now(&a.core).await.unwrap();
    assert_eq!(ids(&a.core), vec!["b1"]);
}

#[tokio::test]
async fn loses_nothing_when_both_upload_at_once() {
    let s = server();
    let (a, b, user) = (device(), device(), user());
    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    b.core.sync.login(&b.core, &s.url, &user, PASSWORD).await.unwrap();
    a.core.save_profile(&profile("fromA"), None).unwrap();
    b.core.save_profile(&profile("fromB"), None).unwrap();
    let (r1, r2) = tokio::join!(a.core.sync.sync_now(&a.core), b.core.sync.sync_now(&b.core));
    r1.unwrap();
    r2.unwrap();
    let (r1, r2) = tokio::join!(a.core.sync.sync_now(&a.core), b.core.sync.sync_now(&b.core));
    r1.unwrap();
    r2.unwrap();
    assert_eq!(ids(&a.core), vec!["fromA", "fromB"]);
    assert_eq!(ids(&b.core), vec!["fromA", "fromB"]);
}

#[tokio::test]
async fn does_not_upload_when_nothing_changed() {
    let s = server();
    let (a, user) = (device(), user());
    a.core.save_profile(&profile("p1"), None).unwrap();
    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    let version = a.core.docs().sync_config.value().version;
    a.core.sync.sync_now(&a.core).await.unwrap();
    assert_eq!(a.core.docs().sync_config.value().version, version);
}

#[tokio::test]
async fn rejects_wrong_password_wrong_code_and_plain_http() {
    let s = server();
    let (a, b, user) = (device(), device(), user());
    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    let e = b.core.sync.login(&b.core, &s.url, &user, "Wrong-Horse-99").await.unwrap_err().to_string();
    assert_eq!(e, "Wrong user name or password");
    let e = b.core.sync.register(&b.core, &s.url, "someone", PASSWORD, "nope").await.unwrap_err().to_string();
    assert!(e.contains("Wrong invite code"), "{e}");
    let e = b.core.sync.login(&b.core, "http://sync.example.com", &user, PASSWORD).await.unwrap_err().to_string();
    assert!(e.contains("https"), "{e}");
    assert!(!b.core.sync.status(&b.core).logged_in);
}

#[tokio::test]
async fn password_change_logs_out_the_other_device() {
    let s = server();
    let (a, b, user) = (device(), device(), user());
    a.core.save_profile(&profile("p1"), Some("pw1")).unwrap();
    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    b.core.sync.login(&b.core, &s.url, &user, PASSWORD).await.unwrap();
    a.core.sync.change_password(&a.core, PASSWORD, "New-Horse-Battery-7").await.unwrap();

    assert!(b.core.sync.sync_now(&b.core).await.is_err());
    let st = b.core.sync.status(&b.core);
    assert!(!st.logged_in);
    assert!(st.last_error.unwrap().contains("Log in again"));

    b.core.sync.login(&b.core, &s.url, &user, "New-Horse-Battery-7").await.unwrap();
    assert_eq!(b.core.vault().get_password("p1").unwrap().as_deref(), Some("pw1"));
}

#[tokio::test]
async fn deleting_the_account_keeps_local_data() {
    let s = server();
    let (a, b, user) = (device(), device(), user());
    a.core.save_profile(&profile("p1"), None).unwrap();
    a.core.sync.register(&a.core, &s.url, &user, PASSWORD, CODE).await.unwrap();
    a.core.sync.delete_account(&a.core, PASSWORD).await.unwrap();
    assert!(!a.core.sync.status(&a.core).logged_in);
    assert_eq!(a.core.profiles().len(), 1);
    let e = b.core.sync.login(&b.core, &s.url, &user, PASSWORD).await.unwrap_err().to_string();
    assert_eq!(e, "Wrong user name or password");
}

#[test]
fn server_urls() {
    assert_eq!(check_server_url(" https://sync.example.com/path ").unwrap(), "https://sync.example.com");
    assert_eq!(check_server_url("http://localhost:3000").unwrap(), "http://localhost:3000");
    assert!(check_server_url("http://example.com").is_err());
    assert!(check_server_url("https://u:p@example.com").is_err());
    assert!(check_server_url("nope").is_err());
}
