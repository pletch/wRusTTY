//! Doing something as root on a connection that is already up.
//!
//! SFTP has no privilege-escalation verb — the subsystem runs as the user who
//! authenticated and there is no way to ask it for more — so a root-owned file
//! is unreadable and unwritable through the Files panel however plainly the
//! user can `sudo` in the pane beside it. Everything here exists to close that
//! gap for one narrow case: opening such a file in a local editor and saving it
//! back.
//!
//! # Why this is not "run sudo when needed"
//!
//! The obvious implementation — `sudo -S` on a fresh `exec` channel per
//! operation, with the password piped in each time — would mean holding the
//! user's sudo password in this process for as long as the file stays open. It
//! is the wrong secret to hold: on most hosts it is also the login password,
//! and on a domain-joined estate it may be the directory credential. A save
//! happens every time the user presses Ctrl-S, minutes apart, so "ask each
//! time" is not an option either.
//!
//! The tempting middle road is sudo's own timestamp — authenticate once, let
//! the 15-minute ticket cover the rest — and it does not work here. `sudo` keys
//! its timestamp to the controlling tty, and falls back to the *parent process
//! id* when there is none. Every `exec` channel is a separate process under a
//! separate `sshd` child, so a ticket primed on one channel is invisible to the
//! next. Two channels, two authentications.
//!
//! So the privilege is held as **a process rather than a secret**: one channel
//! per elevated edit, running a small root helper that copies a staged file
//! over a destination and does nothing else. The password authenticates it
//! once, at open, and is dropped immediately afterwards. What remains is a
//! channel whose lifetime the user can see (the edit is listed as watched) and
//! end (stop watching, close the pane, disconnect), and which cannot outlive
//! the SSH session it rides on.
//!
//! That trade is deliberate and worth stating plainly: an attacker who takes
//! this process mid-edit gets root **on that one host, for as long as the edit
//! is open**. The design it replaces would have given them a reusable
//! credential good on every host that accepts it, for as long as it stayed in
//! memory. Neither is nothing; the first is much smaller.
//!
//! # What the helper will do
//!
//! Copy a path it is given over another path it is given, if the destination is
//! an existing regular file. That is not a security boundary — anything that
//! can write any file as root is root — but it keeps a framing bug in this
//! module from becoming arbitrary command execution on the far end, which is a
//! meaningfully different class of accident.
//!
//! `cp` rather than a rename or an `install`, because it writes *through* the
//! destination inode: owner, mode, ACLs, xattrs and SELinux context all survive
//! the save, and a symlinked config file is followed to its target. This is the
//! same write-back `sudoedit` performs, and it inherits the same caveat — the
//! copy truncates before it writes, so it is not atomic. The source is a local
//! file on the far end by then, so the window is a few milliseconds of local
//! I/O rather than the length of a network transfer.

use std::sync::Arc;
use std::time::Duration;

use russh::{client, ChannelMsg};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use zeroize::Zeroizing;

use crate::error::SshError;
use crate::handler::ClientHandler;

/// How long any single step may go without producing a byte.
///
/// An inactivity budget rather than a total one, because the same primitive
/// streams a file whose size is whatever the host says it is — a total timeout
/// would have to be either uselessly long or wrong for large files, while
/// silence is what actually distinguishes a stalled host from a slow one.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Cap on collected stderr. Enough for sudo's complaint and a line of context;
/// past that a host is saying something this cannot act on anyway.
const STDERR_CAP: usize = 4 * 1024;

/// Cap on the diagnostic lines kept from the helper channel, same reasoning.
const NOTES_CAP: usize = 32;

/// Printed by the helper once it is running as root. Reaching this is the only
/// evidence that authentication actually succeeded — sudo's failures arrive on
/// stderr, which this channel does not carry.
const READY: &str = "__WRUSTTY_SUDO_READY__";
/// Printed after a copy that worked, and after one that did not.
const OK: &str = "__WRUSTTY_SUDO_OK__";
const ERR: &str = "__WRUSTTY_SUDO_ERR__";

