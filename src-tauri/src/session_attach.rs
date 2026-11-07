//! Android only: lets a session outlive its webview. Android can destroy the
//! Activity while the process and its connections live on, which used to leave a live
//! SSH session with no screen and no way to close it.
//!
//! Each session's channels are wrapped when it starts, without the coalescer or the
//! registry knowing. Output is copied into a [`SessionKeep`] and forwarded to whichever
//! webview is attached. A new webview starts from the latest snapshot and replays what
//! came after it.
//!
//! # Nothing here may wait on a webview
//!
//! Sending to a webview goes through wry's main pipe, a queue of eight that blocks when
//! full and is only drained while an Activity exists. So with no Activity, a send
//! blocks until there's a new one. Done while holding a session's lock, or anywhere the
//! transport waits on it, that froze the session; and the new Activity's first request
//! then waited on the lock, on the thread that would have drained the queue. So each
//! session has a thread of its own for sending, the lock is never held across a send,
//! and these commands are `async` to stay off the main thread.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{Manager, State};

use crate::session_keep::{Replay, SessionKeep};

/// Output kept per session since its last snapshot. Past this the oldest is dropped
/// and the new webview is told, so it can say so and ask programs to repaint.
const MAX_KEPT_BYTES: usize = 4 * 1024 * 1024;

/// A snapshot larger than this is refused, leaving the buffer to do what it can. It's
/// held in memory for the session's life.
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;

/// Output waiting to go to a webview before more is dropped. Well above the 16 MB the
/// coalescer lets a working webview fall behind by, so this only binds on a stuck one,
/// whose output `SessionKeep` has anyway. Once it binds, output stops going out and the
/// webview is told, so it can catch up from where it got to rather than carry on with a
/// hole in the stream.
const MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024;

/// Tells a webview that output was dropped on its way there.
const OUTPUT_RESYNC_EVENT: &str = r#"{"type":"outputResync"}"#;

/// One thing to send, addressed to the attachment it was meant for.
struct Outgoing {
    channel: Channel<InvokeResponseBody>,
    body: InvokeResponseBody,
    attachment: u64,
    /// Raw output bytes, counted against [`MAX_QUEUED_BYTES`].
    len: usize,
}

/// The sending side of a session's thread, shared by its two channels.
#[derive(Clone)]
struct Sender {
    queue: mpsc::Sender<Outgoing>,
    queued_bytes: Arc<AtomicUsize>,
    /// Bumped by each attach, so output for a webview that's gone is skipped rather
    /// than sent into a queue that may not be draining.
    attachment: Arc<AtomicU64>,
    /// Output has been dropped and the webview told, until it attaches again.
    dropping: Arc<AtomicBool>,
}

impl Sender {
    fn start() -> Self {
        let (queue, incoming) = mpsc::channel::<Outgoing>();
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let attachment = Arc::new(AtomicU64::new(0));
        let (bytes, current) = (queued_bytes.clone(), attachment.clone());
        // Ends when the last `Sender` goes, with the session.
        std::thread::spawn(move || {
            for item in incoming {
                // Ignored: a webview that's gone is why this exists.
                if item.attachment == current.load(Ordering::SeqCst) {
                    let _ = item.channel.send(item.body);
                }
                bytes.fetch_sub(item.len, Ordering::SeqCst);
            }
        });
        Self {
            queue,
            queued_bytes,
            attachment,
            dropping: Arc::default(),
        }
    }

    /// Output, which once dropped has to stay dropped until the webview catches up, or
    /// it would land after a hole.
    fn send_output(
        &self,
        channel: Channel<InvokeResponseBody>,
        events: Option<Channel<InvokeResponseBody>>,
        body: InvokeResponseBody,
    ) {
        if self.dropping.load(Ordering::SeqCst) {
            return;
        }
        let len = match &body {
            InvokeResponseBody::Raw(bytes) => bytes.len(),
            InvokeResponseBody::Json(_) => 0,
        };
        if self.queued_bytes.load(Ordering::SeqCst) + len > MAX_QUEUED_BYTES {
            self.dropping.store(true, Ordering::SeqCst);
            if let Some(events) = events {
                self.send(
                    events,
                    InvokeResponseBody::Json(OUTPUT_RESYNC_EVENT.to_string()),
                );
            }
            return;
        }
        self.send(channel, body);
    }

