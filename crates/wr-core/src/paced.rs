//! Writing to a remote terminal at a rate it can survive. Shared by `wr-ssh`
//! and `wr-telnet`, since the hazard belongs to the remote tty, not the
//! protocol.

use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};

/// How much of one write goes to the transport before pausing, and how long
/// the pause is.
///
/// A remote line discipline holds a fixed input buffer (4096 bytes on Linux,
/// and `MAX_CANON` for a canonical line) and silently discards what won't fit;
/// the protocol reports success. A paste arrives as one buffer, so writing it
/// straight through can leave a hole in the middle.
///
/// 1 KiB against 4 KiB leaves margin for a slow reader (readline redrawing,
/// an editor highlighting). The resulting ceiling, about half a megabyte a
/// second, is above any human paste. Typing takes the single-chunk path. A
/// mitigation, not a guarantee: there's no signal to wait on.
pub const WRITE_CHUNK: usize = 1024;

/// See [`WRITE_CHUNK`].
pub const WRITE_CHUNK_PAUSE: Duration = Duration::from_millis(2);

/// Writes `data` in [`WRITE_CHUNK`]-sized runs, pausing between them. Generic
/// over the sink so the pacing can be tested without a server.
pub async fn write_paced<W: AsyncWrite + Unpin>(
    writer: &mut W,
    data: &[u8],
) -> std::io::Result<()> {
    // An empty write still flushes, as the straight-through writes did.
    if data.is_empty() {
        return writer.flush().await;
    }
    let mut chunks = data.chunks(WRITE_CHUNK).peekable();
    while let Some(chunk) = chunks.next() {
        writer.write_all(chunk).await?;
        writer.flush().await?;
        // No pause after the last chunk, which would delay the next keystroke.
        if chunks.peek().is_some() {
            tokio::time::sleep(WRITE_CHUNK_PAUSE).await;
        }
    }
    Ok(())
}

/// Pins the run boundaries, since the failure (a remote tty dropping overrun
/// bytes) reports nothing.
#[cfg(test)]
mod write_pacing_tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    /// A sink that keeps each write separately; `Vec<u8>` would hide how bytes
    /// were handed over.
    #[derive(Default)]
    struct RunRecorder {
        runs: Vec<Vec<u8>>,
        flushes: usize,
    }

    impl AsyncWrite for RunRecorder {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.runs.push(buf.to_vec());
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.flushes += 1;
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// Typing is untouched: one write, one flush, no pause.
    #[tokio::test(start_paused = true)]
    async fn a_keystroke_goes_out_in_one_run_with_no_pause() {
        let mut sink = RunRecorder::default();
        let start = tokio::time::Instant::now();
        write_paced(&mut sink, b"x").await.unwrap();
        assert_eq!(sink.runs, vec![b"x".to_vec()]);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    /// A paste: every byte arrives in order, with no run larger than a chunk.
    #[tokio::test(start_paused = true)]
    async fn a_large_paste_arrives_whole_in_order_and_in_bounded_runs() {
        // Not a multiple of the chunk, so the partial last run is exercised.
        let paste: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let mut sink = RunRecorder::default();
        write_paced(&mut sink, &paste).await.unwrap();

        assert_eq!(
            sink.runs.concat(),
            paste,
            "bytes must arrive whole and in order"
        );
        assert!(
            sink.runs.iter().all(|run| run.len() <= WRITE_CHUNK),
            "no run may exceed the chunk the remote buffer is sized against",
        );
        assert_eq!(sink.runs.len(), 10, "9 full chunks and a partial one");
        // Each run is flushed on its own rather than re-batched.
        assert_eq!(sink.flushes, sink.runs.len());
    }

    /// The runs are spread out in time; without the pause, only this fails.
    #[tokio::test(start_paused = true)]
    async fn the_runs_of_a_paste_are_spread_out_in_time() {
        let paste = vec![b'a'; WRITE_CHUNK * 4];
        let start = tokio::time::Instant::now();
        let mut sink = RunRecorder::default();
        write_paced(&mut sink, &paste).await.unwrap();

        // Four runs, three gaps.
        assert_eq!(start.elapsed(), WRITE_CHUNK_PAUSE * 3);
    }

    /// Telnet replies (negotiation, terminal type, NAWS) are tiny and never wait.
    #[tokio::test(start_paused = true)]
    async fn a_protocol_reply_is_never_paced() {
        let mut sink = RunRecorder::default();
        let start = tokio::time::Instant::now();
        // IAC WILL NAWS, as long as negotiation replies get.
        write_paced(&mut sink, &[0xff, 0xfb, 0x1f]).await.unwrap();
        assert_eq!(sink.runs.len(), 1);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    /// An empty write still flushes, as before.
    #[tokio::test(start_paused = true)]
    async fn an_empty_write_still_flushes() {
        let mut sink = RunRecorder::default();
        write_paced(&mut sink, b"").await.unwrap();
        assert!(sink.runs.is_empty());
        assert_eq!(sink.flushes, 1);
    }
}
