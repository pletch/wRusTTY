//! Writing to a remote terminal at a rate it can survive.
//!
//! Shared by every transport whose bytes land in a pty on the far side, which
//! today means `wr-ssh` and `wr-telnet`. It lives here rather than in either of
//! them because the hazard is a property of the *remote terminal*, not of the
//! protocol carrying the bytes, and two copies of that reasoning would be two
//! places for it to drift.

use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};

/// How much of one write is handed to the transport before pausing, and how
/// long the pause is.
///
/// Nothing in a terminal protocol says the far end has stopped reading. The
/// remote line discipline holds a fixed input buffer -- 4096 bytes on Linux,
/// and `MAX_CANON` is 4096 again for a canonical-mode line -- and when it
/// fills, the tty *discards* what will not fit. No error comes back, because as
/// far as the protocol is concerned the bytes were delivered. That is the whole
/// failure: a paste arrives with a hole in the middle of it and nothing
/// anywhere reports a fault.
///
/// A paste reaches a writer task as one buffer -- the frontend encodes it in a
/// single call and hands it over whole -- so writing it as it arrives means a
/// multi-kilobyte burst at whatever rate the transport will take. Spending a
/// couple of milliseconds per kilobyte instead gives the remote reader room to
/// drain between runs.
///
/// Deliberately far below the buffer it protects: 1 KiB against 4 KiB leaves
/// margin for a reader that is slow rather than stopped -- readline redrawing a
/// long line, an editor highlighting as it goes. The ceiling this imposes,
/// around half a megabyte a second, is above any paste a person makes and below
/// any rate that overruns a tty.
///
/// Typing never reaches the split: a keystroke is a handful of bytes, takes the
/// single-chunk path, and pauses for nothing.
///
/// This is a mitigation and not a guarantee, for the reason at the top -- there
/// is no signal to wait on, only a rate to stay under.
pub const WRITE_CHUNK: usize = 1024;

/// See [`WRITE_CHUNK`].
pub const WRITE_CHUNK_PAUSE: Duration = Duration::from_millis(2);

/// Writes `data` in [`WRITE_CHUNK`]-sized runs, pausing between them.
///
/// Generic over the sink rather than written against one transport's writer, so
/// both callers share it and the pacing can be tested for what it actually
/// promises -- every byte, in order, no run larger than the chunk -- without a
/// server to send it to.
pub async fn write_paced<W: AsyncWrite + Unpin>(
    writer: &mut W,
    data: &[u8],
) -> std::io::Result<()> {
    // An empty write still flushes, which is what the straight-through writes
    // this replaces did before there was a loop here to skip.
    if data.is_empty() {
        return writer.flush().await;
    }
    let mut chunks = data.chunks(WRITE_CHUNK).peekable();
    while let Some(chunk) = chunks.next() {
        writer.write_all(chunk).await?;
        writer.flush().await?;
        // After the last chunk there is nothing left to make room for, and
        // pausing there would delay the next keystroke behind a finished paste.
        if chunks.peek().is_some() {
            tokio::time::sleep(WRITE_CHUNK_PAUSE).await;
        }
    }
    Ok(())
}

/// What the pacing promises, pinned against a sink that records where every run
/// began and ended.
///
/// The property that matters is not visible from a transport writer's side: the
/// bytes always arrive whole and in order, and always did. What changed is the
/// *rate*, and the failure it guards against -- a remote tty silently dropping
/// what overruns its 4 KiB input buffer -- reports nothing at all. So the run
/// boundaries are asserted here, where they can be seen.
#[cfg(test)]
mod write_pacing_tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    /// A sink that keeps each write as its own entry. `Vec<u8>` would prove the
    /// bytes survive but say nothing about how they were handed over, which is
    /// the whole subject here.
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

    /// Typing is the common case and must be untouched: one write, one flush,
    /// and no pause to sit through before the character appears.
    #[tokio::test(start_paused = true)]
    async fn a_keystroke_goes_out_in_one_run_with_no_pause() {
        let mut sink = RunRecorder::default();
        let start = tokio::time::Instant::now();
        write_paced(&mut sink, b"x").await.unwrap();
        assert_eq!(sink.runs, vec![b"x".to_vec()]);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    /// The paste this exists for. Every byte arrives, in order, and no single
    /// run is large enough to overrun the buffer on the far side.
    #[tokio::test(start_paused = true)]
    async fn a_large_paste_arrives_whole_in_order_and_in_bounded_runs() {
        // Deliberately not a multiple of the chunk: the last run is a partial
        // one, and dropping or padding it is a plausible way to get this wrong.
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
        // Each run is pushed out on its own rather than left for the sink to
        // batch back into the burst this is breaking up.
        assert_eq!(sink.flushes, sink.runs.len());
    }

    /// The point of the exercise: the runs are spread out in time. Without the
    /// pause every assertion above still holds and the remote tty still
    /// overflows, so this is the one that would catch the pacing being lost.
    #[tokio::test(start_paused = true)]
    async fn the_runs_of_a_paste_are_spread_out_in_time() {
        let paste = vec![b'a'; WRITE_CHUNK * 4];
        let start = tokio::time::Instant::now();
        let mut sink = RunRecorder::default();
        write_paced(&mut sink, &paste).await.unwrap();

        // Four runs, three gaps -- the last chunk is not followed by a wait.
        assert_eq!(start.elapsed(), WRITE_CHUNK_PAUSE * 3);
    }

    /// A telnet reply (option negotiation, terminal type, NAWS) shares the
    /// write channel with typing and pastes, and every one of them is a handful
    /// of bytes. None of them should ever wait.
    #[tokio::test(start_paused = true)]
    async fn a_protocol_reply_is_never_paced() {
        let mut sink = RunRecorder::default();
        let start = tokio::time::Instant::now();
        // IAC WILL NAWS, as long a reply as negotiation produces.
        write_paced(&mut sink, &[0xff, 0xfb, 0x1f]).await.unwrap();
        assert_eq!(sink.runs.len(), 1);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    /// Preserved behaviour rather than a property worth having: the old
    /// straight-through write flushed whatever it was handed, empty included.
    #[tokio::test(start_paused = true)]
    async fn an_empty_write_still_flushes() {
        let mut sink = RunRecorder::default();
        write_paced(&mut sink, b"").await.unwrap();
        assert!(sink.runs.is_empty());
        assert_eq!(sink.flushes, 1);
    }
}
