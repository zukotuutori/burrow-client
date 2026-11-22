//! One SSH connection with an interactive shell, built on russh.

use std::borrow::Cow;
use std::future::Future;
use std::io::ErrorKind;
use std::pin::{pin, Pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{Algorithm, EcdsaCurve, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{kex, mac, ChannelMsg, Disconnect, Preferred};
use russh_sftp::client::SftpSession;
use tokio::sync::{mpsc, Mutex};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::keys::fingerprint;
use crate::utf8::Utf8Decoder;

pub enum Auth {
    Password(Zeroizing<String>),
    Key(Arc<PrivateKey>),
}

pub struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    pub cols: u32,
    pub rows: u32,
    /// Handshake timeout, not counting the time the user spends on the host key prompt.
    pub handshake_timeout: Duration,
}

/// Asks whether to trust the server's key: (algorithm, fingerprint) -> trusted.
pub type VerifyHostKey = Arc<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
pub type OnData = Arc<dyn Fn(String) + Send + Sync>;
pub type OnClose = Box<dyn FnOnce(Option<String>) + Send>;

/// Everything based on SHA-1 is left out of what we offer. If a server only speaks SHA-1, the handshake fails
/// instead of connecting insecurely. russh never offers SHA-1 key exchange or MACs by default; the host key
/// list still has `ssh-rsa` (RSA with SHA-1), which is removed here.
fn preferred() -> Preferred {
    Preferred {
        kex: Cow::Borrowed(&[
            kex::MLKEM768X25519_SHA256,
            kex::CURVE25519,
            kex::CURVE25519_PRE_RFC_8731,
            kex::DH_GEX_SHA256,
            kex::DH_G18_SHA512,
            kex::DH_G17_SHA512,
            kex::DH_G16_SHA512,
            kex::DH_G15_SHA512,
            kex::DH_G14_SHA256,
            kex::EXTENSION_SUPPORT_AS_CLIENT,
            kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
        ]),
        key: Cow::Owned(vec![
            Algorithm::Ed25519,
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
            Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
            Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
            Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
        ]),
        mac: Cow::Borrowed(&[mac::HMAC_SHA512_ETM, mac::HMAC_SHA256_ETM, mac::HMAC_SHA512, mac::HMAC_SHA256]),
        ..Preferred::DEFAULT
    }
}

/// A short message for the window.
pub fn describe_error(e: &russh::Error) -> String {
    match e {
        russh::Error::IO(io) => describe_io(io),
        russh::Error::UnknownKey => "Host key rejected".into(),
        russh::Error::NoCommonAlgo { .. } => "The server only supports outdated, insecure algorithms".into(),
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout | russh::Error::InactivityTimeout => {
            "Connection timed out".into()
        }
        russh::Error::Disconnect | russh::Error::HUP => "Connection closed".into(),
        other => other.to_string(),
    }
}

fn describe_io(e: &std::io::Error) -> String {
    match e.kind() {
        ErrorKind::ConnectionRefused => "Connection refused".into(),
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => "Host unreachable".into(),
        ErrorKind::TimedOut => "Connection timed out".into(),
        ErrorKind::UnexpectedEof | ErrorKind::ConnectionReset | ErrorKind::BrokenPipe => "Connection closed".into(),
        _ if e.to_string().contains("lookup address") => "Host not found".into(),
        _ => e.to_string(),
    }
}

struct Client {
    verify: VerifyHostKey,
    /// While set, the handshake timeout does not count down.
    prompting: Arc<AtomicBool>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        // Certificates are never requested, so a server sending one is refused.
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else { return Ok(false) };
        self.prompting.store(true, Ordering::SeqCst);
        let ok = (self.verify)(key.algorithm().as_str().to_string(), fingerprint(key)).await;
        self.prompting.store(false, Ordering::SeqCst);
        Ok(ok)
    }
}

/// Runs `fut` with a timeout that pauses while `paused` is set.
async fn with_pausable_timeout<T>(limit: Duration, paused: &AtomicBool, fut: impl Future<Output = Result<T>>) -> Result<T> {
    const TICK: Duration = Duration::from_millis(100);
    let mut fut = pin!(fut);
    let mut used = Duration::ZERO;
    loop {
        tokio::select! {
            r = &mut fut => return r,
            _ = tokio::time::sleep(TICK) => {
                if !paused.load(Ordering::SeqCst) {
                    used += TICK;
                    if used >= limit {
                        return Err(Error::msg("Connection timed out"));
                    }
                }
            }
        }
    }
}

