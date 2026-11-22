//! The commands the window can call. Replaces ipc.ts: same operations, same argument checks.
//!
//! Tauri checks argument types while decoding; objects that need more checks arrive as JSON and go through
//! the validators in Core.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::core::{Ask, Core};
use crate::error::{bail, Error, Result};
use crate::keys::KeyType;
use crate::prompts::PendingPrompts;
use crate::ssh::sftp;
use crate::types::*;
use crate::updates;

const MAX_IMPORT_BYTES: u64 = 5 * 1024 * 1024;

pub struct AppState {
    pub core: Arc<Core>,
    pub prompts: Arc<PendingPrompts>,
}

type S<'a> = State<'a, AppState>;

/// Runs work that may take a while (scrypt, RSA key generation) off the async threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| Error::msg(e.to_string()))?
}

fn empty_to_none(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

pub fn set_content_protection(app: &AppHandle, core: &Core) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_content_protected(core.settings().block_screenshots);
    }
}

// Vault

#[tauri::command]
pub fn vault_status(s: S) -> Result<VaultStatus> {
    s.core.vault_status()
}

#[tauri::command]
pub async fn vault_create(s: S<'_>, password: String) -> Result<()> {
    let core = s.core.clone();
    blocking(move || core.create_vault(&password)).await
}

#[tauri::command]
pub async fn vault_unlock(s: S<'_>, password: String) -> Result<()> {
    let core = s.core.clone();
    blocking(move || core.unlock(&password)).await?;
    let core = s.core.clone();
    tauri::async_runtime::spawn(async move { core.sync.sync_if_logged_in(&core).await });
    Ok(())
}

#[tauri::command]
pub fn vault_lock(s: S) {
    s.prompts.cancel_all();
    s.core.lock();
}

#[tauri::command]
pub async fn vault_change_password(s: S<'_>, current: String, next: String) -> Result<()> {
    let core = s.core.clone();
    blocking(move || core.change_master_password(&current, &next)).await
}

#[tauri::command]
pub fn vault_reset(s: S) -> Result<()> {
    s.core.reset_vault()
}

// Files

#[tauri::command]
pub fn files_errors(s: S) -> Vec<LoadError> {
    s.core.load_errors()
}

#[tauri::command]
pub fn files_reset(s: S, file: String) -> Result<()> {
    s.core.reset_file(&file)
}

// Profiles

#[tauri::command]
pub fn profiles_list(s: S) -> Vec<Profile> {
    s.core.profiles()
}

#[tauri::command]
pub fn profiles_save(s: S, profile: Value, password: Option<String>) -> Result<()> {
    s.core.save_profile(&profile, empty_to_none(password).as_deref())
}

#[tauri::command]
pub fn profiles_remove(s: S, id: String) -> Result<()> {
    s.core.delete_profile(&id)
}

#[tauri::command]
pub fn profiles_has_password(s: S, id: String) -> Result<bool> {
    s.core.has_password(&id)
}

#[tauri::command]
pub fn profiles_forget_password(s: S, id: String) -> Result<()> {
    s.core.forget_password(&id)
}

#[tauri::command]
pub async fn profiles_reachable(s: S<'_>, id: String) -> Result<bool> {
    s.core.is_reachable(&id).await
}

// Snippets

#[tauri::command]
pub fn snippets_list(s: S) -> Vec<Snippet> {
    s.core.snippets()
}

#[tauri::command]
pub fn snippets_save(s: S, snippet: Value) -> Result<()> {
    s.core.save_snippet(&snippet)
}

#[tauri::command]
pub fn snippets_remove(s: S, id: String) -> Result<()> {
    s.core.delete_snippet(&id)
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(text.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn snippets_export(app: AppHandle, window: WebviewWindow, s: S<'_>) -> Result<Option<usize>> {
    let picked = blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export snippets")
            .set_file_name("burrow-snippets.json")
            .add_filter("Burrow snippets", &["json"])
            .blocking_save_file())
    })
    .await?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let data = s.core.export_snippets();
    let text = serde_json::to_string_pretty(&data).map_err(|e| Error::msg(e.to_string()))? + "\n";
    // Commands can contain sensitive details, so the file is readable only by the user.
    write_private(&path, &text)?;
    Ok(Some(data.snippets.len()))
}

#[tauri::command]
pub async fn snippets_import(app: AppHandle, window: WebviewWindow, s: S<'_>) -> Result<Option<SnippetImportResult>> {
    let picked = blocking(move || {
        Ok(app.dialog().file().set_parent(&window).set_title("Import snippets").add_filter("Burrow snippets", &["json"]).blocking_pick_file())
    })
    .await?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    if std::fs::metadata(&path)?.len() > MAX_IMPORT_BYTES {
        bail!("The file is too large for a snippets file");
    }
    let Ok(data) = serde_json::from_slice::<Value>(&std::fs::read(&path)?) else { bail!("This file is not valid JSON") };
    s.core.import_snippets(&data).map(Some)
}

// Keys

#[tauri::command]
pub fn keys_list(s: S) -> Vec<KeyMeta> {
    s.core.keys()
}

