//! Checks everything that comes from the window, an import file or another device before it is stored.
//! Same rules and messages as the Electron version.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::error::{bail, Result};
use crate::types::{AuthType, KeyMeta, KnownHost, KnownHosts, Profile, Settings, Snippet, SnippetExportEntry, Theme};

static SAFE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());
static KNOWN_HOST_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\S+:\d{1,5}$").unwrap());

/// Names on `Object.prototype`. Other devices run JavaScript, where these would clash with built-in keys.
const PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// Ids are used as keys in the vault, so they must be plain.
pub fn is_safe_id(v: &str) -> bool {
    SAFE_ID.is_match(v) && !PROTOTYPE_KEYS.contains(&v)
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn str_of<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

fn non_empty<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    str_of(m, k).filter(|s| !s.trim().is_empty())
}

/// `Number.isInteger`: also accepts floats without a fraction, like JavaScript.
fn int_of(m: &Map<String, Value>, k: &str) -> Option<i64> {
    let n = m.get(k)?.as_number()?;
    n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0).map(|f| f as i64))
}

/// `updatedAt` if it is a finite number.
fn updated_at(m: &Map<String, Value>) -> Option<i64> {
    let n = m.get("updatedAt")?.as_number()?;
    n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
}

/// Length in UTF-16 units, like JavaScript's `.length`.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn string_list(m: &Map<String, Value>, k: &str) -> Vec<String> {
    match m.get(k) {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).filter(|s| !s.trim().is_empty()).map(String::from).collect(),
        _ => Vec::new(),
    }
}

pub fn validate_profile(v: &Value) -> Result<Profile> {
    let p = obj(v);
    let Some(id) = str_of(&p, "id").filter(|s| is_safe_id(s)) else { bail!("Invalid host id") };
    let Some(name) = non_empty(&p, "name") else { bail!("Label is required") };
    let Some(host) = non_empty(&p, "host") else { bail!("Host is required") };
    let Some(user) = non_empty(&p, "user") else { bail!("Username is required") };
    let port = match int_of(&p, "port") {
        Some(n @ 1..=65535) => n as u16,
        _ => bail!("Port must be between 1 and 65535"),
    };
    let auth_type = match str_of(&p, "authType") {
        Some("password") => AuthType::Password,
        Some("key") => AuthType::Key,
        _ => bail!("Invalid authentication type"),
    };
    let key_id = non_empty(&p, "keyId");
    if auth_type == AuthType::Key && key_id.is_none() {
        bail!("Choose a key");
    }
    let note = match p.get("note") {
        None => None,
        Some(Value::String(s)) if js_len(s) <= 5000 => Some(s.trim()).filter(|s| !s.is_empty()).map(String::from),
        Some(_) => bail!("Note must be at most 5000 characters"),
    };
    Ok(Profile {
        id: id.into(),
        name: name.trim().into(),
        group: str_of(&p, "group").map(|g| g.trim().to_string()).unwrap_or_default(),
        host: host.trim().into(),
        port,
        user: user.trim().into(),
        auth_type,
        key_id: if auth_type == AuthType::Key { key_id.map(String::from) } else { None },
        note,
        updated_at: updated_at(&p),
    })
}

pub fn validate_snippet(v: &Value) -> Result<Snippet> {
    let s = obj(v);
    let Some(id) = str_of(&s, "id").filter(|x| is_safe_id(x)) else { bail!("Invalid snippet id") };
    let Some(name) = non_empty(&s, "name") else { bail!("Name is required") };
    let Some(command) = non_empty(&s, "command") else { bail!("Command is required") };
    let tags: Vec<String> = string_list(&s, "tags").iter().map(|t| t.trim().to_string()).collect();
    let mut seen = HashSet::new();
    let profile_ids: Vec<String> = string_list(&s, "profileIds").into_iter().filter(|x| seen.insert(x.clone())).collect();
    Ok(Snippet {
        id: id.into(),
        name: name.trim().into(),
        command: command.into(),
        tags: Some(tags).filter(|t| !t.is_empty()),
        profile_ids: Some(profile_ids).filter(|p| !p.is_empty()),
        updated_at: updated_at(&s),
    })
}

const EXPORT_MAX_SNIPPETS: usize = 5000;
const EXPORT_MAX_NAME: usize = 200;
const EXPORT_MAX_COMMAND: usize = 20000;
const EXPORT_MAX_LIST: usize = 100;
const EXPORT_MAX_ITEM: usize = 200;

fn export_list(m: &Map<String, Value>, k: &str, what: &str, place: &str) -> Result<Option<Vec<String>>> {
    let Some(v) = m.get(k) else { return Ok(None) };
    let ok = v.as_array().filter(|a| {
        a.len() <= EXPORT_MAX_LIST && a.iter().all(|x| x.as_str().is_some_and(|s| js_len(s) <= EXPORT_MAX_ITEM))
    });
    let Some(a) = ok else { bail!("{place}: {what} must be a list of short texts") };
    let list: Vec<String> =
        a.iter().filter_map(Value::as_str).filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string()).collect();
    Ok(Some(list).filter(|l| !l.is_empty()))
}