/// Why an elevated operation could not be done.
///
/// Split this finely because the fixes have nothing to do with each other: a
/// wrong password is retried, a missing sudoers entry is a conversation with
/// whoever administers the host, and `requiretty` is a policy this app cannot
/// satisfy at all. Collapsing them into one string would send every user down
/// the same wrong path.
#[derive(Debug, thiserror::Error)]
pub enum SudoError {
    /// sudo rejected the password. The only variant worth re-prompting on.
    #[error("that sudo password was not accepted")]
    WrongPassword,

    /// sudo wants a password and none was supplied — the ordinary result of
    /// optimistically trying `sudo -n` first.
    #[error("sudo requires a password on this host")]
    NeedsPassword,

    /// sudo will never work here for this user: no sudoers entry, no sudo
    /// installed, or a policy requiring a terminal this app has no way to
    /// provide. Carries wording meant to be shown as-is.
    #[error("{0}")]
    Unavailable(String),

    /// sudo ran and the command under it failed — a read-only mount, a full
    /// disk, a destination that is not a regular file.
    #[error("{0}")]
    Failed(String),

    /// The privileged channel went away: the session dropped, or the helper
    /// exited. Distinct from `Failed` because the answer is to reopen the file
    /// rather than to fix anything about it.
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

/// A path, quoted so a remote POSIX shell sees exactly the bytes we meant.
///
/// Single quotes disable every expansion the shell has, which leaves one
/// character to handle — the quote itself, closed and reopened around an
/// escaped copy. This matters more than it looks: remote filenames come from
/// the *server*, and a directory listing containing `; rm -rf ~` would
/// otherwise be run rather than copied.
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
    /// `None` when the host closed the channel without reporting one, which
    /// several appliance SSH implementations do.
    code: Option<u32>,
    stderr: String,
}

impl ExecOutcome {
    fn succeeded(&self) -> bool {
        self.code == Some(0)
    }
}

/// Runs one command on a channel of its own, with optional stdin, streaming
/// stdout into `sink` and collecting stderr separately.
///
/// The separation is the reason this exists rather than reusing
/// `SshSession::exec_capture`: everything here needs the exit status, and needs
/// sudo's complaint kept apart from the file it is being asked to print. A
/// `cat` whose first line is "sudo: a password is required" is not a file.
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
    // Always, even with no stdin: a command that reads stdin and never gets an
    // EOF hangs until the idle timeout, and there is nothing further to send.
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
            // Extended data type 1 is stderr; there is no other in practice.
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                let room = STDERR_CAP.saturating_sub(stderr.len());
                stderr.extend_from_slice(&data[..data.len().min(room)]);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
            // Deliberately *not* breaking on `Eof`. The exit status arrives as
            // its own message and OpenSSH sends it around the same time;
            // stopping at the first EOF would throw away the one fact every
            // caller here is asking for.
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

/// The refusals no password can fix, if this is one of them.
///
/// Kept apart from everything else because these three are the only failures
/// where prompting the user would be cruelty: the answer is a conversation with
/// whoever administers the host, not a credential.
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

/// Reads the answer to `sudo -v`, which authenticates and runs nothing.
///
/// **Anything unrecognised means "ask for a password".** That is the whole
/// reason this is separate from [`classify`], and it is a correctness fix
/// rather than a nicety. `-v` executes no command, so the only things it can
/// fail on are authentication and policy — there is no third category for an
/// unfamiliar message to belong to. Matching an allowlist of phrasings instead
/// meant that a sudo saying `interactive authentication is required` rather
/// than `a password is required` was reported to the user as a hard failure,
/// and the password dialog that would have satisfied it never opened.
///
/// Sudo's wording varies by version, by build, and by the PAM stack underneath
/// it; `LC_ALL=C` fixes the language and nothing fixes the vocabulary. So the
/// two ends are pinned — the refusals nothing can fix, and a rejected password
/// — and the open middle is read as the thing that is almost always true when
/// `sudo -n` says no: it wants a password.
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
    // A password was given, sudo would not take it, and it did not say the
    // password was wrong. Reported as it stands rather than guessed at — a
    // second prompt for a credential that was accepted is its own kind of
    // wrong answer.
    SudoError::Failed(last_line(outcome))
}

