//! The messages an elevated host and its tab exchange over their pipe.
//!
//! Every message is a frame: one type byte, a little-endian `u32` payload
//! length, and the payload. The format is the same in both directions; which
//! types each side may *send* is enforced by the side receiving them, not
//! here, so this module stays a plain codec.
//!
//! What the protocol deliberately cannot say matters more than what it can.
//! No message names a program, a path, an argument or an environment
//! variable: the host is told what to run on its command line, at the moment
//! the UAC prompt is approved, and nothing arriving over the pipe afterwards
//! can change that. See decision 2 in `docs/ELEVATED_TABS_PLAN.md`.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The most a single frame may carry. Output is read from the pseudoconsole in
/// 32 KiB chunks and input is keystrokes, so anything near this is either a
/// paste of unusual size or not a well-behaved peer. Checked *before*
/// allocating, so a hostile length cannot make the reader reserve gigabytes.
pub const MAX_PAYLOAD: u32 = 1024 * 1024;

const READY: u8 = 1;
const DATA: u8 = 2;
const RESIZE: u8 = 3;
const EXIT: u8 = 4;
const ERROR: u8 = 5;

/// One message. See the plan's protocol table for which side sends which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// Host → tab: the shell has started and output will follow.
    Ready,
    /// Both ways: shell output one way; keystrokes, pastes and terminal query
    /// replies the other. Opaque bytes — nothing inspects them in transit.
    Data(Vec<u8>),
    /// Tab → host. Also the tab's first message: a pseudoconsole is given its
    /// size when it is created, and the pane may have been resized while the
    /// user was reading the UAC prompt, so the host waits for this rather than
    /// taking a size from its command line.
    Resize { cols: u16, rows: u16 },
    /// Host → tab: the shell has exited. Carries no code because the code has
    /// already arrived as `Data` — the host relays `wr-local`'s own
    /// "[process exited with code N]" line like any other output.
    Exit,
    /// Host → tab: the shell could not be started, and why.
    Error(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("frame type {0} is not part of the protocol")]
    UnknownType(u8),
    #[error("frame of {0} bytes exceeds the {MAX_PAYLOAD}-byte limit")]
    TooLarge(u32),
    #[error("frame type {kind} carried {len} bytes, which is not a valid length for it")]
    BadLength { kind: u8, len: u32 },
    #[error("error message was not valid UTF-8")]
    BadText,
    /// The stream ended part-way through a frame. Distinct from a clean end
    /// between frames, which `read_frame` reports as `Ok(None)`.
    #[error("the pipe closed in the middle of a frame")]
    Truncated,
    #[error(transparent)]
    Io(std::io::Error),
}

impl Frame {
    /// The frame as it goes on the wire.
    pub fn encode(&self) -> Vec<u8> {
        let (kind, payload): (u8, Vec<u8>) = match self {
            Frame::Ready => (READY, Vec::new()),
            Frame::Data(bytes) => (DATA, bytes.clone()),
            Frame::Resize { cols, rows } => {
                let mut p = Vec::with_capacity(4);
                p.extend_from_slice(&cols.to_le_bytes());
                p.extend_from_slice(&rows.to_le_bytes());
                (RESIZE, p)
            }
            Frame::Exit => (EXIT, Vec::new()),
            Frame::Error(message) => (ERROR, message.as_bytes().to_vec()),
        };
        let mut out = Vec::with_capacity(5 + payload.len());
        out.push(kind);
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }

    fn decode(kind: u8, payload: Vec<u8>) -> Result<Frame, ProtocolError> {
        let len = payload.len() as u32;
        let bad = || ProtocolError::BadLength { kind, len };
        match kind {
            READY if payload.is_empty() => Ok(Frame::Ready),
            READY => Err(bad()),
            DATA => Ok(Frame::Data(payload)),
            RESIZE if payload.len() == 4 => Ok(Frame::Resize {
                cols: u16::from_le_bytes([payload[0], payload[1]]),
                rows: u16::from_le_bytes([payload[2], payload[3]]),
            }),
            RESIZE => Err(bad()),
            EXIT if payload.is_empty() => Ok(Frame::Exit),
            EXIT => Err(bad()),
            ERROR => String::from_utf8(payload)
                .map(Frame::Error)
                .map_err(|_| ProtocolError::BadText),
            other => Err(ProtocolError::UnknownType(other)),
        }
    }
}

