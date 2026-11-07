//! What a new webview needs to bring back a session whose connection outlived the
//! old one: the last terminal snapshot, and everything that happened since. See
//! `docs/ANDROID_PLAN.md`, "Restoring a terminal".
//!
//! Positions count the session's output bytes from the start. A snapshot says which
//! position it was taken at, and that's where replay picks up, so a cut can land
//! anywhere, even inside an escape sequence: the snapshot carries the bytes so far.
//!
//! All of this is screen contents, which can include anything displayed, so it's
//! wiped when released rather than left for the allocator.

use std::collections::VecDeque;

use zeroize::Zeroize;

/// What to do, in order, to catch a restored terminal up.
#[derive(Debug, PartialEq, Eq)]
pub enum Replay {
    Output(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

/// A catch-up. `gap` means the buffer overflowed since the snapshot, so `events`
/// starts partway through: the screen may be wrong until a program repaints, and
/// output was lost, which is worth saying.
#[derive(Debug, PartialEq, Eq)]
pub struct CatchUp {
    pub events: Vec<Replay>,
    pub gap: bool,
    /// Where live output carries on from.
    pub position: u64,
}

enum Entry {
    Output { start: u64, bytes: Vec<u8> },
    Resize { at: u64, cols: u16, rows: u16 },
}

impl Drop for Entry {
    fn drop(&mut self) {
        if let Entry::Output { bytes, .. } = self {
            bytes.zeroize();
        }
    }
}

pub struct KeptSnapshot {
    pub position: u64,
    pub bytes: Vec<u8>,
}

impl Drop for KeptSnapshot {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

pub struct SessionKeep {
    entries: VecDeque<Entry>,
    /// Output bytes held in `entries`.
    held: usize,
    max_held: usize,
    /// The position after the last byte seen.
    position: u64,
    /// Nothing before this is kept. Moves when a snapshot releases older output,
    /// and when overflow drops it.
    kept_from: u64,
    /// The size in force before the first of `entries`. Without it, output after a
    /// snapshot would replay at whatever size the new terminal happens to be, and a
    /// program's cursor moves would land on the wrong rows.
    base_size: Option<(u16, u16)>,
    snapshot: Option<KeptSnapshot>,
}

impl SessionKeep {
    pub fn new(max_held: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            held: 0,
            max_held,
            position: 0,
            kept_from: 0,
            base_size: None,
            snapshot: None,
        }
    }

    pub fn position(&self) -> u64 {
        self.position
    }

    pub fn push_output(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.entries.push_back(Entry::Output {
            start: self.position,
            bytes: bytes.to_vec(),
        });
        self.held += bytes.len();
        self.position += bytes.len() as u64;
        self.enforce_limit();
    }

    /// A resize at the current position, so output replays at the size it was
    /// written for.
    pub fn push_resize(&mut self, cols: u16, rows: u16) {
        self.entries.push_back(Entry::Resize {
            at: self.position,
            cols,
            rows,
        });
    }

    fn enforce_limit(&mut self) {
        while self.held > self.max_held {
            let Some(front) = self.entries.pop_front() else {
                return;
            };
            match &front {
                Entry::Output { start, bytes } => {
                    self.held -= bytes.len();
                    self.kept_from = start + bytes.len() as u64;
                }
                Entry::Resize { cols, rows, .. } => self.base_size = Some((*cols, *rows)),
            }
        }
    }

    /// Replaces the snapshot and releases the output it covers. Refuses one older
    /// than what's held, which a slow transfer could otherwise overwrite a newer
    /// one with, or one from a position that hasn't happened.
    pub fn put_snapshot(&mut self, position: u64, bytes: Vec<u8>) -> bool {
        let older = self
            .snapshot
            .as_ref()
            .is_some_and(|s| position < s.position);
        if older || position > self.position {
            let mut bytes = bytes;
            bytes.zeroize();
            return false;
        }
        self.snapshot = Some(KeptSnapshot { position, bytes });
        self.release_before(position);
        true
    }

    fn release_before(&mut self, position: u64) {
        while let Some(front) = self.entries.front() {
            match front {
                Entry::Resize { at, cols, rows } if *at < position => {
                    self.base_size = Some((*cols, *rows));
                }
                Entry::Output { start, bytes } if start + (bytes.len() as u64) <= position => {
                    self.held -= bytes.len();
                }
                _ => break,
            }
            self.entries.pop_front();
        }
        self.kept_from = self.kept_from.max(position);
    }

    pub fn snapshot(&self) -> Option<&KeptSnapshot> {
        self.snapshot.as_ref()
    }

    /// Everything after the snapshot, or after `from` when there's none.
    pub fn catch_up(&self) -> CatchUp {
        let from = self.snapshot.as_ref().map_or(0, |s| s.position);
        let mut events = Vec::new();
        if let Some((cols, rows)) = self.base_size {
            events.push(Replay::Resize { cols, rows });
        }
        for entry in &self.entries {
            match entry {
                Entry::Resize { at, cols, rows } if *at >= from => events.push(Replay::Resize {
                    cols: *cols,
                    rows: *rows,
                }),
                Entry::Output { start, bytes } => {
                    let end = start + bytes.len() as u64;
                    if end <= from {
                        continue;
                    }
                    // A snapshot can land inside an entry, wherever a read ended.
                    let skip = from.saturating_sub(*start) as usize;
                    events.push(Replay::Output(bytes[skip..].to_vec()));
                }
                Entry::Resize { .. } => {}
            }
        }
        CatchUp {
            events,
            gap: self.kept_from > from,
            position: self.position,
        }
    }
}

impl SessionKeep {
    /// The output since `position`, for a terminal still up that missed some. No
    /// resizes, since it's already at its size.
    pub fn catch_up_from(&self, position: u64) -> CatchUp {
        let mut events = Vec::new();
        for entry in &self.entries {
            if let Entry::Output { start, bytes } = entry {
                let end = start + bytes.len() as u64;
                if end > position {
                    let skip = position.saturating_sub(*start) as usize;
                    events.push(Replay::Output(bytes[skip..].to_vec()));
                }
            }
        }
        CatchUp {
            events,
            gap: self.kept_from > position,
            position: self.position,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(c: &CatchUp) -> Vec<u8> {
        c.events
            .iter()
            .filter_map(|e| match e {
                Replay::Output(b) => Some(b.as_slice()),
                Replay::Resize { .. } => None,
            })
            .flatten()
            .copied()
            .collect()
    }

    #[test]
    fn catches_up_with_everything_when_there_is_no_snapshot_yet() {
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"hello ");
        keep.push_output(b"world");
        let c = keep.catch_up();
        assert_eq!(output(&c), b"hello world");
        assert!(!c.gap);
        assert_eq!(c.position, 11);
    }

    #[test]
    fn a_snapshot_releases_what_it_covers() {
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"old");
        keep.push_output(b"new");
        assert!(keep.put_snapshot(3, b"snap".to_vec()));
        assert_eq!(keep.held, 3);
        assert_eq!(output(&keep.catch_up()), b"new");
        assert_eq!(keep.snapshot().unwrap().bytes, b"snap");
    }

    #[test]
    fn a_snapshot_can_land_inside_a_read() {
        // Reads end wherever they end, and the webview writes what it has.
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"abcdef");
        assert!(keep.put_snapshot(2, b"snap".to_vec()));
        assert_eq!(output(&keep.catch_up()), b"cdef");
        assert_eq!(keep.held, 6);
    }

    /// Otherwise the first output replays at the new terminal's size, not its own.
    #[test]
    fn starts_from_the_size_in_force_at_the_snapshot() {
        let mut keep = SessionKeep::new(1024);
        keep.push_resize(48, 42);
        keep.push_output(b"old");
        keep.put_snapshot(3, b"snap".to_vec());
        keep.push_output(b"new");
        assert_eq!(
            keep.catch_up().events,
            vec![
                Replay::Resize { cols: 48, rows: 42 },
                Replay::Output(b"new".to_vec()),
            ]
        );
    }

    #[test]
    fn a_later_snapshot_carries_the_size_forward() {
        let mut keep = SessionKeep::new(1024);
        keep.push_resize(48, 42);
        keep.push_output(b"a");
        keep.put_snapshot(1, b"s".to_vec());
        keep.push_output(b"b");
        keep.put_snapshot(2, b"s".to_vec());
        assert_eq!(
            keep.catch_up().events,
            vec![Replay::Resize { cols: 48, rows: 42 }]
        );
    }

    #[test]
    fn catches_a_live_terminal_up_from_where_it_stopped() {
        let mut keep = SessionKeep::new(1024);
        keep.push_resize(48, 42);
        keep.push_output(b"abcdef");
        let c = keep.catch_up_from(4);
        assert_eq!(c.events, vec![Replay::Output(b"ef".to_vec())]);
        assert!(!c.gap);
        assert_eq!(c.position, 6);
    }

    #[test]
    fn says_so_when_a_live_terminal_is_too_far_behind() {
        let mut keep = SessionKeep::new(4);
        keep.push_output(b"abcd");
        keep.push_output(b"efgh");
        let c = keep.catch_up_from(1);
        assert!(c.gap);
        assert_eq!(output(&c), b"efgh");
    }

    #[test]
    fn replays_a_resize_where_it_happened() {
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"one");
        keep.put_snapshot(3, b"s".to_vec());
        keep.push_output(b"two");
        keep.push_resize(80, 24);
        keep.push_output(b"three");
        assert_eq!(
            keep.catch_up().events,
            vec![
                Replay::Output(b"two".to_vec()),
                Replay::Resize { cols: 80, rows: 24 },
                Replay::Output(b"three".to_vec()),
            ]
        );
    }

