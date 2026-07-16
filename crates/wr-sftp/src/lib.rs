//! SFTP/SCP file operations and remote file editing support.
//! Built on `russh-sftp`.

mod client;
mod error;

pub use client::{RemoteEntry, SftpClient};
pub use error::SftpError;
