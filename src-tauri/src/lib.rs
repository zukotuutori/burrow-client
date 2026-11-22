pub mod auto_lock;
pub mod commands;
pub mod core;
#[cfg(test)]
mod core_tests;
pub mod error;
pub mod keys;
pub mod local_shell;
pub mod password_policy;
pub mod prompts;
pub mod ssh;
pub mod store;
pub mod sync;
pub mod types;
pub mod updates;
pub mod utf8;
pub mod validate;
pub mod vault;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::commands::{open_external_url, set_content_protection, AppState};
use crate::core::{Core, Emit, Event};
use crate::prompts::PendingPrompts;
use crate::sync::crypto::SYNC_KDF;
use crate::vault::crypto::DEFAULT_KDF;

/// Same folder as the Electron version: ~/Library/Application Support/Burrow Client on macOS,
/// ~/.config/Burrow Client on Linux. Debug builds can point BURROW_DATA_DIR somewhere else, so trying out a
/// change does not touch real data.
fn data_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("BURROW_DATA_DIR").filter(|d| !d.is_empty()) {
            return PathBuf::from(dir);
        }
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Burrow Client")
}

/// `process.platform` names, which the window uses for keyboard shortcuts.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

/// Only the app's own pages may load in the window. Everything else is blocked.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    cfg!(debug_assertions) && dev_url.is_some_and(|d| d.origin() == url.origin())
}

/// Locks the vault, closes sessions and prompts, and sends the window back to the unlock screen.
fn lock_vault(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.prompts.cancel_all();
    state.core.lock();
    let _ = app.emit_to("main", "vault:locked", ());
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let block = app.state::<AppState>().core.settings().block_screenshots;
    let dev_url = app.config().build.dev_url.clone();
    let platform = serde_json::to_string(platform()).unwrap_or_default();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Burrow Client")
        .inner_size(1200.0, 780.0)
        .min_inner_size(800.0, 500.0)
        .background_color(Color(0x15, 0x17, 0x1c, 0xff))
        // Keep the window out of screenshots and screen recordings unless turned off in settings (macOS).
        .content_protected(block)
        .initialization_script(format!("window.__BURROW_PLATFORM__ = {platform};"))
        .on_navigation(move |url| is_app_url(url, dev_url.as_ref()))
        .on_new_window(|url, _| {
            open_external_url(url.as_str());
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// macOS gets a small menu so Cmd+C/V/Q work. There is no "Close Window" item, so Cmd+W reaches the app.
/// Linux gets no menu: its accelerators would steal keys from the shell.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
    let app_menu = Submenu::with_items(
        app,
        "Burrow Client",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&P::fullscreen(app, None)?])?;
    let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::maximize(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// Locks after the configured idle time, after sleep and when the screen locks. Syncs every five minutes.
fn spawn_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut sleep = auto_lock::SleepDetector::default();
        let mut was_screen_locked = false;
        let mut tick: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            tick += 1;
            let core = app.state::<AppState>().core.clone();
            let screen_locked = auto_lock::screen_locked();
            let newly_locked = screen_locked && !was_screen_locked;
            was_screen_locked = screen_locked;
            if (sleep.slept() || newly_locked) && core.is_unlocked() {
                lock_vault(&app);
            }
            if tick % 8 == 0 {
                let idle = auto_lock::system_idle_seconds().unwrap_or(0);
                if auto_lock::should_idle_lock(idle, core.settings().auto_lock_minutes, core.is_unlocked()) {
                    lock_vault(&app);
                }
            }
            if tick % 150 == 0 {
                core.sync.sync_if_logged_in(&core).await;
            }
        }
    });
}

pub fn run() {
    let builder = tauri::Builder::default()
        // Only one copy may run: two copies on the same data would overwrite each other's saves.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| match app.get_webview_window("main") {
            Some(w) => {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            None => {
                let _ = create_window(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.enable_macos_default_menu(false).menu(build_menu);

    let app = builder
        .invoke_handler(all_commands!())
        .setup(|app| {
            let handle = app.handle().clone();
            let emit: Emit = Arc::new(move |e| {
                let _ = match e {
                    Event::SessionData { id, data } => handle.emit_to("main", "session:data", (id, data)),
                    Event::SessionClosed { id, reason } => handle.emit_to("main", "session:closed", (id, reason)),
                    Event::SyncChanged => {
                        // A sync can bring a changed screenshot setting from another device.
                        if let Some(s) = handle.try_state::<AppState>() {
                            set_content_protection(&handle, &s.core);
                        }
                        handle.emit_to("main", "sync:changed", ())
                    }
                };
            });
            let core = Core::new(&data_dir(), emit, DEFAULT_KDF, SYNC_KDF);
            core.init()?;
            app.manage(AppState { core, prompts: Arc::new(PendingPrompts::default()) });
            create_window(app.handle())?;
            spawn_background(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Burrow Client");

    app.run(|app, event| match event {
        RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if label == "main" => lock_vault(app),
        // On macOS the app stays in the Dock without a window, like other Mac apps.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if app.get_webview_window("main").is_none() {
                let _ = create_window(app);
            }
        }
        _ => {}
    });
}