/// Checks a snippet export file and returns its entries. Fails on anything unexpected, so nothing half-imports.
pub fn validate_snippet_export(v: &Value) -> Result<Vec<SnippetExportEntry>> {
    let Some(file) = v.as_object().filter(|f| f.get("format").and_then(Value::as_str) == Some("burrow-snippets")) else {
        bail!("This is not a Burrow snippets file")
    };
    if int_of(file, "version") != Some(1) {
        bail!("This snippets file comes from a newer or unknown version of Burrow");
    }
    let Some(snippets) = file.get("snippets").and_then(Value::as_array) else {
        bail!("The snippets file has no snippet list")
    };
    if snippets.len() > EXPORT_MAX_SNIPPETS {
        bail!("The file has more than {EXPORT_MAX_SNIPPETS} snippets");
    }
    snippets
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let place = format!("Snippet {}", i + 1);
            let e = obj(raw);
            let Some(name) = non_empty(&e, "name").filter(|n| js_len(n) <= EXPORT_MAX_NAME) else {
                bail!("{place}: name is missing or too long")
            };
            let Some(command) = non_empty(&e, "command").filter(|c| js_len(c) <= EXPORT_MAX_COMMAND) else {
                bail!("{place}: command is missing or too long")
            };
            Ok(SnippetExportEntry {
                name: name.trim().into(),
                command: command.into(),
                tags: export_list(&e, "tags", "tags", &place)?,
                hosts: export_list(&e, "hosts", "hosts", &place)?,
            })
        })
        .collect()
}

fn opt_bool(m: &Map<String, Value>, k: &str, default: bool, msg: &str) -> Result<bool> {
    match m.get(k) {
        None => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => bail!("{msg}"),
    }
}

pub fn validate_settings(v: &Value) -> Result<Settings> {
    let s = obj(v);
    let defaults = Settings::default();
    let Some(font_family) = non_empty(&s, "fontFamily") else { bail!("Font family is required") };
    let font_size = match int_of(&s, "fontSize") {
        Some(n @ 8..=32) => n as u32,
        _ => bail!("Font size must be 8 to 32"),
    };
    let theme = match str_of(&s, "theme") {
        Some("dark") => Theme::Dark,
        Some("light") => Theme::Light,
        _ => bail!("Invalid theme"),
    };
    let auto_lock_minutes = match int_of(&s, "autoLockMinutes") {
        Some(n @ 0..=1440) => n as u32,
        _ => bail!("Auto-lock must be 0 (off) to 1440 minutes"),
    };
    let Some(show_host_status) = s.get("showHostStatus").and_then(Value::as_bool) else {
        bail!("Invalid host status setting")
    };
    // Missing on settings synced from devices that predate these options; those keep the default.
    let block_screenshots = opt_bool(&s, "blockScreenshots", defaults.block_screenshots, "Invalid screenshot setting")?;
    let check_updates_on_startup =
        opt_bool(&s, "checkUpdatesOnStartup", defaults.check_updates_on_startup, "Invalid update check setting")?;
    Ok(Settings {
        font_family: font_family.trim().into(),
        font_size,
        theme,
        auto_lock_minutes,
        show_host_status,
        block_screenshots,
        check_updates_on_startup,
        updated_at: updated_at(&s),
    })
}

pub fn validate_key_meta(v: &Value) -> Result<KeyMeta> {
    let k = obj(v);
    let Some(id) = str_of(&k, "id").filter(|x| is_safe_id(x)) else { bail!("Invalid key id") };
    let field = |name: &str| str_of(&k, name).map(String::from);
    let (Some(name), Some(key_type), Some(public_key), Some(fingerprint), Some(created_at)) =
        (field("name"), field("type"), field("publicKey"), field("fingerprint"), field("createdAt"))
    else {
        bail!("Invalid key")
    };
    Ok(KeyMeta { id: id.into(), name, key_type, public_key, fingerprint, created_at, updated_at: updated_at(&k) })
}

