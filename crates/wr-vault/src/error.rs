use crate::provider::ProviderError;
use crate::wrapper::WrapperKind;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault file already exists")]
    AlreadyExists,

    #[error("vault file not found")]
    NotFound,

    #[error("incorrect master password")]
    WrongPassword,

    /// The non-password analogue of `WrongPassword`. Almost always means the
    /// method's underlying key changed rather than that anyone typed anything
    /// wrong, so it reads differently on purpose.
    #[error("could not unlock with {0} — its key has changed, so unlock another way and set it up again")]
    UnlockFailed(WrapperKind),

    #[error("{0} isn't set up for this vault")]
    NoSuchUnlockMethod(WrapperKind),

    /// Guards against bricking the vault by removing the only way in.
    #[error("cannot remove the only remaining unlock method")]
    LastUnlockMethod,

    /// A vault reachable *only* by hardware-backed unlock is one firmware
    /// update, PIN reset, or motherboard failure away from being unopenable.
    /// See `Vault::remove_unlock_method`.
    #[error(
        "the master password cannot be removed — it's the fallback for every other unlock method"
    )]
    PasswordRequired,

    /// A v1 vault predates wrappers entirely, so the only key it holds is the
    /// one derived from the master password. Any other method has to wait
    /// until the file has been migrated.
    #[error("this vault must be unlocked with your master password once before {0} can be used")]
    NeedsMasterPassword(WrapperKind),

    #[error("vault file format version {0} is newer than this version of wRusTTY understands")]
    UnsupportedVersion(u32),

    #[error("key derivation failed: {0}")]
    Kdf(String),

    #[error("vault file is corrupt: {0}")]
    Corrupt(String),

    #[error(transparent)]
    Provider(#[from] ProviderError),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
