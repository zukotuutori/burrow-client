//! The file operations the SFTP browser needs.

use std::path::Path;

use russh_sftp::client::SftpSession;
use tokio::io::AsyncWriteExt;

use crate::error::{Error, Result};
use crate::types::RemoteEntry;

fn sftp_err(e: russh_sftp::client::error::Error) -> Error {
    Error::msg(e.to_string())
}

pub async fn home(sftp: &SftpSession) -> Result<String> {
    Ok(sftp.canonicalize(".").await.map_err(sftp_err)?.to_string())
}

/// Folders first, then by name.
pub async fn list(sftp: &SftpSession, dir: &str) -> Result<Vec<RemoteEntry>> {
    let mut out: Vec<RemoteEntry> = sftp
        .read_dir(dir)
        .await
        .map_err(sftp_err)?
        .filter(|e| e.file_name() != "." && e.file_name() != "..")
        .map(|e| {
            let m = e.metadata();
            RemoteEntry {
                name: e.file_name().to_string(),
                is_dir: m.is_dir(),
                size: m.size.unwrap_or(0),
                mtime: m.mtime.unwrap_or(0) as u64,
            }
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

pub async fn upload(sftp: &SftpSession, local: &Path, remote: &str) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await?;
    let mut dst = sftp.create(remote).await.map_err(sftp_err)?;
    tokio::io::copy(&mut src, &mut dst).await?;
    dst.shutdown().await?;
    Ok(())
}

pub async fn download(sftp: &SftpSession, remote: &str, local: &Path) -> Result<()> {
    let mut src = sftp.open(remote).await.map_err(sftp_err)?;
    let mut dst = tokio::fs::File::create(local).await?;
    tokio::io::copy(&mut src, &mut dst).await?;
    dst.flush().await?;
    Ok(())
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<()> {
    sftp.rename(from, to).await.map_err(sftp_err)
}

pub async fn remove(sftp: &SftpSession, path: &str, is_dir: bool) -> Result<()> {
    if is_dir {
        sftp.remove_dir(path).await.map_err(sftp_err)
    } else {
        sftp.remove_file(path).await.map_err(sftp_err)
    }
}

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<()> {
    sftp.create_dir(path).await.map_err(sftp_err)
}

/// `posix.join(dir, name)` for remote paths.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn joins_remote_paths() {
        assert_eq!(super::join("/", "a"), "/a");
        assert_eq!(super::join("/home/dev", "a.txt"), "/home/dev/a.txt");
    }
}

/// Runs against `npm run dev:server` (user dev, password dev on port 2222): `cargo test -- --ignored sftp_dev_server`.
#[cfg(test)]
mod dev_server {
    use std::sync::Arc;
    use std::time::Duration;

    use zeroize::Zeroizing;

    use crate::ssh::session::{Auth, ConnectOptions, SshSession};

    #[tokio::test]
    #[ignore]
    async fn sftp_dev_server() {
        let opts = ConnectOptions {
            host: "127.0.0.1".into(),
            port: 2222,
            username: "dev".into(),
            auth: Auth::Password(Zeroizing::new("dev".into())),
            cols: 80,
            rows: 24,
            handshake_timeout: Duration::from_secs(5),
        };
        let s = SshSession::open(opts, Arc::new(|_, _| Box::pin(async { true })), Arc::new(|_| {}), Box::new(|_| {})).await.unwrap();
        let sftp = s.sftp().await.unwrap();
        let home = super::home(&sftp).await.unwrap();
        let names: Vec<_> = super::list(&sftp, &home).await.unwrap().into_iter().map(|e| (e.name, e.is_dir)).collect();
        assert!(names.contains(&("docs".to_string(), true)), "{names:?}");
        assert!(names.contains(&("hello.txt".to_string(), false)), "{names:?}");

        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("hello.txt");
        super::download(&sftp, &super::join(&home, "hello.txt"), &local).await.unwrap();
        assert_eq!(std::fs::read_to_string(&local).unwrap(), "hello from the dev server\n");

        let big = dir.path().join("big.bin");
        std::fs::write(&big, vec![7u8; 3 * 1024 * 1024]).unwrap();
        super::upload(&sftp, &big, &super::join(&home, "big.bin")).await.unwrap();
        super::rename(&sftp, &super::join(&home, "big.bin"), &super::join(&home, "big2.bin")).await.unwrap();
        let back = dir.path().join("back.bin");
        super::download(&sftp, &super::join(&home, "big2.bin"), &back).await.unwrap();
        assert_eq!(std::fs::read(&back).unwrap().len(), 3 * 1024 * 1024);
        super::remove(&sftp, &super::join(&home, "big2.bin"), false).await.unwrap();
        super::mkdir(&sftp, &super::join(&home, "newdir")).await.unwrap();
        super::remove(&sftp, &super::join(&home, "newdir"), true).await.unwrap();
        s.close();
    }
}
