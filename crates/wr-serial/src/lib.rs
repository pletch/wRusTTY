//! Serial transport: port enumeration, baud/data/parity/stop/flow control,
//! DTR/RTS toggles, break signalling, local echo, and line-ending
//! translation. Built on `tokio-serial`.

mod config;
mod error;
mod ports;
mod session;

pub use config::{DataBits, FlowControl, LineEnding, Parity, SerialConfig, StopBits};
pub use error::SerialError;
pub use ports::{list_ports, resolve, PortIdentity, PortInfo, Resolved, UsbIdentity};
pub use session::{SerialConnector, SerialSession, DEFAULT_BREAK};