#[tauri::command]
pub async fn keys_generate(s: S<'_>, name: String, key_type: String) -> Result<KeyMeta> {
    let t = match key_type.as_str() {
        "ed25519" => KeyType::Ed25519,
        "rsa" => KeyType::Rsa,
        _ => bail!("Unsupported key type"),
    };
    let core = s.core.clone();
    blocking(move || core.generate_key(&name, t)).await
}

#[tauri::command]
pub async fn keys_import(s: S<'_>, name: String, private_key: String, passphrase: Option<String>) -> Result<KeyMeta> {
    let core = s.core.clone();
    blocking(move || core.import_key(&name, &private_key, empty_to_none(passphrase).as_deref())).await
}

#[tauri::command]
pub fn keys_remove(s: S, id: String) -> Result<()> {
    s.core.delete_key(&id)
}

#[tauri::command]
pub async fn keys_read_file(app: AppHandle, window: WebviewWindow) -> Result<Option<String>> {
    let picked = blocking(move || Ok(app.dialog().file().set_parent(&window).set_title("Import private key").blocking_pick_file())).await?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    if std::fs::metadata(&path)?.len() > MAX_IMPORT_BYTES {
        bail!("The file is too large for a key");
    }
    Ok(Some(std::fs::read_to_string(&path)?))
}

// Known hosts and settings

#[tauri::command]
pub fn known_hosts_list(s: S) -> KnownHosts {
    s.core.known_hosts()
}

#[tauri::command]
pub fn known_hosts_remove(s: S, id: String) -> Result<()> {
    s.core.remove_known_host(&id)
}

#[tauri::command]
pub fn settings_get(s: S) -> Settings {
    s.core.settings()
}

#[tauri::command]
pub fn settings_save(app: AppHandle, s: S, settings: Value) -> Result<()> {
    s.core.save_settings(&settings)?;
    set_content_protection(&app, &s.core);
    Ok(())
}

// Sync

#[tauri::command]
pub fn sync_status(s: S) -> SyncStatus {
    s.core.sync.status(&s.core)
}

#[tauri::command]
pub async fn sync_register(s: S<'_>, server_url: String, username: String, password: String, code: String) -> Result<()> {
    s.core.sync.register(&s.core, &server_url, &username, &password, &code).await
}

#[tauri::command]
pub async fn sync_login(s: S<'_>, server_url: String, username: String, password: String) -> Result<()> {
    s.core.sync.login(&s.core, &server_url, &username, &password).await
}

#[tauri::command]
pub fn sync_logout(s: S) -> Result<()> {
    s.core.sync.logout(&s.core, None)
}

#[tauri::command]
pub async fn sync_now(s: S<'_>) -> Result<()> {
    s.core.sync.sync_now(&s.core).await
}

#[tauri::command]
pub async fn sync_change_password(s: S<'_>, current: String, next: String) -> Result<()> {
    s.core.sync.change_password(&s.core, &current, &next).await
}

#[tauri::command]
pub async fn sync_delete_account(s: S<'_>, password: String) -> Result<()> {
    s.core.sync.delete_account(&s.core, &password).await
}

// Sessions and prompts

#[tauri::command]
pub async fn session_connect(app: AppHandle, s: S<'_>, id: String, profile_id: String, cols: u32, rows: u32) -> Result<()> {
    let prompts = s.prompts.clone();
    let ask: Ask = Arc::new(move |prompt: Prompt| {
        let prompts = prompts.clone();
        let app = app.clone();
        Box::pin(async move {
            if app.get_webview_window("main").is_none() {
                return PromptAnswer::cancel();
            }
            prompts.ask(|id| drop(app.emit_to("main", "prompt:request", (id, &prompt)))).await
        })
    });
    s.core.connect(&id, &profile_id, cols, rows, ask).await
}

#[tauri::command]
pub fn session_open_local(s: S, id: String, cols: u16, rows: u16) -> Result<()> {
    s.core.open_local(&id, cols, rows)
}

#[tauri::command]
pub fn session_write(s: S, id: String, data: String) {
    s.core.write(&id, &data);
}

#[tauri::command]
pub fn session_resize(s: S, id: String, cols: u32, rows: u32) {
    s.core.resize(&id, cols, rows);
}

#[tauri::command]
pub fn session_close(s: S, id: String) {
    s.core.close_session(&id);
}

#[tauri::command]
pub fn prompt_answer(s: S, prompt_id: String, answer: PromptAnswer) {
    s.prompts.answer(&prompt_id, answer);
}

// SFTP

/// The last part of a local path, for naming the uploaded file.
fn local_name(p: &Path) -> Result<String> {
    match p.file_name() {
        Some(n) => Ok(n.to_string_lossy().into_owned()),
        None => bail!("{} is not a file", p.display()),
    }
}

#[tauri::command]
pub async fn sftp_home(s: S<'_>, id: String) -> Result<String> {
    sftp::home(&*s.core.sftp(&id).await?).await
}

