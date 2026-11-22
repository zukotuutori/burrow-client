use std::time::Duration;

use tokio::net::TcpStream;
use tokio::time::timeout;

/// Opens a TCP connection and closes it right away. True if the host accepted it within the timeout.
pub async fn is_reachable(host: &str, port: u16, limit: Duration) -> bool {
    matches!(timeout(limit, TcpStream::connect((host, port))).await, Ok(Ok(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_and_closed_ports() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_reachable("127.0.0.1", port, Duration::from_secs(3)).await);
        drop(listener);
        assert!(!is_reachable("127.0.0.1", port, Duration::from_secs(3)).await);
    }
}
