//! SFTP/SCP file operations and remote file editing support.
//! Built on `russh-sftp`.

mod client;
mod error;

pub use client::{RemoteEntry, RemoteStat, SftpClient, Transferred};
pub use error::SftpError;