#[tauri::command]
pub async fn sftp_list(s: S<'_>, id: String, path: String) -> Result<Vec<RemoteEntry>> {
    sftp::list(&*s.core.sftp(&id).await?, &path).await
}

#[tauri::command]
pub async fn sftp_upload_dialog(app: AppHandle, window: WebviewWindow, s: S<'_>, id: String, dir: String) -> Result<usize> {
    let client = s.core.sftp(&id).await?;
    let picked = blocking(move || Ok(app.dialog().file().set_parent(&window).set_title("Upload files").blocking_pick_files())).await?;
    let paths: Vec<PathBuf> = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
    for p in &paths {
        sftp::upload(&client, p, &sftp::join(&dir, &local_name(p)?)).await?;
    }
    Ok(paths.len())
}

#[tauri::command]
pub async fn sftp_upload_paths(s: S<'_>, id: String, dir: String, local_paths: Vec<String>) -> Result<()> {
    let client = s.core.sftp(&id).await?;
    for p in local_paths.iter().map(PathBuf::from) {
        sftp::upload(&client, &p, &sftp::join(&dir, &local_name(&p)?)).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_download(app: AppHandle, window: WebviewWindow, s: S<'_>, id: String, remote_path: String) -> Result<bool> {
    let client = s.core.sftp(&id).await?;
    let name = remote_path.rsplit('/').next().unwrap_or("download").to_string();
    let picked = blocking(move || Ok(app.dialog().file().set_parent(&window).set_file_name(name).blocking_save_file())).await?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(false) };
    sftp::download(&client, &remote_path, &path).await?;
    Ok(true)
}

#[tauri::command]
pub async fn sftp_rename(s: S<'_>, id: String, from: String, to: String) -> Result<()> {
    sftp::rename(&*s.core.sftp(&id).await?, &from, &to).await
}

#[tauri::command]
pub async fn sftp_remove(s: S<'_>, id: String, path: String, is_dir: bool) -> Result<()> {
    sftp::remove(&*s.core.sftp(&id).await?, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_mkdir(s: S<'_>, id: String, path: String) -> Result<()> {
    sftp::mkdir(&*s.core.sftp(&id).await?, &path).await
}

// Updates and links

#[tauri::command]
pub async fn updates_check(app: AppHandle) -> Result<UpdateInfo> {
    updates::check_for_update(&app.package_info().version.to_string(), &updates::System::current()).await
}

#[tauri::command]
pub async fn updates_download() -> Result<()> {
    updates::download_update(&updates::System::current()).await
}

#[tauri::command]
pub fn updates_restart(app: AppHandle) -> Result<()> {
    updates::start_new_version()?;
    app.exit(0);
    Ok(())
}

/// Only http and https links open, in the normal browser.
pub fn open_external_url(url: &str) {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    }
}

#[tauri::command]
pub fn app_open_external(url: String) {
    open_external_url(&url);
}

/// Every command, for the invoke handler and the permission list in build.rs.
#[macro_export]
macro_rules! all_commands {
    () => {
        tauri::generate_handler![
            $crate::commands::vault_status,
            $crate::commands::vault_create,
            $crate::commands::vault_unlock,
            $crate::commands::vault_lock,
            $crate::commands::vault_change_password,
            $crate::commands::vault_reset,
            $crate::commands::files_errors,
            $crate::commands::files_reset,
            $crate::commands::profiles_list,
            $crate::commands::profiles_save,
            $crate::commands::profiles_remove,
            $crate::commands::profiles_has_password,
            $crate::commands::profiles_forget_password,
            $crate::commands::profiles_reachable,
            $crate::commands::snippets_list,
            $crate::commands::snippets_save,
            $crate::commands::snippets_remove,
            $crate::commands::snippets_export,
            $crate::commands::snippets_import,
            $crate::commands::keys_list,
            $crate::commands::keys_generate,
            $crate::commands::keys_import,
            $crate::commands::keys_remove,
            $crate::commands::keys_read_file,
            $crate::commands::known_hosts_list,
            $crate::commands::known_hosts_remove,
            $crate::commands::settings_get,
            $crate::commands::settings_save,
            $crate::commands::sync_status,
            $crate::commands::sync_register,
            $crate::commands::sync_login,
            $crate::commands::sync_logout,
            $crate::commands::sync_now,
            $crate::commands::sync_change_password,
            $crate::commands::sync_delete_account,
            $crate::commands::session_connect,
            $crate::commands::session_open_local,
            $crate::commands::session_write,
            $crate::commands::session_resize,
            $crate::commands::session_close,
            $crate::commands::prompt_answer,
            $crate::commands::sftp_home,
            $crate::commands::sftp_list,
            $crate::commands::sftp_upload_dialog,
            $crate::commands::sftp_upload_paths,
            $crate::commands::sftp_download,
            $crate::commands::sftp_rename,
            $crate::commands::sftp_remove,
            $crate::commands::sftp_mkdir,
            $crate::commands::updates_check,
            $crate::commands::updates_download,
            $crate::commands::updates_restart,
            $crate::commands::app_open_external,
        ]
    };
}
