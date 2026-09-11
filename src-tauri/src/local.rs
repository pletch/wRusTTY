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

/// Turn a saved profile into something runnable, re-resolving the shell.
///
/// The stored path is a fallback, not the answer. A `shell_id` that detection
/// still recognises wins, because that is what survives the shell being
/// upgraded out from under the profile — PowerShell 7 and 8 install side by
/// side under different directories, so the path saved last year names a
/// binary that may be gone.
///
/// An id detection no longer knows falls back to the stored path rather than
/// failing. That covers a hand-typed shell (which has no id at all), an
/// install that moved somewhere unusual, and a WSL distro that is temporarily
/// unregistered — in each case the honest attempt is to run what was saved and
/// let `LocalError::NotFound` say so if it is gone, rather than to refuse
/// before trying.
fn config_from_profile(profile: &crate::profiles::SessionProfile) -> Result<LocalConfig, String> {
    let local = profile
        .local
        .as_ref()
        .ok_or_else(|| format!("session '{}' is not a local shell", profile.label))?;
    let installed = crate::local_shells::detect(&crate::local_shells::SystemMachine);
    Ok(resolve_against(local, &installed))
}

/// The re-resolution rule on its own, so it can be tested without a machine.
fn resolve_against(
    local: &crate::profiles::LocalProfile,
    installed: &[crate::local_shells::ShellInfo],
) -> LocalConfig {
    let resolved = (!local.shell_id.is_empty())
        .then(|| installed.iter().find(|s| s.id == local.shell_id))
        .flatten();

    match resolved {
        // The arguments come from detection too, not from the profile. They
        // belong to the shell rather than to the user's choice — `-d Ubuntu
        // --cd ~`, `-i -l` — so a profile saved before one of them was added
        // picks it up instead of being stuck with what it was saved against.
        Some(shell) => LocalConfig {
            command: shell.command.clone(),
            args: shell.args.clone(),
            cwd: local.cwd.clone(),
            ..Default::default()
        },
        None => LocalConfig {
            command: local.command.clone(),
            args: local.args.clone(),
            cwd: local.cwd.clone(),
            ..Default::default()
        },
    }
}

// Same reason `local_connect` allows it: the argument list is the IPC contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn local_connect_profile(
    app: AppHandle,
    profile_id: String,
    channel: Channel<LocalEvent>,
    data_channel: Channel<tauri::ipc::InvokeResponseBody>,
    cols: u16,
    rows: u16,
    reconnect: Option<ReconnectPolicy>,
    state: State<'_, LocalState>,
) -> Result<String, String> {
    let profile = crate::profiles::get_profile(&app, &profile_id)?;
    let config = config_from_profile(&profile)?;

    let policy = reconnect.unwrap_or_default().sanitized();
    let session_id = state.sessions.next_session_id();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_shells::ShellInfo;
    use crate::profiles::LocalProfile;

    fn shell(id: &str, command: &str, args: &[&str]) -> ShellInfo {
        ShellInfo {
            id: id.into(),
            label: id.into(),
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn saved(shell_id: &str, command: &str) -> LocalProfile {
        LocalProfile {
            shell_id: shell_id.into(),
            command: command.into(),
            args: Vec::new(),
            cwd: None,
            elevated: false,
        }
    }

    /// The whole reason a profile stores an id as well as a path. PowerShell 7
    /// and 8 install side by side under different directories, so a profile
    /// saved last year names a binary that may be gone.
    #[test]
    fn an_upgraded_shell_is_found_at_its_new_path() {
        let installed = [shell(
            "pwsh",
            r"C:\Program Files\PowerShell\8\pwsh.exe",
            &[],
        )];
        let profile = saved("pwsh", r"C:\Program Files\PowerShell\7\pwsh.exe");

        let config = resolve_against(&profile, &installed);
        assert_eq!(config.command, r"C:\Program Files\PowerShell\8\pwsh.exe");
    }

    /// An id detection no longer knows falls back rather than failing: the
    /// honest attempt is to run what was saved and let `NotFound` say so.
    #[test]
    fn an_unknown_id_falls_back_to_the_stored_path() {
        let installed = [shell("cmd", r"C:\Windows\System32\cmd.exe", &[])];
        let profile = saved("wsl:Ubuntu", r"C:\Windows\System32\wsl.exe");

        assert_eq!(
            resolve_against(&profile, &installed).command,
            r"C:\Windows\System32\wsl.exe"
        );
    }

    /// A hand-typed shell has no identity to re-resolve against and must be
    /// used exactly as written — never silently swapped for a detected one.
    #[test]
    fn a_profile_without_an_id_is_used_verbatim() {
        let installed = [shell(
            "pwsh",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            &[],
        )];
        let mut profile = saved("", r"D:\portable\my-shell.exe");
        profile.args = vec!["--weird".into()];

        let config = resolve_against(&profile, &installed);
        assert_eq!(config.command, r"D:\portable\my-shell.exe");
        assert_eq!(config.args, vec!["--weird".to_string()]);
    }

    /// Arguments belong to the shell, not to the saved session, so a profile
    /// written before `--cd ~` existed picks it up on the next connect.
    #[test]
    fn arguments_come_from_detection_rather_than_the_profile() {
        let installed = [shell(
            "wsl:Ubuntu",
            r"C:\Windows\System32\wsl.exe",
            &["-d", "Ubuntu", "--cd", "~"],
        )];
        let mut profile = saved("wsl:Ubuntu", r"C:\Windows\System32\wsl.exe");
        profile.args = vec!["-d".into(), "Ubuntu".into()];

        assert_eq!(
            resolve_against(&profile, &installed).args,
            vec!["-d", "Ubuntu", "--cd", "~"]
        );
    }

    /// The working directory is the user's choice, not the shell's, so it
    /// survives re-resolution either way.
    #[test]
    fn the_saved_working_directory_is_kept() {
        let installed = [shell("cmd", r"C:\Windows\System32\cmd.exe", &[])];
        let mut profile = saved("cmd", r"C:\Windows\System32\cmd.exe");
        profile.cwd = Some(r"D:\work".into());

        assert_eq!(
            resolve_against(&profile, &installed).cwd.as_deref(),
            Some(r"D:\work")
        );
    }

    /// Two distros share a launcher and nothing else; matching on the command
    /// rather than the id would collapse them into one.
    #[test]
    fn two_wsl_distros_resolve_to_their_own_entries() {
        let installed = [
            shell(
                "wsl:Ubuntu",
                r"C:\Windows\System32\wsl.exe",
                &["-d", "Ubuntu"],
            ),
            shell(
                "wsl:Debian",
                r"C:\Windows\System32\wsl.exe",
                &["-d", "Debian"],
            ),
        ];
        let debian = saved("wsl:Debian", r"C:\Windows\System32\wsl.exe");

        assert_eq!(
            resolve_against(&debian, &installed).args,
            vec!["-d", "Debian"]
        );
    }
}