    fn send(&self, channel: Channel<InvokeResponseBody>, body: InvokeResponseBody) {
        let len = match &body {
            InvokeResponseBody::Raw(bytes) => bytes.len(),
            InvokeResponseBody::Json(_) => 0,
        };
        self.queued_bytes.fetch_add(len, Ordering::SeqCst);
        let attachment = self.attachment.load(Ordering::SeqCst);
        let _ = self.queue.send(Outgoing {
            channel,
            body,
            attachment,
            len,
        });
    }
}

struct Kept {
    keep: SessionKeep,
    /// What the frontend needs to rebuild the pane. Opaque here. Holds no secrets; see
    /// `sourceForKeeping`.
    descriptor: Option<String>,
    data: Option<Channel<InvokeResponseBody>>,
    events: Option<Channel<InvokeResponseBody>>,
    /// Events from before the first attach, like a host key prompt.
    queued: VecDeque<InvokeResponseBody>,
    /// What a later webview needs in order to know where the session stands.
    last_status: Option<String>,
    /// Unix milliseconds, so a later webview's connection timer doesn't restart.
    connected_at_ms: Option<u64>,
    sender: Sender,
}

type Shared = Arc<Mutex<Kept>>;

fn locked(kept: &Shared) -> MutexGuard<'_, Kept> {
    kept.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
pub struct SessionAttachState {
    sessions: Mutex<HashMap<String, Shared>>,
    /// What the frontend wants a rebuilt webview to start with, like a temporary zoom.
    /// Opaque here, and gone with the process, unlike the webview's own storage.
    ui_state: Mutex<Option<String>>,
    /// The last window closed and the process stayed for its sessions, so the next
    /// Activity has no webview until [`on_run_event`] builds one.
    window_gone: AtomicBool,
}

/// Tauri exits when the last window closes, which on Android is whenever the Activity
/// is destroyed. With sessions to keep, the process stays, and the next Activity gets
/// a new webview. Without any, it exits as usual.
pub fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            let state = app.state::<SessionAttachState>();
            if !state.list().is_empty() {
                api.prevent_exit();
                state.window_gone.store(true, Ordering::SeqCst);
                ACTIVITY_RESUMED.store(false, Ordering::SeqCst);
            }
        }
        // Not `RunEvent::Resumed`, which despite the name doesn't follow a resume.
        tauri::RunEvent::MainEventsCleared => {
            let state = app.state::<SessionAttachState>();
            if state.window_gone.load(Ordering::SeqCst)
                && ACTIVITY_RESUMED.swap(false, Ordering::SeqCst)
            {
                match rebuild_window(app) {
                    Ok(()) => state.window_gone.store(false, Ordering::SeqCst),
                    // Still marked gone, so the next resume tries again.
                    Err(e) => log::error!("couldn't rebuild the window: {e}"),
                }
            }
        }
        _ => {}
    }
}

/// An Activity has resumed since the last window closed. Tauri has no event for this,
/// and building a window with no Activity to put it in only fails.
static ACTIVITY_RESUMED: AtomicBool = AtomicBool::new(false);

/// `MainActivity.activityResumed`. It then wakes the event loop, so
/// [`on_run_event`] sees this.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_sh_wrustty_app_MainActivity_activityResumed(
    _env: *mut std::ffi::c_void,
    _activity: *mut std::ffi::c_void,
) {
    ACTIVITY_RESUMED.store(true, Ordering::SeqCst);
}

fn rebuild_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptSession {
    session_id: String,
    descriptor: String,
    connected_at: Option<u64>,
}

