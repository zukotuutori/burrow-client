//! A shell on this machine, running in a pseudo terminal.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{Error, Result};
use crate::ssh::session::{OnClose, OnData};
use crate::utf8::Utf8Decoder;

/// Runs the close callback once, whichever happens first: the shell exits or it is closed.
type Finish = Arc<Mutex<Option<OnClose>>>;

fn finish(f: &Finish, reason: Option<String>) {
    if let Some(cb) = f.lock().unwrap().take() {
        cb(reason);
    }
}

fn pty_err(e: impl std::fmt::Display) -> Error {
    Error::msg(format!("Could not start the shell: {e}"))
}

fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() })
}

pub struct LocalShell {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    finish: Finish,
}

impl LocalShell {
    pub fn spawn(cols: u16, rows: u16, on_data: OnData, on_close: OnClose) -> Result<LocalShell> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(pty_err)?;
        // A login shell, so apps started from Finder or a desktop launcher still get the user's PATH.
        let mut cmd = CommandBuilder::new(user_shell());
        cmd.arg("-l");
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
        let writer = pair.master.take_writer().map_err(pty_err)?;
        let killer = child.clone_killer();
        let finish_cb: Finish = Arc::new(Mutex::new(Some(on_close)));

        std::thread::spawn(move || {
            let mut decoder = Utf8Decoder::default();
            let mut buf = [0u8; 16 * 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                on_data(decoder.decode(&buf[..n]));
            }
        });
        let f = finish_cb.clone();
        std::thread::spawn(move || {
            let reason = match child.wait() {
                Ok(s) if s.success() => "Shell exited".to_string(),
                Ok(s) => format!("Shell exited with code {}", s.exit_code()),
                Err(e) => e.to_string(),
            };
            finish(&f, Some(reason));
        });

        Ok(LocalShell {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            finish: finish_cb,
        })
    }

    fn is_open(&self) -> bool {
        self.finish.lock().unwrap().is_some()
    }

    pub fn write(&self, data: &str) {
        if self.is_open() {
            let mut w = self.writer.lock().unwrap();
            let _ = w.write_all(data.as_bytes()).and_then(|_| w.flush());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if self.is_open() {
            let _ = self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn close(&self) {
        if self.is_open() {
            let _ = self.killer.lock().unwrap().kill();
        }
        finish(&self.finish, None);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn runs_commands_and_reports_the_exit() {
        let out = Arc::new(Mutex::new(String::new()));
        let o = out.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let shell = LocalShell::spawn(80, 24, Arc::new(move |s| o.lock().unwrap().push_str(&s)), Box::new(move |r| tx.send(r).unwrap())).unwrap();
        shell.resize(100, 30);
        shell.write("echo burrow-$((40+2))\n");
        shell.write("exit 3\n");
        let reason = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        assert_eq!(reason.as_deref(), Some("Shell exited with code 3"));
        std::thread::sleep(Duration::from_millis(100));
        assert!(out.lock().unwrap().contains("burrow-42"), "{:?}", out.lock().unwrap());
    }

    #[test]
    fn close_kills_the_shell_once() {
        let (tx, rx) = std::sync::mpsc::channel();
        let shell = LocalShell::spawn(80, 24, Arc::new(|_| {}), Box::new(move |r| tx.send(r).unwrap())).unwrap();
        shell.close();
        shell.close();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), None);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }
}