enum Cmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshSession {
    handle: Arc<Handle<Client>>,
    cmds: mpsc::UnboundedSender<Cmd>,
    closed: Arc<AtomicBool>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
}

impl SshSession {
    pub async fn open(opts: ConnectOptions, verify: VerifyHostKey, on_data: OnData, on_close: OnClose) -> Result<SshSession> {
        let prompting = Arc::new(AtomicBool::new(false));
        let handler = Client { verify, prompting: prompting.clone() };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            preferred: preferred(),
            nodelay: true,
            ..Default::default()
        });
        let ssh_err = |e: russh::Error| Error::msg(describe_error(&e));

        let (handle, channel) = with_pausable_timeout(opts.handshake_timeout, &prompting, async {
            let mut handle = client::connect(config, (opts.host.as_str(), opts.port), handler).await.map_err(ssh_err)?;
            let auth = match &opts.auth {
                Auth::Password(pw) => handle.authenticate_password(&opts.username, pw.as_str()).await,
                Auth::Key(key) => {
                    let hash = if key.algorithm().is_rsa() {
                        handle.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten()
                    } else {
                        None
                    };
                    let key = PrivateKeyWithHashAlg::new(key.clone(), hash);
                    handle.authenticate_publickey(&opts.username, key).await
                }
            }
            .map_err(ssh_err)?;
            if !auth.success() {
                return Err(Error::msg("Authentication failed"));
            }
            let mut channel = handle.channel_open_session().await.map_err(ssh_err)?;
            channel.request_pty(false, "xterm-256color", opts.cols, opts.rows, 0, 0, &[]).await.map_err(ssh_err)?;
            channel.request_shell(true).await.map_err(ssh_err)?;
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => break,
                    Some(ChannelMsg::Failure) => return Err(Error::msg("The server refused to start a shell")),
                    Some(_) => continue,
                    None => return Err(Error::msg("Connection closed")),
                }
            }
            Ok((handle, channel))
        })
        .await?;

        let handle = Arc::new(handle);
        let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
        let closed = Arc::new(AtomicBool::new(false));
        let (mut read, write) = channel.split();
        let task_handle = handle.clone();
        let task_closed = closed.clone();
        tokio::spawn(async move {
            let mut out = Utf8Decoder::default();
            let mut err = Utf8Decoder::default();
            let reason: Option<String> = loop {
                tokio::select! {
                    msg = read.wait() => match msg {
                        Some(ChannelMsg::Data { data }) => on_data(out.decode(&data)),
                        Some(ChannelMsg::ExtendedData { data, .. }) => on_data(err.decode(&data)),
                        Some(ChannelMsg::Close) | None => break None,
                        Some(_) => {}
                    },
                    cmd = rx.recv() => match cmd {
                        Some(Cmd::Write(bytes)) => {
                            if let Err(e) = write.data(&bytes[..]).await {
                                break Some(describe_error(&e));
                            }
                        }
                        Some(Cmd::Resize(cols, rows)) => {
                            let _ = write.window_change(cols, rows, 0, 0).await;
                        }
                        Some(Cmd::Close) | None => break None,
                    },
                }
            };
            task_closed.store(true, Ordering::SeqCst);
            let _ = write.close().await;
            let _ = task_handle.disconnect(Disconnect::ByApplication, "", "en").await;
            on_close(reason);
        });

        Ok(SshSession { handle, cmds: tx, closed, sftp: Mutex::new(None) })
    }

    pub fn write(&self, data: &str) {
        if !self.closed.load(Ordering::SeqCst) {
            let _ = self.cmds.send(Cmd::Write(data.as_bytes().to_vec()));
        }
    }

    pub fn resize(&self, cols: u32, rows: u32) {
        if !self.closed.load(Ordering::SeqCst) {
            let _ = self.cmds.send(Cmd::Resize(cols, rows));
        }
    }

    /// Ends the session. The close callback runs once the connection is shut down.
    pub fn close(&self) {
        let _ = self.cmds.send(Cmd::Close);
    }

    /// The SFTP subsystem on this connection, opened on first use.
    pub async fn sftp(&self) -> Result<Arc<SftpSession>> {
        let mut slot = self.sftp.lock().await;
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let ssh_err = |e: russh::Error| Error::msg(describe_error(&e));
        let channel = self.handle.channel_open_session().await.map_err(ssh_err)?;
        channel.request_subsystem(true, "sftp").await.map_err(ssh_err)?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| Error::msg(format!("SFTP failed: {e}")))?;
        let sftp = Arc::new(sftp);
        *slot = Some(sftp.clone());
        Ok(sftp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::test_server;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::oneshot;

    struct Probe {
        data: Arc<StdMutex<String>>,
        closed: oneshot::Receiver<Option<String>>,
    }

    fn handlers() -> (OnData, OnClose, Probe) {
        let data = Arc::new(StdMutex::new(String::new()));
        let d = data.clone();
        let (tx, rx) = oneshot::channel();
        let on_data: OnData = Arc::new(move |s| d.lock().unwrap().push_str(&s));
        let on_close: OnClose = Box::new(move |r| {
            let _ = tx.send(r);
        });
        (on_data, on_close, Probe { data, closed: rx })
    }

    fn trust(answer: bool, delay: Duration, seen: Arc<StdMutex<Vec<(String, String)>>>) -> VerifyHostKey {
        Arc::new(move |algo, fp| {
            seen.lock().unwrap().push((algo, fp));
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                answer
            })
        })
    }

    fn opts(port: u16, auth: Auth) -> ConnectOptions {
        ConnectOptions {
            host: "127.0.0.1".into(),
            port,
            username: "dev".into(),
            auth,
            cols: 80,
            rows: 24,
            handshake_timeout: Duration::from_secs(5),
        }
    }

    async fn wait_for(data: &Arc<StdMutex<String>>, text: &str) {
        for _ in 0..100 {
            if data.lock().unwrap().contains(text) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("never got {text:?}, only {:?}", data.lock().unwrap());
    }

    #[tokio::test]
    async fn password_login_echo_and_close() {
        let server = test_server::start("dev", None).await;
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let (on_data, on_close, probe) = handlers();
        let pw = Auth::Password(Zeroizing::new("dev".into()));
        let s = SshSession::open(opts(server.port, pw), trust(true, Duration::ZERO, seen.clone()), on_data, on_close).await.unwrap();
        let expected = fingerprint(server.host_key.public_key());
        assert_eq!(seen.lock().unwrap().as_slice(), &[("ssh-ed25519".to_string(), expected)]);
        wait_for(&probe.data, "welcome").await;
        s.write("héllo");
        wait_for(&probe.data, "héllo").await;
        s.resize(100, 30);
        s.write("exit\n");
        assert_eq!(probe.closed.await.unwrap(), None);
    }

    #[tokio::test]
    async fn wrong_password_fails() {
        let server = test_server::start("dev", None).await;
        let (on_data, on_close, _probe) = handlers();
        let pw = Auth::Password(Zeroizing::new("nope".into()));
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let e = SshSession::open(opts(server.port, pw), trust(true, Duration::ZERO, seen), on_data, on_close).await.err().unwrap();
        assert_eq!(e.to_string(), "Authentication failed");
    }

    #[tokio::test]
    async fn rejected_host_key_stops_before_login() {
        let server = test_server::start("dev", None).await;
        let (on_data, on_close, _probe) = handlers();
        let pw = Auth::Password(Zeroizing::new("dev".into()));
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let e = SshSession::open(opts(server.port, pw), trust(false, Duration::ZERO, seen), on_data, on_close).await.err().unwrap();
        assert_eq!(e.to_string(), "Host key rejected");
    }

    #[tokio::test]
    async fn key_login() {
        let client_key = test_server::ed25519_key();
        let server = test_server::start("unused", Some(client_key.public_key().clone())).await;
        let (on_data, on_close, probe) = handlers();
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s = SshSession::open(opts(server.port, Auth::Key(Arc::new(client_key))), trust(true, Duration::ZERO, seen), on_data, on_close)
            .await
            .unwrap();
        wait_for(&probe.data, "welcome").await;
        s.close();
        assert_eq!(probe.closed.await.unwrap(), None);
    }

    #[tokio::test]
    async fn the_timeout_waits_while_the_host_key_prompt_is_open() {
        let server = test_server::start("dev", None).await;
        let (on_data, on_close, _probe) = handlers();
        let mut o = opts(server.port, Auth::Password(Zeroizing::new("dev".into())));
        o.handshake_timeout = Duration::from_millis(500);
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s = SshSession::open(o, trust(true, Duration::from_millis(1200), seen), on_data, on_close).await;
        assert!(s.is_ok(), "{:?}", s.err());
    }

    #[tokio::test]
    async fn refused_connection_has_a_short_message() {
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let (on_data, on_close, _probe) = handlers();
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let pw = Auth::Password(Zeroizing::new("dev".into()));
        let e = SshSession::open(opts(port, pw), trust(true, Duration::ZERO, seen), on_data, on_close).await.err().unwrap();
        assert_eq!(e.to_string(), "Connection refused");
    }
}
