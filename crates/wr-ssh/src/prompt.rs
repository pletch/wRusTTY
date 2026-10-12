//! Relaying the server's authentication questions to a person.
//!
//! In keyboard-interactive (RFC 4256) the server decides what to ask
//! ("Password:", then "Verification code:", or whatever PAM wants), so the
//! connection stops mid-handshake to ask. Shaped like
//! [`crate::HostKeyVerifier`]: the other place a handshake waits on a person.

use async_trait::async_trait;
use zeroize::Zeroizing;

/// One thing the server wants filled in.
#[derive(Debug, Clone)]
pub struct AuthPromptField {
    /// The server's wording, e.g. `"Password: "`, shown verbatim: it's what tells
    /// a password from a TOTP code or a PIN.
    pub prompt: String,
    /// Whether the response may be shown; `false` means mask it.
    pub echo: bool,
}

/// One round of keyboard-interactive auth.
#[derive(Debug, Clone)]
pub struct AuthPrompt {
    /// The server's title ("Duo two-factor login"). Often empty, in which case
    /// the UI supplies one.
    pub name: String,
    /// Free text shown above the fields. Also often empty.
    pub instructions: String,
    /// What to ask, in order; responses come back in the same order and number.
    /// A round with no fields (only `name`/`instructions`) is answered without
    /// reaching the prompter.
    pub fields: Vec<AuthPromptField>,
    /// Which host is asking, and whether it's the jump hop, so a user doesn't
    /// type the target's password into the bastion.
    pub host: String,
    pub port: u16,
    pub is_jump: bool,
}

/// Answers the server's questions by asking a person. Implemented in the app
/// by a dialog. Like [`crate::HostKeyVerifier`], a negative answer aborts the
/// connection.
#[async_trait]
pub trait AuthPrompter: Send + Sync {
    /// One response per field, in order, or `None` if the user canceled (which
    /// abandons authentication). `Zeroizing`, like [`crate::AuthMethod`]; russh
    /// takes an owned `Vec<String>`, so one copy leaves our control, as with
    /// `authenticate_password`.
    async fn prompt(&self, prompt: AuthPrompt) -> Option<Zeroizing<Vec<String>>>;
}

/// A prompter that cancels everything: the safe default for tests.
pub struct DenyAll;

#[async_trait]
impl AuthPrompter for DenyAll {
    async fn prompt(&self, _prompt: AuthPrompt) -> Option<Zeroizing<Vec<String>>> {
        None
    }
}
