//! Administrator shells in an ordinary window's tab.
//!
//! A pseudoconsole cannot be handed to an elevated process, so the elevated
//! side has to own it: `wrustty.exe`, relaunched through UAC into a windowless
//! host mode, runs the shell on the ordinary `LocalConnector` and relays it to
//! the tab over a named pipe. See `docs/ELEVATED_TABS_PLAN.md`.
//!
//! - [`protocol`] is the frame format both ends speak. Portable, and tested
//!   without any pipe at all.
//! - [`connector`] is the tab's end: a `Connector`/`Session` that launches a
//!   host through an injected launcher and relays to it.
//! - [`host`] is the elevated end. It needs no elevation of its own to work —
//!   it runs as whatever launched it — which is what lets the whole relay be
//!   tested unelevated, over a real pipe.

pub mod protocol;

#[cfg(windows)]
pub mod connector;
#[cfg(windows)]
pub mod host;
