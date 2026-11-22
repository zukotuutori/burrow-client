//! A small SSH server for tests: password or key login, and a shell that echoes what it gets.

use std::sync::Arc;

use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Session, VerifiedPublicKey};
use russh::{Channel, ChannelId};

pub struct TestServer {
    pub port: u16,
    pub host_key: PrivateKey,
}

#[derive(Clone)]
struct Handler {
    password: String,
    allowed_key: Option<PublicKey>,
}

impl server::Handler for Handler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == "dev" && password == self.password { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        let ok = user == "dev" && self.allowed_key.as_ref().is_some_and(|k| k.key_data() == key.public_key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, bytes::Bytes::from_static(b"welcome\r\n"))?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if data == b"exit\n" {
            session.close(channel)?;
        } else {
            session.data(channel, bytes::Bytes::copy_from_slice(data))?;
        }
        Ok(())
    }
}

pub fn ed25519_key() -> PrivateKey {
    let seed = crate::vault::crypto::random_bytes::<32>();
    PrivateKey::new(KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed)), "test").unwrap()
}

pub async fn start(password: &str, allowed_key: Option<PublicKey>) -> TestServer {
    let host_key = ed25519_key();
    let config = Arc::new(server::Config {
        keys: vec![host_key.clone()],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handler = Handler { password: password.into(), allowed_key };
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                if let Ok(running) = server::run_stream(config, socket, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    TestServer { port, host_key }
}
