//! Relaying the server's own authentication questions to a human.
//!
//! Keyboard-interactive (RFC 4256) is the method where the *server* decides
//! what to ask: "Password:", then "Verification code:", then whatever a PAM
//! stack feels like. Nothing about the exchange is known at connect time, so
//! unlike every other variant of [`crate::AuthMethod`] there is no credential
//! to hand over up front — the connection has to stop mid-handshake and ask.
//!
//! Shaped deliberately like [`crate::HostKeyVerifier`]: a trait this crate
//! calls and the caller implements, backed in the app by a real dialog. The
//! two are the only places an SSH handshake blocks on a person.

use async_trait::async_trait;
use zeroize::Zeroizing;

/// One thing the server wants filled in.
#[derive(Debug, Clone)]
pub struct AuthPromptField {
    /// The server's own wording, e.g. `"Password: "`. Displayed verbatim —
    /// it is the only thing distinguishing a password from a TOTP code from
    /// a PIN, and rewording it would be guessing at a PAM stack we can't see.
    pub prompt: String,
    /// Whether the typed response may be shown on screen. `false` is the
    /// server saying "this is a secret", and is what the UI masks on.
    pub echo: bool,
}

/// One round of keyboard-interactive auth: everything the UI needs to render
/// the question the server is asking right now.
#[derive(Debug, Clone)]
pub struct AuthPrompt {
    /// The server's title for the exchange — "Duo two-factor login" and
    /// friends. Often empty, in which case the UI supplies its own heading.
    pub name: String,
    /// Free text shown above the fields. Also often empty.
    pub instructions: String,
    /// What to ask, in order. The responses must come back in the same order
    /// and the same number.
    ///
    /// Legitimately empty: a server is allowed to send a round with nothing
    /// to fill in purely to display `name`/`instructions`. That case is
    /// answered without troubling the user, so a prompter never sees it.
    pub fields: Vec<AuthPromptField>,
    /// Which host is asking, and whether it is the jump hop rather than the
    /// session's real destination. A jump connection authenticates twice, and
    /// a prompt that doesn't say which end it came from is an invitation to
    /// type the target's password into the bastion.
    pub host: String,
    pub port: u16,
    pub is_jump: bool,
}

/// Answers the server's questions, by asking a human.
///
/// Implemented by the caller (in the app, `src-tauri`'s command layer, backed
/// by a real prompt dialog). Sibling of [`crate::HostKeyVerifier`]; like it, a
/// negative answer aborts the connection and never falls through to trying
/// something else.
#[async_trait]
pub trait AuthPrompter: Send + Sync {
    /// Returns one response per field of `prompt`, in order, or `None` if the
    /// user cancelled — which abandons authentication rather than retrying it
    /// blind.
    ///
    /// Wrapped in `Zeroizing` for the same reason [`crate::AuthMethod`] is
    /// `ZeroizeOnDrop`: these are live passwords and one-time codes, and the
    /// copy this crate holds shouldn't be the one left in freed heap. russh
    /// takes an owned `Vec<String>` to send, so one copy does pass out of
    /// reach — exactly as it already does for `authenticate_password`.
    async fn prompt(&self, prompt: AuthPrompt) -> Option<Zeroizing<Vec<String>>>;
}

/// A prompter that cancels every prompt. The safe default, and what tests
/// that should never reach an interactive round get.
pub struct DenyAll;

#[async_trait]
impl AuthPrompter for DenyAll {
    async fn prompt(&self, _prompt: AuthPrompt) -> Option<Zeroizing<Vec<String>>> {
        None
    }
}