    #[test]
    fn keeps_a_resize_at_the_snapshot_position() {
        // It came after the bytes the snapshot covers, and the snapshot may have
        // been taken before the terminal heard about it.
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"one");
        keep.push_resize(80, 24);
        keep.put_snapshot(3, b"s".to_vec());
        assert_eq!(
            keep.catch_up().events,
            vec![Replay::Resize { cols: 80, rows: 24 }]
        );
    }

    #[test]
    fn drops_the_oldest_output_past_the_limit_and_says_so() {
        let mut keep = SessionKeep::new(6);
        keep.put_snapshot(0, b"s".to_vec());
        keep.push_output(b"aaaa");
        keep.push_output(b"bbbb");
        let c = keep.catch_up();
        assert_eq!(output(&c), b"bbbb");
        assert!(c.gap);
        assert_eq!(c.position, 8);
        assert!(keep.held <= 6);
    }

    #[test]
    fn a_new_snapshot_clears_the_gap() {
        let mut keep = SessionKeep::new(6);
        keep.put_snapshot(0, b"s".to_vec());
        keep.push_output(b"aaaa");
        keep.push_output(b"bbbb");
        assert!(keep.catch_up().gap);
        assert!(keep.put_snapshot(8, b"s2".to_vec()));
        let c = keep.catch_up();
        assert!(!c.gap);
        assert!(c.events.is_empty());
    }

    #[test]
    fn output_larger_than_the_limit_leaves_a_gap_rather_than_growing() {
        let mut keep = SessionKeep::new(4);
        keep.push_output(b"0123456789");
        assert_eq!(keep.held, 0);
        assert!(keep.catch_up().gap);
    }

    #[test]
    fn a_session_with_no_snapshot_that_overflowed_has_a_gap() {
        let mut keep = SessionKeep::new(4);
        keep.push_output(b"aaaa");
        keep.push_output(b"bb");
        assert!(keep.catch_up().gap);
    }

    #[test]
    fn refuses_a_snapshot_older_than_the_one_it_has() {
        // Transfers are asynchronous, and a slow one mustn't undo a newer one.
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"abcdef");
        assert!(keep.put_snapshot(4, b"newer".to_vec()));
        assert!(!keep.put_snapshot(2, b"older".to_vec()));
        assert_eq!(keep.snapshot().unwrap().bytes, b"newer");
        assert_eq!(keep.snapshot().unwrap().position, 4);
    }

    #[test]
    fn refuses_a_snapshot_from_a_position_that_has_not_happened() {
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"abc");
        assert!(!keep.put_snapshot(99, b"s".to_vec()));
        assert!(keep.snapshot().is_none());
        assert_eq!(output(&keep.catch_up()), b"abc");
    }

    #[test]
    fn ignores_empty_output() {
        let mut keep = SessionKeep::new(1024);
        keep.push_output(b"");
        assert_eq!(keep.position(), 0);
        assert!(keep.catch_up().events.is_empty());
    }
}
