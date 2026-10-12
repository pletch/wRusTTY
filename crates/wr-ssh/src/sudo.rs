//! Running things as root on an established connection, so the Files panel can
//! open and save root-owned files (SFTP runs as the authenticated user and has
//! no escalation).
//!
//! # Privilege as a process, not a secret
//!
//! Running `sudo -S` per operation would mean holding the user's sudo password
//! (often their login or directory credential) for as long as a file is open,
//! and sudo's timestamp doesn't help: it's keyed to the tty or parent pid, and
//! each `exec` channel is a separate process. Instead, one channel per elevated
//! edit runs a small root helper; the password authenticates it once and is
//! dropped. The channel's lifetime is visible (the edit is listed as watched)
//! and ends with the edit, the pane or the session.
//!
//! The trade: an attacker who takes this process mid-edit gets root on that one
//! host while the edit is open, rather than a reusable credential.
//!
//! # What the helper does
//!
//! Copies a given path over another, if the destination is an existing regular
//! file. Not a security boundary (root is root), but it keeps a framing bug from
//! becoming arbitrary command execution. It uses `cp`, which writes through the
//! destination inode, preserving owner, mode, ACLs, xattrs and SELinux context
//! and following symlinks, as `sudoedit` does. Like `sudoedit` it isn't atomic,
//! but the source is already local to the host.

use std::sync::Arc;
use std::time::Duration;

use russh::{client, ChannelMsg};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use zeroize::Zeroizing;

use crate::error::SshError;
use crate::handler::ClientHandler;

/// How long any step may go without producing a byte. An idle budget rather
/// than a total one, since file reads can be any size.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Cap on collected stderr.
const STDERR_CAP: usize = 4 * 1024;

/// Cap on diagnostic lines kept from the helper channel.
const NOTES_CAP: usize = 32;

/// Printed by the helper once running as root: the only evidence that
/// authentication succeeded (sudo's failures go to stderr, which this channel
/// doesn't carry).
const READY: &str = "__WRUSTTY_SUDO_READY__";
/// Printed after each copy, success or failure.
const OK: &str = "__WRUSTTY_SUDO_OK__";
const ERR: &str = "__WRUSTTY_SUDO_ERR__";

/// Why an elevated operation failed, split by remedy: retry the password, ask
/// the host's admin, or accept that this app can't satisfy the policy.
#[derive(Debug, thiserror::Error)]
pub enum SudoError {
    /// sudo rejected the password. The only variant worth re-prompting on.
    #[error("that sudo password was not accepted")]
    WrongPassword,

    /// sudo wants a password and none was supplied (the optimistic `sudo -n`
    /// attempt).
    #[error("sudo requires a password on this host")]
    NeedsPassword,

    /// sudo will never work for this user here (no sudoers entry, not installed,
    /// or `requiretty`). The message is shown as-is.
    #[error("{0}")]
    Unavailable(String),

    /// sudo ran but the command failed (read-only mount, full disk, not a regular
    /// file).
    #[error("{0}")]
    Failed(String),

    /// The privileged channel ended (session dropped or helper exited); the file
    /// must be reopened.
    #[error("the privileged session for this file has ended — open the file again")]
    ChannelClosed,

    #[error(transparent)]
    Ssh(#[from] SshError),
}

impl SudoError {
    /// Whether asking the user for the password again could plausibly help.
    pub fn is_retryable_password(&self) -> bool {
        matches!(self, SudoError::WrongPassword)
    }

