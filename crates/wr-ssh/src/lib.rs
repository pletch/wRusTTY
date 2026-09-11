//! SSH transport: auth (password, public key, keyboard-interactive), key
//! exchange, known-host TOFU verification, PTY channels, port forwarding.
//! Built on `russh`.

mod config;
mod error;
mod forward;
mod handler;
mod known_hosts;
mod prompt;
mod proxy;
mod session;
mod socks;
mod sudo;

pub use config::{AuthMethod, SshConfig};
pub use error::SshError;
pub use forward::{is_loopback_bind_host, ForwardHandle, ForwardSpec};
pub use handler::{HostKeyPrompt, HostKeyVerifier, RejectAll};
pub use known_hosts::{HostKeyStatus, KnownHostEntry, KnownHostsStore};
pub use prompt::{AuthPrompt, AuthPromptField, AuthPrompter, DenyAll};
pub use proxy::{ProxyConfig, ProxyError, ProxyKind};
pub use session::{expand_tilde, parse_private_key, SshConnector, SshSession};
pub use sudo::{SudoError, SudoRunner, SudoWriter};
