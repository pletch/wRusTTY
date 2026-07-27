//! Telnet transport (RFC 854) with option negotiation for ECHO,
//! SUPPRESS-GO-AHEAD, TERMINAL-TYPE, and NAWS — hand-rolled since the
//! protocol subset we need is small.

mod config;
mod error;
mod protocol;
mod session;

pub use config::{TelnetConfig, DEFAULT_TERM_TYPE};
pub use error::TelnetError;
pub use session::{TelnetConnector, TelnetSession};