/// Turns sudo's own complaint about a *command* into something the user can act
/// on.
///
/// Unlike [`classify_probe`], an unrecognised message here really can be a
/// third thing: the command under sudo failing on its own terms — no such file,
/// read-only file system, out of space. So this one keeps the allowlist, and an
/// unknown message stays an error rather than becoming a password prompt for a
/// problem no password would fix.
fn classify(outcome: &ExecOutcome) -> SudoError {
    let said = outcome.stderr.to_ascii_lowercase();
    let has = |needle: &str| said.contains(needle);

    if has("incorrect password") || has("sorry, try again") {
        return SudoError::WrongPassword;
    }
    // Every phrasing seen for "sudo wants a password and did not get one".
    // `-n` produces the first two; the third is what sudo says when it needs
    // one, has no terminal, and was not given `-S`.
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

/// The sentence worth showing out of whatever the host printed.
///
/// The last line, because sudo and the tools under it prefix their own name and
/// the useful part comes last. Whole multi-line stderr in a toast is unreadable.
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

/// Builds `sudo` with the flags every call here shares.
///
/// `env LC_ALL=C` rather than an `LC_ALL=C ` assignment prefix because the
/// command string is handed to the user's *login* shell, which is not always
/// POSIX — an assignment prefix is a syntax error in csh, and `env` is just a
/// command.
///
/// `-p ''` silences sudo's own prompt: nothing is reading it, and on the helper
/// channel it would land in the middle of the framing.
fn sudo_prefix(with_password: bool) -> &'static str {
    if with_password {
        "env LC_ALL=C sudo -S -p '' "
    } else {
        "env LC_ALL=C sudo -n "
    }
}

/// Password bytes as sudo wants them on stdin: one line, newline-terminated.
///
/// `Zeroizing` so the copy this makes is wiped when it goes out of scope. Note
/// what it cannot cover: `russh` takes these bytes by value to encrypt them, and
/// that copy is not ours to wipe. Holding the password for one call rather than
/// for the session is what actually bounds the exposure; this is hygiene on top
/// of it, not the guarantee.
fn password_line(password: &Zeroizing<String>) -> Zeroizing<Vec<u8>> {
    let mut line = Zeroizing::new(Vec::with_capacity(password.len() + 1));
    line.extend_from_slice(password.as_bytes());
    line.push(b'\n');
    line
}

/// Runs things as root on one already-authenticated SSH connection.
///
/// Cheap to make and holds nothing open — it is a handle on the connection, so
/// it can be taken while the session mutex is held and used long after it is
/// released, the same shape `get_or_open_sftp` has.
pub struct SudoRunner {
    handle: Arc<client::Handle<ClientHandler>>,
}

impl SudoRunner {
    pub(crate) fn new(handle: Arc<client::Handle<ClientHandler>>) -> Self {
        Self { handle }
    }

    /// Streams a file only root can read into `sink`.
    ///
    /// `password` is `None` for the first, optimistic attempt: a host with a
    /// `NOPASSWD` sudoers entry never needs to be asked, and finding that out
    /// costs one round trip against prompting a user who did not have to be.
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

