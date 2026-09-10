//! Tauri command layer for local shell sessions — the same push-`Channel`
//! shape as `telnet.rs`, which is the closest existing transport: no
//! credential, no host-key prompt, nothing to re-resolve.
//!
//! Everything that isn't local-shell-specific lives in `session_registry.rs`;
//! what remains here is the event enum (this transport's own `Channel<E>`
//! type) and the `#[tauri::command]` entry points, which have to be concrete
//! functions for `generate_handler!`.
//!
//! Unlike telnet, `local_connect` takes the pane's size. A pseudoconsole has
//! to be given one at creation — there is no "decide later" — so passing it
//! here is what stops the shell drawing its first prompt at 80 columns and
//! reflowing a moment later when the registry replays the real size. See
//! `wr_local::LocalConnector::with_size`.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use wr_local::{LocalConfig, LocalConnector};

use crate::connection_status::status_label;
use crate::session_registry::{NoPrepare, NoRestore, ReconnectPolicy, SessionRegistry};

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LocalEvent {
    // PTY output travels on its own raw-bytes Channel<InvokeResponseBody>
    // instead (see coalesce.rs).
    Status { status: String },
}

pub struct LocalState {
    sessions: SessionRegistry<LocalConnector>,
}

impl Default for LocalState {
    fn default() -> Self {
        Self {
            // The id prefix, which is also what keeps a local session id from
            // colliding with an SSH one in the coalescer's credit table, the
            // logging sink and the frontend's pane map.
            sessions: SessionRegistry::new("local"),
        }
    }
}

// Same reason `ssh_connect` allows it: the argument list *is* the IPC
// contract, since `#[tauri::command]` deserialises each parameter by name from
// the invoke payload. Grouping them into a struct to satisfy the lint would
// change the shape the frontend has to send rather than simplify anything.
// Allowed here specifically, not workspace-wide.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn local_connect(
    app: AppHandle,
    config: LocalConfig,
    channel: Channel<LocalEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    reconnect: Option<ReconnectPolicy>,
    state: State<'_, LocalState>,
) -> Result<String, String> {
    let policy = reconnect.unwrap_or_default().sanitized();
    let session_id = state.sessions.next_session_id();

    // Nothing to re-resolve and nothing secret to hold: a local shell is a
    // path and an argv, both of which are already here. The config is cloned
    // per attempt only because `LocalConnector::new` consumes one.
    //
    // The factory is wired up even though, as things stand, it can never run.
    // Auto-reconnect fires on `DisconnectKind::Lost`, and `wr-local` only ever
    // reports `Closed` — a shell has either exited or it hasn't, so there is no
    // state where the process is gone but the session should come back by
    // itself. That is decision 5 in docs/LOCAL_SHELL_PLAN.md holding
    // structurally rather than by policy, and this stays correct rather than
    // absent so that a future `Lost` (a pty read failing under a live child,
    // say) relaunches properly instead of finding no way to.
    let reconnect_config = config.clone();
    state
        .sessions
        .spawn_connect(
            app,
            session_id.clone(),
            LocalConnector::new(config).with_size(cols, rows),
            channel,
            data_channel,
            |status| LocalEvent::Status {
                status: status_label(status),
            },
            None::<NoPrepare>,
            Some(move || {
                let config = reconnect_config.clone();
                // Carries the size too. The registry replays the pane's real
                // size after publishing, so omitting it would still arrive at
                // the right place — via one visible reflow, which is the thing
                // `with_size` exists to avoid.
                async move { Ok(LocalConnector::new(config).with_size(cols, rows)) }
            }),
            None::<NoRestore>,
            policy,
        )
        .await;
    Ok(session_id)
}

#[tauri::command]
pub async fn local_write(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    state.sessions.write(&session_id, &data).await
}

#[tauri::command]
pub async fn local_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, LocalState>,
    logging: State<'_, crate::logging::LoggingState>,
) -> Result<(), String> {
    // See `ssh_resize`: the marker goes down before the size it announces.
    crate::logging::note_resize(&logging, &session_id, cols, rows);
    state.sessions.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn local_disconnect(
    session_id: String,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    state.sessions.disconnect(&session_id).await
}
