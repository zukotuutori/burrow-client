//! The data the app stores and sends to the window. Field names match src/shared/types.ts and the JSON files
//! the Electron version wrote, so existing data and other synced devices keep working.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

/// `updatedAt` is `Date.now()` from JavaScript. Older files or other devices may hold any JSON number.
pub fn de_timestamp<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    let v = Option::<serde_json::Number>::deserialize(d)?;
    Ok(v.and_then(|n| n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))))
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: AuthType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_timestamp")]
    pub updated_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Hosts this snippet is shown for. Missing means all hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_timestamp")]
    pub updated_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_timestamp")]
    pub updated_at: Option<i64>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub algo: String,
    pub fingerprint: String,
    pub added_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_timestamp")]
    pub updated_at: Option<i64>,
    /// Known hosts keep their fields when deleted, unlike the tombstones in lists.
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}

/// Keyed by `host:port`.
pub type KnownHosts = BTreeMap<String, KnownHost>;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
    Light,
}

/// Fields added in later versions are missing from older files; those get the default.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub font_family: String,
    pub font_size: u32,
    pub theme: Theme,
    /// Lock the vault after this many minutes without keyboard or mouse input. 0 turns it off.
    pub auto_lock_minutes: u32,
    pub show_host_status: bool,
    /// Keep the window out of screenshots and screen recordings (macOS only).
    pub block_screenshots: bool,
    pub check_updates_on_startup: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de_timestamp")]
    pub updated_at: Option<i64>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            font_family: "Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace".into(),
            font_size: 13,
            theme: Theme::Dark,
            auto_lock_minutes: 15,
            show_host_status: false,
            block_screenshots: true,
            check_updates_on_startup: false,
            updated_at: None,
        }
    }
}

/// Stored in sync.json. Only lives on this device.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Server version this device last uploaded or downloaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultStatus {
    Missing,
    Locked,
    Unlocked,
    Broken,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LoadError {
    pub file: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostKeyCheck {
    Match,
    Unknown { algo: String, fingerprint: String },
    Changed { algo: String, fingerprint: String, old_fingerprint: String },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Prompt {
    Hostkey { host: String, port: u16, check: HostKeyCheck },
    Password { label: String },
    Passphrase { label: String },
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PromptAnswer {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub save: bool,
}

impl PromptAnswer {
    pub fn cancel() -> Self {
        PromptAnswer::default()
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    /// The file for this system, or the release page when there is none.
    pub download_url: String,
    /// Only an AppImage can download and install the update itself.
    pub can_install: bool,
}

/// One snippet in an export file. Hosts are referenced by label, since ids differ between machines.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SnippetExportEntry {
    pub name: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosts: Option<Vec<String>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SnippetExport {
    pub format: &'static str,
    pub version: u32,
    pub snippets: Vec<SnippetExportEntry>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SnippetImportResult {
    pub imported: usize,
    pub skipped: usize,
}

/// Milliseconds since 1970, like `Date.now()`.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Like `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
