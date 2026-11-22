//! Merging synced data. Works on plain JSON, like the TypeScript version, so fields from newer app versions on
//! other devices survive a round trip through this one until validation.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::types::Settings;

fn stamp(v: &Value) -> f64 {
    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0)
}

/// The newer version wins. On a tie the first argument (local) wins.
pub fn newer<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if stamp(b) > stamp(a) {
        b
    } else {
        a
    }
}

/// `String(item.id)` in JavaScript.
pub fn js_id(v: &Value) -> String {
    match v.get("id") {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Merges two lists by id, keeping the first-seen order. Tombstones are kept, so deletes reach every device.
pub fn merge_by_id(local: &[Value], remote: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for item in local.iter().chain(remote) {
        let id = js_id(item);
        match index.get(&id) {
            Some(&i) => out[i] = newer(&out[i], item).clone(),
            None => {
                index.insert(id, out.len());
                out.push(item.clone());
            }
        }
    }
    out
}

/// Same as merge_by_id for objects keyed by string, like known hosts.
pub fn merge_record(local: &Map<String, Value>, remote: &Map<String, Value>) -> Map<String, Value> {
    let mut out = local.clone();
    for (k, item) in remote {
        let merged = match out.get(k) {
            Some(cur) => newer(cur, item).clone(),
            None => item.clone(),
        };
        out.insert(k.clone(), merged);
    }
    out
}

fn list(v: &Value, k: &str) -> Vec<Value> {
    v.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn record(v: &Value, k: &str) -> Map<String, Value> {
    v.get(k).and_then(Value::as_object).cloned().unwrap_or_default()
}

/// Merging is idempotent, so merging the same data twice is harmless.
pub fn merge_state(local: &Value, remote: &Value) -> Value {
    let null = Value::Null;
    json!({
        "v": 1,
        "profiles": merge_by_id(&list(local, "profiles"), &list(remote, "profiles")),
        "keys": merge_by_id(&list(local, "keys"), &list(remote, "keys")),
        "snippets": merge_by_id(&list(local, "snippets"), &list(remote, "snippets")),
        "knownHosts": merge_record(&record(local, "knownHosts"), &record(remote, "knownHosts")),
        "settings": newer(local.get("settings").unwrap_or(&null), remote.get("settings").unwrap_or(&null)),
    })
}

/// What an empty server means: nothing, and settings that lose against any local settings.
pub fn empty_state(settings: &Settings) -> Value {
    let mut s = serde_json::to_value(settings).unwrap_or_default();
    s["updatedAt"] = json!(0);
    json!({ "v": 1, "profiles": [], "keys": [], "snippets": [], "knownHosts": {}, "settings": s })
}

pub fn is_sync_state(v: &Value) -> bool {
    v.get("v") == Some(&json!(1))
        && ["profiles", "keys", "snippets"].iter().all(|k| v.get(*k).is_some_and(Value::is_array))
        && v.get("knownHosts").is_some_and(|x| x.is_object() || x.is_array())
        && v.get("settings").is_some_and(|x| x.is_object() || x.is_array())
}

/// JSON with sorted object keys and lists sorted by id, so equal content gives equal text.
pub fn canonical(v: &Value) -> String {
    fn norm(v: &Value) -> Value {
        match v {
            Value::Array(a) => {
                let mut items: Vec<Value> = a.iter().map(norm).collect();
                items.sort_by_key(js_id);
                Value::Array(items)
            }
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
            other => other.clone(),
        }
    }
    // Serialized by hand, so the key order does not depend on serde_json's map type.
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String((*k).clone()).to_string());
                    out.push(':');
                    write(&m[*k], out);
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(x, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    write(&norm(v), &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newer_version_and_local_wins_a_tie() {
        let m = merge_by_id(&[json!({ "id": "a", "v": 1, "updatedAt": 1 })], &[json!({ "id": "a", "v": 2, "updatedAt": 2 })]);
        assert_eq!(m, vec![json!({ "id": "a", "v": 2, "updatedAt": 2 })]);
        let m = merge_by_id(&[json!({ "id": "a", "v": "L", "updatedAt": 5 })], &[json!({ "id": "a", "v": "R", "updatedAt": 5 })]);
        assert_eq!(m[0]["v"], "L");
    }

    #[test]
    fn newer_tombstone_beats_older_edit_and_both_sides_are_kept() {
        let m = merge_by_id(
            &[json!({ "id": "a", "updatedAt": 1 }), json!({ "id": "b", "updatedAt": 1 })],
            &[json!({ "id": "a", "updatedAt": 2, "deleted": true }), json!({ "id": "c", "updatedAt": 1 })],
        );
        assert_eq!(m[0]["deleted"], true);
        assert_eq!(m.iter().map(js_id).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    #[test]
    fn merges_records_by_key() {
        let local = json!({ "h:22": { "fp": "old", "updatedAt": 1 }, "x:22": { "fp": "x", "updatedAt": 1 } });
        let remote = json!({ "h:22": { "fp": "new", "updatedAt": 2 }, "y:22": { "fp": "y", "updatedAt": 1 } });
        let m = merge_record(local.as_object().unwrap(), remote.as_object().unwrap());
        assert_eq!(Value::Object(m), json!({ "h:22": remote["h:22"], "x:22": local["x:22"], "y:22": remote["y:22"] }));
    }

    #[test]
    fn is_idempotent() {
        let mut a = empty_state(&Settings::default());
        a["profiles"] = json!([{ "id": "a", "name": "A", "updatedAt": 1 }]);
        let mut b = empty_state(&Settings::default());
        b["profiles"] = json!([{ "id": "a", "name": "B", "updatedAt": 2 }]);
        let once = merge_state(&a, &b);
        assert_eq!(merge_state(&once, &b), once);
    }

    #[test]
    fn canonical_ignores_key_and_list_order() {
        let a = json!({ "b": 1, "a": [{ "id": "y", "z": 1, "x": 2 }, { "id": "x" }] });
        let b = json!({ "a": [{ "id": "x" }, { "x": 2, "id": "y", "z": 1 }], "b": 1 });
        assert_eq!(canonical(&a), canonical(&b));
        assert_eq!(canonical(&json!({ "b": "é", "a": 1 })), r#"{"a":1,"b":"é"}"#);
        assert_ne!(canonical(&a), canonical(&json!({ "b": 2, "a": [] })));
    }

    #[test]
    fn recognizes_sync_state() {
        assert!(is_sync_state(&empty_state(&Settings::default())));
        assert!(!is_sync_state(&json!({ "v": 2 })));
    }
}