    /// Makes an empty file on the host that the *connected user* owns, for a
    /// save to land in before it is copied into place.
    ///
    /// `mktemp` rather than picking a name and creating it over SFTP, for one
    /// reason: it creates the file `0600` in the same step. Writing first and
    /// tightening the mode afterwards would leave the contents of a file the
    /// user needed root to read sitting world-readable in `/tmp` for a round
    /// trip.
    ///
    /// Unprivileged on purpose — this is the user's own scratch file, and
    /// nothing about it needs sudo.
    pub async fn make_staging_file(&self) -> Result<String, SudoError> {
        let mut out: Vec<u8> = Vec::new();
        // An explicit template rather than a bare `mktemp`: GNU defaults one in
        // and BSD does not.
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

    /// Starts the root helper and waits for it to say it is running.
    ///
    /// The password is used here and nowhere else. On return it can be dropped:
    /// what authorises every later save is this channel's continued existence,
    /// not a remembered secret.
    pub async fn start_writer(
        &self,
        password: Option<&Zeroizing<String>>,
    ) -> Result<SudoWriter, SudoError> {
        // Reads a source and a destination as two lines, copies one over the
        // other, answers with a sentinel. `exec 2>&1` folds the copy's own
        // errors into the framing stream, where they are kept as diagnostics —
        // sudo's own failures happen before this runs and are dealt with by
        // `diagnose` instead.
        //
        // No single quotes anywhere in here: the whole script is one
        // single-quoted argument.
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

        // Logged at every stage, because this whole path is invisible when it
        // goes wrong: it runs on a channel nobody can see, its failures arrive
        // as an absence of output, and the user's only evidence is a dialog
        // that did or did not appear. The command is safe to log — the
        // password never appears in it, only ever on stdin.
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

        // Nothing is written to the helper until it has said READY. sudo reads
        // exactly the password line and hands the rest of stdin to the child,
        // but "exactly" is a property of sudo's implementation rather than
        // something owed to us — waiting removes any chance of a command line
        // being swallowed along with the password.
        let mut notes = Vec::new();
        loop {
            match read_line(&mut reader).await? {
                // The channel closed before the helper ran, which means sudo
                // refused. Its reason went to stderr, which this stream does
                // not carry, so go and ask for it properly.
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

    /// Asks sudo why it refused, on a channel that keeps stderr.
    ///
    /// Only ever runs on a failure path, so the extra round trip costs nothing
    /// anyone is waiting on — and it is the difference between "that did not
    /// work" and "this account is not in the sudoers file on this host".
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
            // The probe succeeded where the helper did not, so the refusal was
            // not about authentication at all — the likeliest cause is a
            // sudoers rule that permits some commands and not `sh`.
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

/// The live root helper for one edit.
///
/// Holds the channel it runs on, so dropping this ends the privilege: the
/// stream closes, the shell reading from it sees EOF, and the process exits.
/// That is the whole teardown story — there is nothing to remember to call, and
/// no path (stop watching, close the pane, disconnect, drop the session) that
/// can leave a root shell behind.
pub struct SudoWriter {
    reader: BufReader<ReadHalf<russh::ChannelStream<client::Msg>>>,
    writer: WriteHalf<russh::ChannelStream<client::Msg>>,
}

impl SudoWriter {
    /// Copies `staged` over `dest` as root.
    ///
    /// Both paths are sent as lines, so neither may contain one. A newline in a
    /// filename is legal on POSIX and would desynchronise the helper — the next
    /// save would be reading this one's answer — so it is refused here rather
    /// than escaped into a framing this deliberately keeps too simple to get
    /// wrong.
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

/// Keeps a bounded tail of whatever the helper said that was not a sentinel.
/// Bounded because the useful line is the last one, and a host that talks
/// forever must not grow this without limit.
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
        // The listing this path came from is the *server's* to write.
        assert_eq!(shell_quote("/tmp/a; rm -rf ~"), "'/tmp/a; rm -rf ~'");
        assert_eq!(shell_quote("/tmp/$(id)"), "'/tmp/$(id)'");
        assert_eq!(shell_quote("/tmp/`id`"), "'/tmp/`id`'");
    }

    #[test]
    fn closes_and_reopens_around_a_quote() {
        // The one character single quotes cannot contain. Getting this wrong
        // ends the quoted region and hands the rest to the shell.
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
        // The regression this split exists for. `sudo -v` runs no command, so
        // its only failures are authentication and policy — and a sudo that
        // words the first of those unfamiliarly must still reach a password
        // prompt rather than being reported as a hard failure.
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
        // Prompting for these would be asking the user for a credential that
        // cannot possibly help.
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
        // A password was supplied and sudo would not take it, without saying it
        // was wrong. Asking a second time for a credential that may have been
        // accepted is its own wrong answer, so this reports what happened.
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
        // `classify`, unlike the probe, is reading a *command's* stderr — where
        // an unknown message really can be a third thing, and prompting for a
        // password would not fix any of them.
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
        // Everything a tool under sudo can fail with lands here, and the
        // sentence worth showing is the final one.
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
