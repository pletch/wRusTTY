//! Local shell transport: a process on this machine, on a Windows
//! pseudoconsole (ConPTY), behind the same `Connector`/`Session` contract
//! every remote transport implements.
//!
//! The shape differs from `wr-ssh`, `wr-telnet` and `wr-serial` in two ways
//! worth knowing before reading `session.rs`:
//!
//! - `resize` is real work here. Telnet sends NAWS and serial's is a
//!   documented no-op; this one calls `ResizePseudoConsole`, and getting it
//!   wrong is immediately visible because every full-screen program repaints
//!   against the size it reads back.
//! - The session ends *by itself*. Every other transport ends because
//!   something external went away; here the child exits, and its exit code is
//!   information the user wants rather than noise to swallow.
//!
//! See `docs/LOCAL_SHELL_PLAN.md` for the decisions this crate is built to.

mod config;
mod error;
mod session;

pub use config::LocalConfig;
pub use error::LocalError;
pub use session::{LocalConnector, LocalSession};
