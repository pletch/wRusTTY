//! Local shell transport: a process on this machine, on a Windows
//! pseudoconsole (ConPTY), behind the same `Connector`/`Session` contract
//! every remote transport implements.
//!
//! Two differences from the other transports:
//!
//! - `resize` is real work: `ResizePseudoConsole`, which every full-screen
//!   program reads back.
//! - The session ends by itself when the child exits, and its exit code
//!   matters to the user.
//!
//! See `docs/LOCAL_SHELL_PLAN.md` for the decisions this crate is built to.

mod config;
pub mod elevated;
mod error;
mod session;

pub use config::LocalConfig;
pub use error::LocalError;
pub use session::{LocalConnector, LocalSession};
