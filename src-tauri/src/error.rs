use serde::{Serialize, Serializer};

/// Every error the backend can return. The window only ever sees the message.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("{file} could not be read: {message}")]
    CorruptFile { file: String, message: String },
    #[error("Wrong password")]
    WrongPassword,
    #[error("Vault is locked")]
    VaultLocked,
    #[error("This key is encrypted. Enter its passphrase.")]
    NeedsPassphrase,
    #[error("Could not read key: {0}")]
    KeyParse(String),
    /// An answer from the sync server that was not 2xx.
    #[error("{message}")]
    Http { status: u16, message: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn msg(m: impl Into<String>) -> Self {
        Error::Msg(m.into())
    }

    pub fn http_status(&self) -> Option<u16> {
        match self {
            Error::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
}

/// Commands reject with the plain message, like the Electron app did.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Shorthand for `Err(Error::Msg(..))`.
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::error::Error::Msg(format!($($arg)*)))
    };
}
pub(crate) use bail;
