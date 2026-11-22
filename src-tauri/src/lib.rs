pub mod error;
pub mod keys;
pub mod password_policy;
pub mod ssh;
pub mod store;
pub mod types;
pub mod validate;
pub mod vault;

use tauri::{WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Burrow Client")
                .inner_size(1200.0, 780.0)
                .min_inner_size(800.0, 500.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Burrow Client");
}
