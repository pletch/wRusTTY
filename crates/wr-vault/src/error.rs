#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault file already exists")]
    AlreadyExists,

    #[error("vault file not found")]
    NotFound,

    #[error("incorrect master password")]
    WrongPassword,

    #[error("key derivation failed: {0}")]
    Kdf(String),

    #[error("vault file is corrupt: {0}")]
    Corrupt(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
