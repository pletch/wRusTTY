//! Shared session model, the protocol-agnostic `Connector`/`Session`
//! traits, and
//! event types used by every transport crate (`wr-ssh`, `wr-telnet`,
//! `wr-serial`) and by `src-tauri`.

mod connection;
mod events;
mod paced;
mod session;

pub use connection::{Connector, Session};
pub use events::{ConnectionEvent, ConnectionStatus, DisconnectKind};
pub use paced::{write_paced, WRITE_CHUNK, WRITE_CHUNK_PAUSE};
pub use session::{Protocol, SessionId};
