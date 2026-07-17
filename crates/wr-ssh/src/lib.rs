//! SSH transport: auth (password, public key, keyboard-interactive), key
//! exchange, known-host TOFU verification, PTY channels, port forwarding.
//! Built on `russh`.

mod config;
mod error;
mod forward;
mod handler;
mod known_hosts;
mod session;
mod socks;

pub use config::{AuthMethod, SshConfig};
pub use error::SshError;
pub use forward::{ForwardHandle, ForwardSpec};
pub use handler::{HostKeyPrompt, HostKeyVerifier, RejectAll};
pub use known_hosts::{HostKeyStatus, KnownHostsStore};
pub use session::{expand_tilde, parse_private_key, SshSession};