    /// Whether a first, password-free attempt failed only for want of one.
    pub fn needs_password(&self) -> bool {
        matches!(self, SudoError::NeedsPassword)
    }
}

/// A path single-quoted for a remote POSIX shell, with embedded quotes closed
/// and reopened. Remote filenames come from the server, so `; rm -rf ~` must be
/// data, not a command.
fn shell_quote(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('\'');
    for c in path.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// What a one-shot command did.
struct ExecOutcome {
    /// `None` when the host closed without reporting one (some appliances).
    code: Option<u32>,
    stderr: String,
}

impl ExecOutcome {
    fn succeeded(&self) -> bool {
        self.code == Some(0)
    }
}

/// Runs one command on its own channel with optional stdin, streaming stdout to
/// `sink` and collecting stderr separately, with the exit status. (Unlike
/// `SshSession::exec_capture`, which drops stderr and the exit status.)
async fn run_once<W>(
    handle: &Arc<client::Handle<ClientHandler>>,
    command: &str,
    stdin: Option<&[u8]>,
    mut sink: Option<&mut W>,
) -> Result<ExecOutcome, SshError>
where
    W: AsyncWrite + Unpin + Send,
{
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;
    if let Some(data) = stdin {
        channel.data_bytes(data.to_vec()).await?;
    }
    // Always send EOF, or a command reading stdin hangs.
    channel.eof().await?;

    let mut stderr = Vec::new();
    let mut code = None;
    loop {
        let msg = tokio::time::timeout(IDLE_TIMEOUT, channel.wait())
            .await
            .map_err(|_| SshError::ExecTimeout)?;
        match msg {
            Some(ChannelMsg::Data { data }) => {
                if let Some(sink) = sink.as_deref_mut() {
                    sink.write_all(&data).await?;
                }
            }
            // Extended data type 1 is stderr.
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                let room = STDERR_CAP.saturating_sub(stderr.len());
                stderr.extend_from_slice(&data[..data.len().min(room)]);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
            // Don't stop at `Eof`: the exit status may still be coming.
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    if let Some(sink) = sink {
        sink.flush().await?;
    }
    Ok(ExecOutcome {
        code,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// The refusals no password can fix, if this is one: these need the host's
/// admin, not a credential.
fn hopeless_policy(said: &str, code: Option<u32>) -> Option<SudoError> {
    let has = |needle: &str| said.contains(needle);

    if has("no tty present") || has("must have a tty") {
        return Some(SudoError::Unavailable(
            "this host's sudo policy requires a terminal, which this app cannot give it              (Defaults requiretty in sudoers). Editing it as root has to be done in the pane."
                .to_string(),
        ));
    }
    if has("not in the sudoers") || has("not allowed to execute") || has("may not run sudo") {
        return Some(SudoError::Unavailable(
            "this account is not permitted to run sudo on this host.".to_string(),
        ));
    }
    if code == Some(127) || has("command not found") {
        return Some(SudoError::Unavailable(
            "sudo is not installed on this host.".to_string(),
        ));
    }
    None
}

/// Reads the answer to `sudo -v` (authenticates, runs nothing). Since `-v` can
/// only fail on authentication or policy, anything other than a known hopeless
/// policy or a rejected password means "ask for a password". sudo's wording
/// varies by version and PAM stack, so an allowlist of phrasings would miss
/// some.
fn classify_probe(outcome: &ExecOutcome, had_password: bool) -> SudoError {
    let said = outcome.stderr.to_ascii_lowercase();
    if let Some(hopeless) = hopeless_policy(&said, outcome.code) {
        return hopeless;
    }
    if !had_password {
        return SudoError::NeedsPassword;
    }
    if said.contains("incorrect password") || said.contains("sorry, try again") {
        return SudoError::WrongPassword;
    }
    // Given a password, sudo refused without saying it was wrong; report it
    // rather than prompting again.
    SudoError::Failed(last_line(outcome))
}

/// Classifies sudo's complaint about a command. Unlike [`classify_probe`], an
/// unknown message here can be the command's own failure, so it stays an error
/// rather than becoming a password prompt.
fn classify(outcome: &ExecOutcome) -> SudoError {
    let said = outcome.stderr.to_ascii_lowercase();
    let has = |needle: &str| said.contains(needle);

    if has("incorrect password") || has("sorry, try again") {
        return SudoError::WrongPassword;
    }
    // Known phrasings for "needs a password": `-n` gives the first two; the
    // third is sudo with no terminal and no `-S`.
    if has("password is required")
        || has("interactive authentication is required")
        || has("no password was provided")
        || has("a terminal is required to read the password")
    {
        return SudoError::NeedsPassword;
    }
    if let Some(hopeless) = hopeless_policy(&said, outcome.code) {
        return hopeless;
    }
    SudoError::Failed(last_line(outcome))
}

/// The last line of the host's message (tools put the useful part last), or a
/// generic message with the exit status.
fn last_line(outcome: &ExecOutcome) -> String {
    let detail = outcome.stderr.trim();
    if detail.is_empty() {
        return match outcome.code {
            Some(code) => format!("the command failed on the host (exit status {code})"),
            None => "the command failed on the host".to_string(),
        };
    }
    detail.lines().last().unwrap_or(detail).trim().to_string()
}

/// The `sudo` invocation shared by every call. `env LC_ALL=C` rather than an
/// assignment prefix, which non-POSIX login shells (csh) reject. `-p ''`
/// silences the prompt, which would otherwise land in the helper's framing.
fn sudo_prefix(with_password: bool) -> &'static str {
    if with_password {
        "env LC_ALL=C sudo -S -p '' "
    } else {
        "env LC_ALL=C sudo -n "
    }
}

/// The password as one newline-terminated line for sudo's stdin, zeroized on
/// drop. `russh`'s internal copy can't be wiped; holding the password for one
/// call is what actually bounds exposure.
fn password_line(password: &Zeroizing<String>) -> Zeroizing<Vec<u8>> {
    let mut line = Zeroizing::new(Vec::with_capacity(password.len() + 1));
    line.extend_from_slice(password.as_bytes());
    line.push(b'\n');
    line
}

/// Runs things as root on one authenticated SSH connection. Holds nothing open,
/// so it can outlive the session mutex.
pub struct SudoRunner {
    handle: Arc<client::Handle<ClientHandler>>,
}

impl SudoRunner {
    pub(crate) fn new(handle: Arc<client::Handle<ClientHandler>>) -> Self {
        Self { handle }
    }

    /// Streams a root-only file into `sink`. `password` is `None` on the first try,
    /// so `NOPASSWD` hosts never prompt.
    pub async fn read_file<W>(
        &self,
        path: &str,
        password: Option<&Zeroizing<String>>,
        sink: &mut W,
    ) -> Result<(), SudoError>
    where
        W: AsyncWrite + Unpin + Send,
    {
        let command = format!(
            "{}cat -- {}",
            sudo_prefix(password.is_some()),
            shell_quote(path)
        );
        let stdin = password.map(password_line);
        let outcome = run_once(
            &self.handle,
            &command,
            stdin.as_ref().map(|line| &line[..]),
            Some(sink),
        )
        .await?;
        if outcome.succeeded() {
            Ok(())
        } else {
            Err(classify(&outcome))
        }
    }

    /// Makes an empty staging file owned by the connected user (unprivileged), for
    /// a save to land in before it's copied into place. `mktemp` creates it `0600`
    /// atomically, so root-only contents are never world-readable in `/tmp`.
    pub async fn make_staging_file(&self) -> Result<String, SudoError> {
        let mut out: Vec<u8> = Vec::new();
        // An explicit template: BSD `mktemp` has no default.
        let outcome = run_once(
            &self.handle,
            "env LC_ALL=C mktemp /tmp/wrustty-edit.XXXXXXXX",
            None,
            Some(&mut out),
        )
        .await?;
        if !outcome.succeeded() {
            return Err(classify(&outcome));
        }
        let path = String::from_utf8_lossy(&out).trim().to_string();
        if path.is_empty() || !path.starts_with('/') {
            return Err(SudoError::Failed(
                "the host did not provide a temporary file to save through".to_string(),
            ));
        }
        Ok(path)
    }

    /// Starts the root helper and waits for READY. The password is used only here;
    /// afterward the channel's existence is the authorization.
    pub async fn start_writer(
        &self,
        password: Option<&Zeroizing<String>>,
    ) -> Result<SudoWriter, SudoError> {
        // Reads source and destination lines, copies one over the other, and answers
        // with a sentinel. `exec 2>&1` folds the copy's errors into the stream as
        // diagnostics; sudo's own failures happen first and go to `diagnose`. The
        // script contains no single quotes (it's one quoted argument).
        let script = format!(
            "exec 2>&1; echo {READY}; \
             while IFS= read -r s && IFS= read -r d; do \
             if [ -f \"$d\" ] && cp -- \"$s\" \"$d\"; then echo {OK}; else echo {ERR}; fi; \
             done"
        );
        let command = format!(
            "{}sh -c {}",
            sudo_prefix(password.is_some()),
            shell_quote(&script)
        );

        // Logged throughout: failures here are otherwise invisible. The password is
        // only ever on stdin, never in the command.
        tracing::debug!(with_password = password.is_some(), %command, "sudo: starting helper");
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(SshError::from)?;
        channel.exec(true, command).await.map_err(SshError::from)?;
        let (read_half, mut write_half) = tokio::io::split(channel.into_stream());
        let mut reader = BufReader::new(read_half);

        if let Some(password) = password {
            let line = password_line(password);
            write_half.write_all(&line).await.map_err(SshError::from)?;
            write_half.flush().await.map_err(SshError::from)?;
        }

        // Write nothing until READY, so no command line can be consumed along with
        // the password.
        let mut notes = Vec::new();
        loop {
            match read_line(&mut reader).await? {
                // Closed before READY: sudo refused, and its reason went to stderr.
                None => {
                    let why = self.diagnose(password).await;
                    tracing::warn!(error = %why, "sudo: helper closed before it was ready");
                    return Err(why);
                }
                Some(line) if line == READY => {
                    tracing::debug!("sudo: helper ready");
                    break;
                }
                Some(line) => push_note(&mut notes, line),
            }
        }

        Ok(SudoWriter {
            reader,
            writer: write_half,
        })
    }

    /// Asks sudo why it refused, on a channel that keeps stderr. Failure path only.
    async fn diagnose(&self, password: Option<&Zeroizing<String>>) -> SudoError {
        let command = format!("{}-v", sudo_prefix(password.is_some()));
        let stdin = password.map(password_line);
        match run_once::<Vec<u8>>(
            &self.handle,
            &command,
            stdin.as_ref().map(|line| &line[..]),
            None,
        )
        .await
        {
            // The probe succeeded where the helper didn't: likely a sudoers rule that
            // allows specific commands but not `sh`.
            Ok(outcome) if outcome.succeeded() => SudoError::Unavailable(
                "sudo accepted this account but would not run the helper — a sudoers rule may \
                 allow only specific commands."
                    .to_string(),
            ),
            Ok(outcome) => classify_probe(&outcome, password.is_some()),
            Err(e) => SudoError::Ssh(e),
        }
    }
}

/// The live root helper for one edit. Dropping it closes the channel, the
/// helper reads EOF and exits, so no teardown path can leave a root shell
/// behind.
pub struct SudoWriter {
    reader: BufReader<ReadHalf<russh::ChannelStream<client::Msg>>>,
    writer: WriteHalf<russh::ChannelStream<client::Msg>>,
}

impl SudoWriter {
    /// Copies `staged` over `dest` as root. Paths containing a line break are
    /// refused, since they would desynchronize the line-based framing.
    pub async fn copy_into(&mut self, staged: &str, dest: &str) -> Result<(), SudoError> {
        for path in [staged, dest] {
            if path.contains('\n') || path.contains('\r') {
                return Err(SudoError::Failed(
                    "this file's name contains a line break, which cannot be sent to the \
                     privileged helper safely."
                        .to_string(),
                ));
            }
        }

        let request = format!("{staged}\n{dest}\n");
        self.writer
            .write_all(request.as_bytes())
            .await
            .map_err(|_| SudoError::ChannelClosed)?;
        self.writer
            .flush()
            .await
            .map_err(|_| SudoError::ChannelClosed)?;

        let mut notes: Vec<String> = Vec::new();
        loop {
            match read_line(&mut self.reader).await? {
                None => return Err(SudoError::ChannelClosed),
                Some(line) if line == OK => return Ok(()),
                Some(line) if line == ERR => {
                    let detail = notes.last().cloned().unwrap_or_default();
                    return Err(SudoError::Failed(if detail.is_empty() {
                        "the host refused the write — the destination may not be a regular file."
                            .to_string()
                    } else {
                        detail
                    }));
                }
                Some(line) => push_note(&mut notes, line),
            }
        }
    }
}

/// One line from the helper, or `None` at end of stream.
async fn read_line<R>(reader: &mut BufReader<R>) -> Result<Option<String>, SudoError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = String::new();
    let read = tokio::time::timeout(IDLE_TIMEOUT, reader.read_line(&mut line))
        .await
        .inspect_err(|_| tracing::warn!("sudo: the host went quiet for {IDLE_TIMEOUT:?}"))
        .map_err(|_| SudoError::Ssh(SshError::ExecTimeout))?
        .map_err(|_| SudoError::ChannelClosed)?;
    if read == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(['\n', '\r']).to_string()))
}

/// Keeps a bounded tail of the helper's non-sentinel output.
fn push_note(notes: &mut Vec<String>, line: String) {
    let line = line.trim().to_string();
    if line.is_empty() {
        return;
    }
    if notes.len() == NOTES_CAP {
        notes.remove(0);
    }
    notes.push(line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_a_plain_path() {
        assert_eq!(
            shell_quote("/etc/nginx/nginx.conf"),
            "'/etc/nginx/nginx.conf'"
        );
    }

    #[test]
    fn neutralises_shell_metacharacters() {
        // The listing came from the server.
        assert_eq!(shell_quote("/tmp/a; rm -rf ~"), "'/tmp/a; rm -rf ~'");
        assert_eq!(shell_quote("/tmp/$(id)"), "'/tmp/$(id)'");
        assert_eq!(shell_quote("/tmp/`id`"), "'/tmp/`id`'");
    }

    #[test]
    fn closes_and_reopens_around_a_quote() {
        // Getting this wrong ends the quoted region early.
        assert_eq!(shell_quote("/tmp/it's"), r#"'/tmp/it'\''s'"#);
    }

    fn outcome(code: u32, stderr: &str) -> ExecOutcome {
        ExecOutcome {
            code: Some(code),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn an_unfamiliar_refusal_of_the_probe_asks_for_a_password() {
        // `sudo -v`'s failures are authentication or policy, so an unfamiliar
        // refusal must still reach the password prompt.
        for said in [
            "sudo: interactive authentication is required",
            "sudo: a password is required",
            "sudo: no password was provided",
            "sudo: a terminal is required to read the password",
            "sudo: something no one has seen before",
            "",
        ] {
            let err = classify_probe(&outcome(1, said), false);
            assert!(
                err.needs_password(),
                "{said:?} should have asked for a password, got {err}"
            );
        }
    }

    #[test]
    fn the_probe_still_refuses_what_no_password_can_fix() {
        // No credential could help these.
        for said in [
            "sudo: sorry, you must have a tty to run sudo",
            "tim is not in the sudoers file.",
            "bash: sudo: command not found",
        ] {
            let err = classify_probe(&outcome(1, said), false);
            assert!(
                matches!(err, SudoError::Unavailable(_)),
                "{said:?} should have been refused outright, got {err}"
            );
        }
    }

    #[test]
    fn a_probe_that_was_given_a_password_does_not_ask_again_blindly() {
        // Refused without "wrong password": report it, don't prompt again.
        let err = classify_probe(&outcome(1, "sudo: account expired"), true);
        assert!(!err.needs_password());
        assert_eq!(err.to_string(), "sudo: account expired");
        // A rejection is still a rejection.
        assert!(
            classify_probe(&outcome(1, "sudo: 1 incorrect password attempt"), true)
                .is_retryable_password()
        );
    }

    #[test]
    fn a_command_failure_is_not_read_as_a_password_problem() {
        // A command's stderr can be its own failure.
        let err = classify(&outcome(1, "cat: /etc/shadow: No such file or directory"));
        assert!(!err.needs_password());
    }

    #[test]
    fn a_wrong_password_is_the_only_thing_worth_retrying() {
        assert!(classify(&outcome(1, "sudo: 1 incorrect password attempt")).is_retryable_password());
        assert!(!classify(&outcome(1, "sudo: a password is required")).is_retryable_password());
        assert!(!classify(&outcome(
            1,
            "tim is not in the sudoers file.  This incident will be reported."
        ))
        .is_retryable_password());
    }

    #[test]
    fn a_missing_ticket_asks_for_a_password_rather_than_failing() {
        assert!(classify(&outcome(1, "sudo: a password is required")).needs_password());
    }

    #[test]
    fn names_the_policies_a_password_cannot_fix() {
        assert!(matches!(
            classify(&outcome(1, "sudo: sorry, you must have a tty to run sudo")),
            SudoError::Unavailable(_)
        ));
        assert!(matches!(
            classify(&outcome(1, "tim is not in the sudoers file.")),
            SudoError::Unavailable(_)
        ));
        assert!(matches!(
            classify(&outcome(127, "bash: sudo: command not found")),
            SudoError::Unavailable(_)
        ));
    }

    #[test]
    fn reports_the_last_line_of_an_unrecognised_failure() {
        // The final line is the one worth showing.
        let err = classify(&outcome(
            1,
            "cp: cannot create regular file\ncp: read-only file system",
        ));
        assert_eq!(err.to_string(), "cp: read-only file system");
    }

    #[test]
    fn an_empty_complaint_still_says_something() {
        assert_eq!(
            classify(&outcome(4, "")).to_string(),
            "the command failed on the host (exit status 4)"
        );
    }

    #[test]
    fn notes_keep_the_tail_not_the_head() {
        let mut notes = Vec::new();
        for i in 0..(NOTES_CAP + 5) {
            push_note(&mut notes, format!("line {i}"));
        }
        assert_eq!(notes.len(), NOTES_CAP);
        assert_eq!(notes.last().unwrap(), &format!("line {}", NOTES_CAP + 4));
    }

    #[test]
    fn blank_lines_are_not_notes() {
        let mut notes = Vec::new();
        push_note(&mut notes, "   ".to_string());
        assert!(notes.is_empty());
    }
}