/// The timer's value after a status event, whose JSON is `{"type":"status","status":..}`:
/// it starts on the first "connected" and any other status clears it, as the frontend's
/// own clock does, so a reconnect restarts it. `None` for an event that isn't a status.
fn connected_since(json: &str, current: Option<u64>, now_ms: u64) -> Option<Option<u64>> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    if value.get("type")?.as_str()? != "status" {
        return None;
    }
    Some(if value.get("status")?.as_str()? == "connected" {
        current.or(Some(now_ms))
    } else {
        None
    })
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ReplayStep {
    /// Base64.
    Output {
        output: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachReply {
    /// What came after the snapshot, in order, for the terminal to catch up on.
    replay: Vec<ReplayStep>,
    /// Output was lost since the snapshot, so the screen may be wrong for now.
    gap: bool,
    /// Where live output carries on from.
    position: u64,
}

impl SessionAttachState {
    fn all(&self) -> MutexGuard<'_, HashMap<String, Shared>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn get(&self, session_id: &str) -> Option<Shared> {
        self.all().get(session_id).cloned()
    }

    /// The channels a session's transport writes to, in place of the frontend's.
    pub fn wrap<E>(&self, session_id: &str) -> (Channel<E>, Channel<InvokeResponseBody>) {
        let sender = Sender::start();
        let kept: Shared = Arc::new(Mutex::new(Kept {
            keep: SessionKeep::new(MAX_KEPT_BYTES),
            descriptor: None,
            data: None,
            events: None,
            queued: VecDeque::new(),
            last_status: None,
            connected_at_ms: None,
            sender: sender.clone(),
        }));
        self.all().insert(session_id.to_string(), kept.clone());

        let for_data = kept.clone();
        let data_sender = sender.clone();
        let data = Channel::new(move |body| {
            let (target, events) = {
                let mut kept = locked(&for_data);
                if let InvokeResponseBody::Raw(bytes) = &body {
                    kept.keep.push_output(bytes);
                }
                (kept.data.clone(), kept.events.clone())
            };
            if let Some(channel) = target {
                data_sender.send_output(channel, events, body);
            }
            Ok(())
        });

        let events = Channel::new(move |body| {
            let target = {
                let mut kept = locked(&kept);
                if let InvokeResponseBody::Json(json) = &body {
                    if let Some(since) = connected_since(json, kept.connected_at_ms, unix_ms()) {
                        kept.last_status = Some(json.clone());
                        kept.connected_at_ms = since;
                    }
                }
                let target = kept.events.clone();
                if target.is_none() {
                    kept.queued.push_back(body.clone());
                }
                target
            };
            if let Some(channel) = target {
                sender.send(channel, body);
            }
            Ok(())
        });
        (events, data)
    }

    /// Connects a webview. `descriptor` is sent on a session's first attach.
    ///
    /// The swap happens under the same lock as the copy, so each byte is either in the
    /// replay or goes to the new channel, never both and never neither.
    #[cfg(test)]
    pub fn attach(
        &self,
        session_id: &str,
        descriptor: Option<String>,
        events: Channel<InvokeResponseBody>,
        data: Channel<InvokeResponseBody>,
    ) -> Result<AttachReply, String> {
        self.attach_from(session_id, descriptor, None, events, data)
    }

    /// [`Self::attach`], from `from` in the output for a terminal that's still up
    /// rather than from the snapshot.
    pub fn attach_from(
        &self,
        session_id: &str,
        descriptor: Option<String>,
        from: Option<u64>,
        events: Channel<InvokeResponseBody>,
        data: Channel<InvokeResponseBody>,
    ) -> Result<AttachReply, String> {
        let shared = self
            .get(session_id)
            .ok_or("that session is no longer running")?;
        let mut kept = locked(&shared);
        if descriptor.is_some() {
            kept.descriptor = descriptor;
        }

        let reattaching = kept.events.is_some();
        let catch_up = match from {
            Some(position) => kept.keep.catch_up_from(position),
            None => kept.keep.catch_up(),
        };
        let replay = catch_up
            .events
            .iter()
            .map(|event| match event {
                Replay::Output(bytes) => ReplayStep::Output {
                    output: BASE64.encode(bytes),
                },
                Replay::Resize { cols, rows } => ReplayStep::Resize {
                    cols: *cols,
                    rows: *rows,
                },
            })
            .collect();

        // Anything still queued for the last webview is now skipped.
        kept.sender.attachment.fetch_add(1, Ordering::SeqCst);
        // This reply covers whatever was dropped.
        kept.sender.dropping.store(false, Ordering::SeqCst);
        kept.events = Some(events.clone());
        kept.data = Some(data);

        // Queued while holding the lock, so a live event can't overtake them. Only
        // queued: the session's own thread does the sending.
        while let Some(body) = kept.queued.pop_front() {
            kept.sender.send(events.clone(), body);
        }
        if reattaching {
            if let Some(status) = kept.last_status.clone() {
                kept.sender.send(events, InvokeResponseBody::Json(status));
            }
        }

        Ok(AttachReply {
            replay,
            gap: catch_up.gap,
            position: catch_up.position,
        })
    }

    /// The size the far end was just told about, so what follows replays at it.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn note_resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(kept) = self.get(session_id) {
            locked(&kept).keep.push_resize(cols, rows);
        }
    }

    /// Sessions a new webview should bring back.
    pub fn list(&self) -> Vec<KeptSession> {
        let mut found: Vec<KeptSession> = self
            .all()
            .iter()
            .filter_map(|(id, kept)| {
                let kept = locked(kept);
                kept.descriptor.clone().map(|descriptor| KeptSession {
                    session_id: id.clone(),
                    descriptor,
                    connected_at: kept.connected_at_ms,
                })
            })
            .collect();
        found.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        found
    }

    /// False if it couldn't be used, so the caller keeps trying at the next chance.
    pub fn put_snapshot(&self, session_id: &str, position: u64, bytes: Vec<u8>) -> bool {
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return false;
        }
        self.get(session_id)
            .is_some_and(|kept| locked(&kept).keep.put_snapshot(position, bytes))
    }

    pub fn snapshot(&self, session_id: &str) -> Option<Vec<u8>> {
        let kept = self.get(session_id)?;
        let kept = locked(&kept);
        kept.keep.snapshot().map(|s| s.bytes.clone())
    }

    /// The pane closed, so whatever was on its screen is wiped.
    pub fn forget(&self, session_id: &str) {
        self.all().remove(session_id);
    }
}