/// Reads one frame. `Ok(None)` means the peer closed the pipe cleanly between
/// frames, which is how both sides say they are finished.
///
/// Not cancel-safe: dropping the future part-way through loses the bytes it
/// had read. Callers that need to `select!` on incoming frames should read
/// them on a task of their own and select on a channel instead.
pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Frame>, ProtocolError> {
    let mut header = [0u8; 5];
    // The first byte distinguishes "closed between frames" from "closed
    // mid-frame", so it is read on its own.
    match reader.read(&mut header[..1]).await {
        Ok(0) => return Ok(None),
        Ok(_) => {}
        Err(e) if is_closed(&e) => return Ok(None),
        Err(e) => return Err(ProtocolError::Io(e)),
    }
    read_exact(reader, &mut header[1..]).await?;

    let kind = header[0];
    let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);
    if len > MAX_PAYLOAD {
        return Err(ProtocolError::TooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    read_exact(reader, &mut payload).await?;
    Frame::decode(kind, payload).map(Some)
}

/// Writes one frame and flushes it, so a frame is never left sitting in a
/// buffer while the peer waits on it.
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &Frame,
) -> Result<(), ProtocolError> {
    writer
        .write_all(&frame.encode())
        .await
        .map_err(ProtocolError::Io)?;
    writer.flush().await.map_err(ProtocolError::Io)
}

async fn read_exact<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<(), ProtocolError> {
    match reader.read_exact(buf).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof || is_closed(&e) => {
            Err(ProtocolError::Truncated)
        }
        Err(e) => Err(ProtocolError::Io(e)),
    }
}

/// A named pipe whose peer has gone away reports it as an error rather than as
/// a zero-length read — `ERROR_BROKEN_PIPE` (109) on the server side,
/// `ERROR_PIPE_NOT_CONNECTED` (233) on the client's. Both mean "the other end
/// is finished", which is the same thing a zero-length read means elsewhere.
fn is_closed(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::BrokenPipe || matches!(e.raw_os_error(), Some(109 | 233))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn roundtrip(frame: Frame) -> Frame {
        let bytes = frame.encode();
        let mut reader = &bytes[..];
        read_frame(&mut reader).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn every_frame_survives_a_round_trip() {
        for frame in [
            Frame::Ready,
            Frame::Data(b"hello\x1b[6n".to_vec()),
            Frame::Data(Vec::new()),
            Frame::Resize {
                cols: 132,
                rows: 43,
            },
            Frame::Exit,
            Frame::Error("no such executable".into()),
        ] {
            assert_eq!(roundtrip(frame.clone()).await, frame);
        }
    }

    #[tokio::test]
    async fn a_clean_close_between_frames_is_not_an_error() {
        let mut empty: &[u8] = &[];
        assert!(read_frame(&mut empty).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn frames_are_read_back_to_back() {
        let mut bytes = Frame::Ready.encode();
        bytes.extend(Frame::Data(b"x".to_vec()).encode());
        let mut reader = &bytes[..];
        assert_eq!(read_frame(&mut reader).await.unwrap(), Some(Frame::Ready));
        assert_eq!(
            read_frame(&mut reader).await.unwrap(),
            Some(Frame::Data(b"x".to_vec()))
        );
        assert!(read_frame(&mut reader).await.unwrap().is_none());
    }

    /// A pipe closing mid-frame is a broken peer, not a finished one.
    #[tokio::test]
    async fn a_close_mid_frame_is_truncated() {
        let bytes = Frame::Data(b"hello".to_vec()).encode();
        let mut reader = &bytes[..bytes.len() - 2];
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(ProtocolError::Truncated)
        ));
    }

    /// Checked before allocating: a hostile length must not reserve memory.
    #[tokio::test]
    async fn an_oversized_length_is_refused_before_allocating() {
        let mut bytes = vec![DATA];
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        let mut reader = &bytes[..];
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(ProtocolError::TooLarge(u32::MAX))
        ));
    }

    #[tokio::test]
    async fn an_unknown_type_is_refused() {
        let bytes = [99u8, 0, 0, 0, 0];
        let mut reader = &bytes[..];
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(ProtocolError::UnknownType(99))
        ));
    }

    /// Fixed-size frames must be exactly their size, so a malformed peer is
    /// caught rather than misread.
    #[tokio::test]
    async fn a_resize_of_the_wrong_length_is_refused() {
        let bytes = [RESIZE, 3, 0, 0, 0, 1, 2, 3];
        let mut reader = &bytes[..];
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(ProtocolError::BadLength {
                kind: RESIZE,
                len: 3
            })
        ));
    }

    #[tokio::test]
    async fn an_error_that_is_not_utf8_is_refused() {
        let bytes = [ERROR, 1, 0, 0, 0, 0xff];
        let mut reader = &bytes[..];
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(ProtocolError::BadText)
        ));
    }
}