pub fn validate_known_hosts(v: &Value) -> Result<KnownHosts> {
    let Some(map) = v.as_object() else { bail!("Invalid known hosts") };
    let mut out = KnownHosts::new();
    for (id, raw) in map {
        if !KNOWN_HOST_ID.is_match(id) || PROTOTYPE_KEYS.contains(&id.as_str()) {
            bail!("Invalid known host");
        }
        let e = obj(raw);
        let (Some(algo), Some(fingerprint), Some(added_at)) = (str_of(&e, "algo"), str_of(&e, "fingerprint"), str_of(&e, "addedAt"))
        else {
            bail!("Invalid known host")
        };
        out.insert(
            id.clone(),
            KnownHost {
                algo: algo.into(),
                fingerprint: fingerprint.into(),
                added_at: added_at.into(),
                updated_at: updated_at(&e),
                deleted: e.get("deleted") == Some(&Value::Bool(true)),
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host() -> Value {
        json!({ "id": "p1", "name": " Web ", "group": " prod ", "host": " example.com ", "port": 22, "user": " root ", "authType": "password" })
    }

    #[test]
    fn profile_is_trimmed_and_cleaned() {
        let mut v = host();
        v["keyId"] = json!("k1");
        v["note"] = json!("  ");
        v["extra"] = json!(1);
        let p = validate_profile(&v).unwrap();
        assert_eq!((p.name.as_str(), p.group.as_str(), p.host.as_str(), p.user.as_str()), ("Web", "prod", "example.com", "root"));
        assert_eq!(p.key_id, None);
        assert_eq!(p.note, None);
        assert_eq!(serde_json::to_value(&p).unwrap().get("extra"), None);
    }

    #[test]
    fn profile_errors() {
        let bad = |k: &str, val: Value| {
            let mut v = host();
            v[k] = val;
            validate_profile(&v).unwrap_err().to_string()
        };
        assert_eq!(bad("id", json!("constructor")), "Invalid host id");
        assert_eq!(bad("id", json!("a/b")), "Invalid host id");
        assert_eq!(bad("name", json!(" ")), "Label is required");
        assert_eq!(bad("port", json!(0)), "Port must be between 1 and 65535");
        assert_eq!(bad("port", json!(22.5)), "Port must be between 1 and 65535");
        assert_eq!(bad("authType", json!("agent")), "Invalid authentication type");
        assert_eq!(bad("authType", json!("key")), "Choose a key");
        assert_eq!(bad("note", json!("x".repeat(5001))), "Note must be at most 5000 characters");
    }

    #[test]
    fn profile_keeps_sync_fields() {
        let mut v = host();
        v["updatedAt"] = json!(1700000000000_i64);
        assert_eq!(validate_profile(&v).unwrap().updated_at, Some(1700000000000));
    }

    #[test]
    fn snippet_dedupes_hosts_and_drops_empty_tags() {
        let s = validate_snippet(&json!({ "id": "s1", "name": "ls", "command": "ls -la ", "tags": [" a ", "", 3], "profileIds": ["p1", "p1", "p2"] })).unwrap();
        assert_eq!(s.command, "ls -la ");
        assert_eq!(s.tags, Some(vec!["a".to_string()]));
        assert_eq!(s.profile_ids, Some(vec!["p1".to_string(), "p2".to_string()]));
        let s = validate_snippet(&json!({ "id": "s1", "name": "ls", "command": "ls" })).unwrap();
        assert_eq!((s.tags, s.profile_ids), (None, None));
    }

    #[test]
    fn snippet_export_checks() {
        let err = |v: Value| validate_snippet_export(&v).unwrap_err().to_string();
        assert_eq!(err(json!({ "format": "x" })), "This is not a Burrow snippets file");
        assert_eq!(err(json!({ "format": "burrow-snippets", "version": 2 })), "This snippets file comes from a newer or unknown version of Burrow");
        assert_eq!(err(json!({ "format": "burrow-snippets", "version": 1 })), "The snippets file has no snippet list");
        assert_eq!(
            err(json!({ "format": "burrow-snippets", "version": 1, "snippets": [{ "name": "a", "command": "b", "tags": "x" }] })),
            "Snippet 1: tags must be a list of short texts"
        );
        let ok = validate_snippet_export(&json!({ "format": "burrow-snippets", "version": 1, "snippets": [{ "name": " a ", "command": "b", "hosts": ["web", " "] }] })).unwrap();
        assert_eq!(ok, vec![SnippetExportEntry { name: "a".into(), command: "b".into(), tags: None, hosts: Some(vec!["web".into()]) }]);
    }

    #[test]
    fn settings_fill_in_new_fields() {
        let s = validate_settings(&json!({ "fontFamily": "Menlo", "fontSize": 13, "theme": "light", "autoLockMinutes": 0, "showHostStatus": true })).unwrap();
        assert!(s.block_screenshots);
        assert!(!s.check_updates_on_startup);
        assert_eq!(validate_settings(&json!({ "fontFamily": "M", "fontSize": 40, "theme": "dark", "autoLockMinutes": 0, "showHostStatus": true })).unwrap_err().to_string(), "Font size must be 8 to 32");
    }

    #[test]
    fn known_hosts_reject_odd_ids() {
        let e = json!({ "algo": "ssh-ed25519", "fingerprint": "SHA256:x", "addedAt": "t" });
        assert!(validate_known_hosts(&json!({ "a.com:22": e.clone() })).is_ok());
        assert!(validate_known_hosts(&json!({ "a.com": e.clone() })).is_err());
        assert!(validate_known_hosts(&json!([])).is_err());
    }
}