#[tauri::command]
pub async fn session_attach(
    session_id: String,
    descriptor: Option<String>,
    from: Option<u64>,
    events: Channel<InvokeResponseBody>,
    data: Channel<InvokeResponseBody>,
    state: State<'_, SessionAttachState>,
) -> Result<AttachReply, String> {
    state.attach_from(&session_id, descriptor, from, events, data)
}

#[tauri::command]
pub async fn session_ui_state_get(
    state: State<'_, SessionAttachState>,
) -> Result<Option<String>, String> {
    Ok(state
        .ui_state
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone())
}

#[tauri::command]
pub async fn session_ui_state_put(
    value: String,
    state: State<'_, SessionAttachState>,
) -> Result<(), String> {
    *state
        .ui_state
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(value);
    Ok(())
}

/// `NetworkWatch.networkChanged`.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_sh_wrustty_app_NetworkWatch_networkChanged(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    online: u8,
) {
    crate::session_registry::network_changed(online != 0);
}

#[tauri::command]
pub async fn session_kept_list(
    state: State<'_, SessionAttachState>,
) -> Result<Vec<KeptSession>, String> {
    Ok(state.list())
}

#[tauri::command]
pub async fn session_kept_forget(
    session_id: String,
    state: State<'_, SessionAttachState>,
) -> Result<(), String> {
    state.forget(&session_id);
    Ok(())
}

/// Raw bytes, with the session and stream position in headers, because a snapshot can
/// be tens of megabytes and shouldn't go through JSON.
#[tauri::command]
pub async fn session_kept_put_snapshot(
    request: Request<'_>,
    state: State<'_, SessionAttachState>,
) -> Result<bool, String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("missing {name}"))
    };
    let session_id = header("x-session-id")?;
    let position: u64 = header("x-position")?
        .parse()
        .map_err(|_| "bad x-position".to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".to_string());
    };
    Ok(state.put_snapshot(session_id, position, bytes.clone()))
}

/// Empty when there's no snapshot yet.
#[tauri::command]
pub async fn session_kept_snapshot(
    session_id: String,
    state: State<'_, SessionAttachState>,
) -> Result<Response, String> {
    Ok(Response::new(
        state.snapshot(&session_id).unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_connection_timer_starts_once_and_clears_on_any_other_status() {
        let status = |s: &str| format!(r#"{{"type":"status","status":"{s}"}}"#);
        assert_eq!(
            connected_since(&status("connected"), None, 5),
            Some(Some(5))
        );
        assert_eq!(
            connected_since(&status("connected"), Some(5), 9),
            Some(Some(5))
        );
        assert_eq!(
            connected_since(&status("reconnecting 1/5"), Some(5), 9),
            Some(None)
        );
    }

    #[test]
    fn an_event_that_isnt_a_status_leaves_the_timer_alone() {
        assert_eq!(
            connected_since(r#"{"type":"hostKeyPrompt"}"#, Some(5), 9),
            None
        );
        assert_eq!(connected_since("not json", Some(5), 9), None);
    }
    use std::time::{Duration, Instant};

    type Log = Arc<Mutex<Vec<InvokeResponseBody>>>;

    fn recording() -> (Channel<InvokeResponseBody>, Log) {
        let log: Log = Arc::default();
        let sink = log.clone();
        let channel = Channel::new(move |body| {
            sink.lock().unwrap().push(body);
            Ok(())
        });
        (channel, log)
    }

    /// A webview whose queue isn't draining: every send waits until `release`.
    fn stuck() -> (Channel<InvokeResponseBody>, mpsc::Sender<()>) {
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let channel = Channel::new(move |_| {
            let _ = released.lock().unwrap().recv();
            Ok(())
        });
        (channel, release)
    }

    fn raw(log: &Log) -> Vec<u8> {
        log.lock()
            .unwrap()
            .iter()
            .flat_map(|body| match body {
                InvokeResponseBody::Raw(bytes) => bytes.clone(),
                InvokeResponseBody::Json(_) => Vec::new(),
            })
            .collect()
    }

    fn json(log: &Log) -> Vec<String> {
        log.lock()
            .unwrap()
            .iter()
            .filter_map(|body| match body {
                InvokeResponseBody::Json(json) => Some(json.clone()),
                InvokeResponseBody::Raw(_) => None,
            })
            .collect()
    }

    /// Sending happens on the session's own thread, so a result can take a moment.
    fn eventually(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Runs `f` where a deadlock fails the test instead of hanging the suite.
    fn within_a_moment<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, finished) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(f());
        });
        finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| panic!("{what} blocked on a stuck webview"))
    }

    fn output(channel: &Channel<InvokeResponseBody>, bytes: &[u8]) {
        channel
            .send(InvokeResponseBody::Raw(bytes.to_vec()))
            .unwrap();
    }

    fn event(channel: &Channel<InvokeResponseBody>, json: &str) {
        channel
            .send(InvokeResponseBody::Json(json.to_string()))
            .unwrap();
    }

    const CONNECTED: &str = r#"{"type":"status","status":"connected"}"#;

    fn replayed(reply: &AttachReply) -> Vec<u8> {
        reply
            .replay
            .iter()
            .flat_map(|step| match step {
                ReplayStep::Output { output } => BASE64.decode(output).unwrap(),
                ReplayStep::Resize { .. } => Vec::new(),
            })
            .collect()
    }

    #[test]
    fn replays_at_the_size_the_output_was_written_for() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        state.note_resize("s", 48, 42);
        output(&data, b"one");
        state.note_resize("s", 48, 18);
        output(&data, b"two");
        let (events, _) = recording();
        let (attached, _) = recording();
        let reply = state.attach("s", None, events, attached).unwrap();
        assert_eq!(
            reply.replay,
            vec![
                ReplayStep::Resize { cols: 48, rows: 42 },
                ReplayStep::Output {
                    output: BASE64.encode(b"one")
                },
                ReplayStep::Resize { cols: 48, rows: 18 },
                ReplayStep::Output {
                    output: BASE64.encode(b"two")
                },
            ]
        );
    }

    /// Dropped output used to vanish without a word, leaving a hole in the stream.
    #[test]
    fn a_webview_that_falls_too_far_behind_is_told_once_and_can_catch_up() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        let (stuck_data, release) = stuck();
        let (events, event_log) = recording();
        state.attach("s", None, events, stuck_data).unwrap();

        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..(MAX_QUEUED_BYTES / chunk.len() + 8) {
            output(&data, &chunk);
        }
        drop(release);
        let deadline = Instant::now() + Duration::from_secs(5);
        while json(&event_log).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(json(&event_log), vec![OUTPUT_RESYNC_EVENT.to_string()]);

        // The terminal got as far as this, and everything after it is still kept.
        output(&data, b"after");
        let (events, _) = recording();
        let (attached, live) = recording();
        let position = {
            let kept = state.get("s").unwrap();
            let position = locked(&kept).keep.position();
            position - 5
        };
        let reply = state
            .attach_from("s", None, Some(position), events, attached)
            .unwrap();
        assert_eq!(replayed(&reply), b"after");

        // Output flows again.
        output(&data, b"live");
        let deadline = Instant::now() + Duration::from_secs(5);
        while raw(&live).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(raw(&live), b"live");
    }

    #[test]
    fn keeps_a_session_going_with_nothing_attached() {
        // Failing here would look to the forwarder like the session was over.
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        output(&data, b"hello");
    }

    /// The bug this module's header describes: a phone that came back to a black screen
    /// and "isn't responding", because output was blocked on a destroyed Activity's
    /// queue while holding the lock the new Activity's first request needed.
    #[test]
    fn a_stuck_webview_blocks_neither_the_session_nor_a_new_webview() {
        let state = Arc::new(SessionAttachState::default());
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        let (stuck_data, release) = stuck();
        let (events, _) = recording();
        state
            .attach("s", Some("{}".to_string()), events, stuck_data)
            .unwrap();

        // More than one send, so the session's thread is parked on the stuck one.
        let source = data.clone();
        within_a_moment("output", move || {
            for _ in 0..100 {
                output(&source, b"more ");
            }
        });

        let listing = state.clone();
        assert_eq!(within_a_moment("listing", move || listing.list()).len(), 1);

        let (fresh, fresh_log) = recording();
        let (events, _) = recording();
        let attaching = state.clone();
        let reply = within_a_moment("attaching", move || {
            attaching.attach("s", None, events, fresh).unwrap()
        });
        assert_eq!(replayed(&reply).len(), 500);

        // Once the old one lets go, the new webview gets live output, and none of what
        // was queued for the old one: that's in the replay.
        drop(release);
        output(&data, b"live");
        eventually("live output", || !raw(&fresh_log).is_empty());
        assert_eq!(raw(&fresh_log), b"live");
    }

    #[test]
    fn a_stuck_webview_can_not_grow_the_queue_without_limit() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        let (stuck_data, _release) = stuck();
        let (events, _) = recording();
        state.attach("s", None, events, stuck_data).unwrap();
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..(MAX_QUEUED_BYTES / chunk.len() + 8) {
            output(&data, &chunk);
        }
        let kept = state.get("s").unwrap();
        let queued = locked(&kept).sender.queued_bytes.load(Ordering::SeqCst);
        assert!(queued <= MAX_QUEUED_BYTES, "queued {queued} bytes");
    }

    #[test]
    fn catches_up_a_first_attach_then_goes_live() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        output(&data, b"early ");
        let (attached, log) = recording();
        let (events, _) = recording();
        let reply = state.attach("s", None, events, attached).unwrap();
        assert_eq!(replayed(&reply), b"early ");
        assert_eq!(reply.position, 6);
        output(&data, b"live");
        eventually("live output", || !raw(&log).is_empty());
        assert_eq!(raw(&log), b"live");
    }

    #[test]
    fn replays_only_what_came_after_the_snapshot() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        output(&data, b"covered ");
        assert!(state.put_snapshot("s", 8, b"snap".to_vec()));
        output(&data, b"since");
        let (attached, _) = recording();
        let (events, _) = recording();
        let reply = state.attach("s", None, events, attached).unwrap();
        assert_eq!(replayed(&reply), b"since");
        assert_eq!(reply.position, 13);
        assert!(!reply.gap);
        assert_eq!(state.snapshot("s").unwrap(), b"snap");
    }

    #[test]
    fn moves_output_to_a_new_webview_with_nothing_lost_or_doubled() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        let (first, first_log) = recording();
        let (events, _) = recording();
        state.attach("s", None, events, first).unwrap();
        output(&data, b"one ");
        eventually("the first webview's output", || !raw(&first_log).is_empty());

        let (second, second_log) = recording();
        let (events, _) = recording();
        let reply = state.attach("s", None, events, second).unwrap();
        output(&data, b"two");
        eventually("the second webview's output", || {
            !raw(&second_log).is_empty()
        });

        assert_eq!(raw(&first_log), b"one ");
        assert_eq!(replayed(&reply), b"one ");
        assert_eq!(raw(&second_log), b"two");
    }

    #[test]
    fn hands_a_first_attach_what_it_missed_in_order() {
        let state = SessionAttachState::default();
        let (events_in, _data) = state.wrap::<InvokeResponseBody>("s");
        event(&events_in, r#"{"type":"hostKeyPrompt"}"#);
        event(&events_in, CONNECTED);
        let (events, log) = recording();
        let (attached, _) = recording();
        state.attach("s", None, events, attached).unwrap();
        eventually("the queued events", || json(&log).len() == 2);
        assert_eq!(json(&log), vec![r#"{"type":"hostKeyPrompt"}"#, CONNECTED]);
    }

    #[test]
    fn tells_a_later_webview_where_the_session_stands() {
        let state = SessionAttachState::default();
        let (events_in, _data) = state.wrap::<InvokeResponseBody>("s");
        let (events, _) = recording();
        let (attached, _) = recording();
        state.attach("s", None, events, attached).unwrap();
        event(&events_in, CONNECTED);

        let (events, log) = recording();
        let (attached, _) = recording();
        state.attach("s", None, events, attached).unwrap();
        eventually("the last status", || !json(&log).is_empty());
        assert_eq!(json(&log), vec![CONNECTED]);
    }

    #[test]
    fn says_so_when_output_was_lost() {
        let state = SessionAttachState::default();
        let (_events, data) = state.wrap::<InvokeResponseBody>("s");
        let chunk = vec![b'x'; MAX_KEPT_BYTES / 2 + 1];
        output(&data, &chunk);
        output(&data, &chunk);
        output(&data, &chunk);
        let (events, _) = recording();
        let (attached, _) = recording();
        let reply = state.attach("s", None, events, attached).unwrap();
        assert!(reply.gap);
        assert!(replayed(&reply).len() <= MAX_KEPT_BYTES);
    }

    #[test]
    fn lists_only_sessions_a_webview_described() {
        let state = SessionAttachState::default();
        state.wrap::<InvokeResponseBody>("never-attached");
        state.wrap::<InvokeResponseBody>("s");
        let (events, _) = recording();
        let (attached, _) = recording();
        state
            .attach("s", Some("{}".to_string()), events, attached)
            .unwrap();
        assert_eq!(
            state.list(),
            vec![KeptSession {
                session_id: "s".to_string(),
                descriptor: "{}".to_string(),
                connected_at: None,
            }]
        );
    }

    #[test]
    fn keeps_the_descriptor_when_a_reattach_sends_none() {
        let state = SessionAttachState::default();
        state.wrap::<InvokeResponseBody>("s");
        for descriptor in [Some("{}".to_string()), None] {
            let (events, _) = recording();
            let (attached, _) = recording();
            state.attach("s", descriptor, events, attached).unwrap();
        }
        assert_eq!(state.list().len(), 1);
    }

    #[test]
    fn forgets_a_closed_pane() {
        let state = SessionAttachState::default();
        state.wrap::<InvokeResponseBody>("s");
        state.forget("s");
        let (events, _) = recording();
        let (attached, _) = recording();
        assert!(state.attach("s", None, events, attached).is_err());
    }

    #[test]
    fn refuses_a_snapshot_for_a_session_it_does_not_have() {
        let state = SessionAttachState::default();
        assert!(!state.put_snapshot("nope", 0, Vec::new()));
        assert_eq!(state.snapshot("nope"), None);
    }

    #[test]
    fn refuses_an_oversized_snapshot() {
        let state = SessionAttachState::default();
        state.wrap::<InvokeResponseBody>("s");
        assert!(!state.put_snapshot("s", 0, vec![0; MAX_SNAPSHOT_BYTES + 1]));
    }
}
