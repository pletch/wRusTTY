# Local shells

Implementation plan for a fourth transport: a shell process running on this
machine, on a Windows pseudoconsole, in a wRusTTY pane.

**Phases 1 and 2 are built**, plus a slice of Phase 4 that opens a pane —
`pwsh` runs. Phase 3 and the rest of Phase 4 are not. What changed on
contact with a real pseudoconsole is recorded under "What Phase 1 actually did"
at the end — three ConPTY behaviours, none of which this plan predicted.

This document was written against the code as it stood at `7e86358` on
2026-09-10, and every file and line reference below was checked against it
rather than remembered. Line numbers will move.

The prompt for it was Tabby, which ships out-of-the-box profiles for Windows
PowerShell, PowerShell Core, CMD, Git Bash and every installed WSL distro. That
is a real gap: wRusTTY is a terminal client that cannot open a terminal on the
machine it is running on. Searching `crates/` and `src-tauri/src` for
`conpty`, `pty` or `spawn` returns nothing, and `docs/TODO.md` does not list it
— so this is a new transport rather than an unfinished one.

---

## The finding this plan turns on

The seam is already the right shape, and it was made the right shape
deliberately. `crates/wr-core/src/connection.rs` splits the contract in two:

```rust
pub trait Connector: Send + 'static {
    type Session: Session<Error = Self::Error>;
    async fn connect(self, events: Sender<ConnectionEvent>) -> Result<Self::Session, Self::Error>;
    fn retryable(_error: &Self::Error) -> bool { true }
}

pub trait Session: Send {
    async fn write(&mut self, data: &[u8]) -> Result<(), Self::Error>;
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), Self::Error>;
    async fn disconnect(&mut self) -> Result<(), Self::Error>;
}
```

Its own doc comment states the intent outright: *"adding a protocol later means
adding a crate, not touching frontend or session-management code."* This plan is
the first test of that claim, and it mostly holds.

Everything that is not protocol-specific already lives in
`src-tauri/src/session_registry.rs`: the slot state machine, reconnect, status
plumbing, the queue-and-replay of input arriving mid-handshake, and the
raw-bytes data channel with its credit window. The registry is generic over
`C: Connector` and keyed by a `prefix: &'static str`
(`src-tauri/src/session_registry.rs:483`) that both namespaces session ids and
names the transport. A fourth prefix is a fourth string.

The measure of what a command layer costs is `src-tauri/src/telnet.rs`: **107
lines**, of which the substance is an event enum and four `#[tauri::command]`
entry points that exist only because `generate_handler!` needs concrete
functions. That is the template, and a local shell needs less than telnet did —
no host, no port, no credential, no vault.

**The backend is small. The frontend is the long tail.** Listing the frontend
files that mention `serial` gives 33 of them. That number, not the crate, is the
honest size of this feature.

---

## What is actually being copied, and what is not

Worth separating from the marketing, because two thirds of the Tabby feature
list here is one mechanism wearing three hats.

**Local profiles are a process on a ConPTY.** PowerShell, PowerShell Core, CMD
and Git Bash differ only in which executable is launched and where it was found.
There is no per-shell machinery.

**WSL is not a subsystem to support.** A WSL distro is a local profile whose
command is `wsl.exe -d <distro>`. It needs distro enumeration and nothing else.

**"Modern tab completion" is not a feature to build.** PSReadLine runs inside
PowerShell and does its own completion; it works the moment the shell has a real
pseudoconsole and the terminal encodes keys correctly. Ghostty's core already
handles the keyboard side, including the Kitty protocol. So there is nothing to
implement — this is a smoke test, not a workstream.

The risk is the inverse of the one the marketing implies. PSReadLine repaints
the whole edit buffer on every keystroke and rewraps long lines by rewriting
them, which is historically where ConPTY hosts discover their own bugs. If
anything goes wrong here it will be in the renderer's wrap handling under a
rapid full-line rewrite, not in completion.

---

## Five decisions, taken here

### 1. One synthetic identity, chosen centrally

A local session has no host, and `host` looked load-bearing. On checking, it is
mostly not — both stores that appeared to need one are already generic, and they
were made generic for reasons that cover this case exactly.

`src-tauri/src/command_history.rs:83` groups entries by *"an opaque host key the
frontend chooses"*, explicitly so that renaming the scheme is a frontend change
and the Rust side never learns how a host is identified. `historyKey` in
`src/lib/commandHistory.ts:56` builds `${protocol}://${user}${host}${port}`, and
serial already exploits the looseness: `src/lib/commandHistory.ts:89` passes the
COM port name as the "host". Logging is the same story — `logging.rs:198` names
files `{sanitize(&label)}-{timestamp}.log` from a caller-supplied label
(`logging.rs:128`), never from a hostname.

So the decision is small, and the point of taking it here is that it must be
taken **once** rather than improvised at each call site:

> A local session's identity is `local://<shell-id>`, where `<shell-id>` is the
> detected shell's stable id (`pwsh`, `powershell`, `cmd`, `git-bash`,
> `wsl:<distro>`), and a saved local profile files under `profile://<id>` like
> every other saved session.

**Under decision 2 this is mostly a logging label.** A PowerShell or CMD pane
records no history at all, so its identity is only ever a filename. It still has
to be chosen here rather than left to the logging call site, because the
bash-family shells *do* record — and for those the key is doing real work.

Two consequences worth stating, both about the bash-family case. Distinct shells
get distinct histories, which is right: pooling a WSL Ubuntu history with a Git
Bash one would mix two filesystems that share almost no paths. And `wsl:Ubuntu`
is keyed by distro rather than by the `wsl.exe` that launched it, because the
history belongs to the distro's filesystem and shell, not to the launcher — the
same reasoning that files a saved SSH session under its profile id rather than
its current address (`src/lib/commandHistory.ts:62`).

### 2. Autocomplete follows the existing per-shell rules — no new policy

The first draft of this plan invented a rule here. It did not need to: the
existing one already covers local sessions exactly, and `docs/TODO.md:406` states
it in as many words —

> PowerShell and CMD hosts stay a non-goal: the prompt and echo model differs
> enough to be its own piece of work. Note this is *autocomplete* only — those
> hosts do get shell integration.

That rule is about a **shell family**, not about a transport, so it carries over
to a local pane unchanged. Nothing in `AUTOCOMPLETE_PLAN.md` or `TODO.md` needs
amending.

**Local PowerShell and CMD: no wRusTTY autocomplete.** The reason the non-goal
exists still holds — the screen-scraping path (`HistorySource::screen`,
`command_history.rs:55`) infers commands by recognising a prompt and the echo
after it, and PowerShell's prompt is arbitrary user code that PSReadLine repaints
continuously. Pointed at one, it would file fragments of half-redrawn edit
buffers as commands.

But the stronger reason is that **the shell already does this better than we
could.** PSReadLine's Predictive IntelliSense runs in-process, completes against
the real command grammar via `TabExpansion2`, and draws on PowerShell's own
persisted history at `(Get-PSReadLineOption).HistorySavePath`. None of that needs
a terminal's cooperation, and all of it works in wRusTTY the moment the pane has
a pseudoconsole. A history-backed suggestion list from us would be a worse
duplicate of something already good.

This is the case wRusTTY's own autocomplete was never for. It earns its keep over
SSH, where the far end may have no PSReadLine equivalent, where history has to be
keyed per-host and survive the session, and where the box on the other end is
sometimes a switch with barely a shell. Locally, none of those hold.

**Local WSL and Git Bash: ordinary bash hosts.** These are the case the feature
*was* built for — bash and zsh have no inline prediction, only `Ctrl+R` and
up-arrow — and both the screen harvest and the POSIX OSC 133 snippets in
`docs/SHELL_INTEGRATION.md` work on them unchanged. They need no special-casing:
a local bash pane should behave exactly like a remote one.

**Shell integration is still worth having on local PowerShell**, just not for
this. `docs/SHELL_INTEGRATION.md:349` carries a tested OSC 133/633 snippet for
`pwsh` 7, and what it buys is command-finished notifications and exit codes
(`src-tauri/src/attention.rs`) plus cwd tracking via OSC 7. That is the
"those hosts do get shell integration" half of the rule above, and it applies
locally for the same reasons it applies remotely.

No PowerShell release emits OSC 133 by default as far as is known — VS Code
injects its own profile script and Windows Terminal documents an opt-in snippet
— so the snippet stays a manual step. Worth re-checking empirically against
whatever `pwsh` is current once the Phase 1 spike can run one.

### 3. No file browser on a local session

`wr-sftp` is SSH-only by construction — it speaks the SFTP subsystem over a
russh channel. `wr-fs` is not a counterpart to it; it is 317 lines of
write-a-file-atomically used by the vault and the profile stores, and it has no
directory listing, no transfer, no watcher.

A local file browser is therefore not a small addition to this work. It is a
separate project with its own panel semantics (there is no transfer; drag-drop
means copy, not upload; the "remote" side is the same filesystem a file dialog
would open), and bolting a stub onto this one would ship a Files button that
opens an empty panel.

**Gate it off.** `src/lib/dropUpload.ts:17` types the transport as
`'ssh' | 'telnet' | 'serial'` under the comment *"SSH is the only transport with
a file channel at all"* — adding `'local'` to that union keeps the existing
rejection path correct with no new logic. The Files affordance follows the same
rule it already follows for telnet and serial.

### 4. The security posture shifts, and that is accepted

This is the first time the app spawns a child process. Three things change, and
they are recorded here so the change is deliberate rather than discovered:

- **A saved profile becomes executable content.** `profiles.json` in appdata is
  a plain unsigned file that currently describes where to connect; after this it
  can describe what to run. Anything that can write that file can run code as
  the user the next time a profile is opened.
- **Workspace restore launches it unattended.** `src-tauri/src/workspaces.rs`
  restores sessions on startup, so a local profile in a restored workspace runs
  its command without anyone pressing anything.
- **The process is a child of the app**, and inherits its environment and
  working directory unless told otherwise, in a process that also holds
  decrypted vault secrets in memory.

None of this is unusual — Windows Terminal, Tabby and VS Code all do exactly it,
and a terminal that cannot run a command is not a terminal. It is accepted as
the cost of the feature. The mitigations that follow are cheap and belong in the
implementation rather than in a policy: pass an explicit environment rather than
inheriting wholesale, set an explicit `cwd`, and never build the command line by
concatenating strings — `portable-pty`'s `CommandBuilder` takes argv as a
vector, which is what keeps a distro name or a path with a space from becoming
an argument boundary.

The one thing this decision does **not** license is a "run this command on
connect" field on the profile form. That is a different feature with a different
risk, and it is out of scope here.

### 5. Auto-reconnect defaults off for local sessions

A local relaunch would sail through every gate that exists. It needs no
credential, so the rule in `src/lib/sessionSnapshot.ts:32` that keeps
password-auth sessions out of the reconnectable set never fires; it costs
nothing, so `Connector::retryable` has no reason to refuse; and it always
succeeds, which is worse rather than better.

`crates/wr-core/src/events.rs:9` already draws the line that matters:

```rust
pub enum DisconnectKind {
    Closed, // the far end finished — "which is what typing `exit` looks like"
    Lost,   // nobody chose this, so it is the kind worth undoing
}
```

Child exit maps to `Closed`, so typing `exit` will not respawn a shell even with
reconnect on. But `Lost` on a local shell means the process died — crashed,
killed from Task Manager, or terminated by something else — and silently
resurrecting it in all three cases is wrong. A crashed shell should leave its
scrollback on screen with a dead pane, because the scrollback is the evidence.

**Local profiles default `autoReconnect: false`.** The field already exists on
both profile structs (`src/lib/profiles.ts:50`, `src-tauri/src/profiles.rs:85`) and
is documented as opt-out only, so this is a default rather than a new mechanism.
A user who wants a self-respawning shell can still ask for one.

---

## Phase 1 — `wr-local`

A crate implementing `Connector`/`Session` over a Windows pseudoconsole.

**Take the `portable-pty` dependency.** The alternative is hand-rolling ConPTY
against the `windows` crate already pinned at `=0.62.2` in
`src-tauri/Cargo.toml`, which avoids a new dependency tree at the cost of real
unsafe Win32: `CreatePseudoConsole`, a `PROC_THREAD_ATTRIBUTE_LIST` whose
lifetime must outlive the spawn, handle-inheritance discipline, and the classic
trap where failing to close your own copy of the write handle means the
pseudoconsole never reports exit and the session hangs forever in `Connected`.
`portable-pty` has all of that, plus `ResizePseudoConsole`, and a Unix path if
this ever needs one.

Its cost is that its I/O is blocking `Read`/`Write` over `Box<dyn>`, so the
reader and writer must live on `spawn_blocking` threads bridged to the
`mpsc::Sender<ConnectionEvent>` the trait hands in. That is not new ground here:
`crates/wr-serial/src/session.rs:39` already documents why serial multiplexes
all I/O through one owner, and a local shell is the simpler case — there are no
DTR/RTS/break control commands to interleave, only reads, writes and a resize.

Two things differ from every transport already in the tree:

**`resize` is real work.** Telnet sends NAWS and serial's is a documented no-op
(`src/lib/connection.ts:220`). Here it is `ResizePseudoConsole`, and getting it
wrong is immediately visible — PSReadLine and every full-screen program read the
new size and repaint against it.

**The session ends by itself.** SSH, telnet and serial all end because something
external went away. Here the child exits, and the exit code is information the
user wants. Wait on the child on its own thread and map:

- child exited → `ConnectionStatus::Disconnected(DisconnectKind::Closed)`, with
  the exit code carried into the status label
- spawn failed, or a pipe errored while the child was still alive →
  `Failed(..)` / `Disconnected(Lost)`

`Connector::retryable` should return `false` for spawn failures whose cause is
structural — the executable does not exist, the distro is not installed — since
retrying those unattended is a loop that cannot succeed. That is the same
judgement its doc comment describes for SSH auth failures, applied to a cheaper
error.

Config is small, and every field is there to serve decision 4:

```rust
pub struct LocalConfig {
    pub command: String,            // absolute path, resolved at detection time
    pub args: Vec<String>,          // argv, never a concatenated command line
    pub cwd: Option<String>,        // explicit; None means the user's home
    pub env: Vec<(String, String)>, // explicit additions, not inheritance
    pub term_type: Option<String>,  // xterm-256color; matters for WSL, ignored by PowerShell
}
```

Rough size: 400–600 lines with tests. The trait impl is the easy half; process
exit and handle-close discipline is where the time goes.

## Phase 2 — the command layer

`src-tauri/src/local.rs`, mirroring `telnet.rs` almost line for line: a
`LocalEvent` enum with a `Status` variant, a `LocalState` wrapping
`SessionRegistry::new("local")`, and `local_connect` / `local_write` /
`local_resize` / `local_disconnect` registered in the `generate_handler!` block
at `src-tauri/src/lib.rs:61`. `local_resize` must call
`crate::logging::note_resize` before resizing, as telnet's does — the marker
goes down before the size it announces.

Add `Local` to `Protocol` in `crates/wr-core/src/session.rs:19`.

Reconnect wiring is the telnet shape: no credential to re-resolve, so the
rebuild closure just clones the config. `NoPrepare` and `NoRestore` both apply.

Rough size: ~150 lines.

**On the spike.** An earlier draft of this section claimed Phase 1 plus Phase 2
"gets `pwsh` running in a pane". It does not, and the distinction matters now
that both are built: these two phases make a local shell *reachable over IPC*,
but a pane requires a caller, and nothing in the frontend invokes
`local_connect` until Phase 4. Seeing it on screen needs a thin slice of Phase 4
first — the `ConnectionSource` variant, the `invoke` arm and `transportOf` —
which is worth taking early precisely because the DSR finding below can only be
confirmed against the real engine.

## Phase 3 — detection

A `local_shells_list` command, mirroring the shape of `serial_ports_list` in
`crates/wr-serial/src/ports.rs`: enumerate what exists, return stable ids plus
display labels, and let the frontend render a list it did not have to build.

Registry reads are already a capability — `Win32_System_Registry` is in the
`windows` feature list in `src-tauri/Cargo.toml` for the PuTTY importer, and
that block's comment already promises the app only ever reads.

- **`pwsh.exe`** — `%ProgramFiles%\PowerShell\7\pwsh.exe`, then the Store
  install, then `PATH`.
- **`powershell.exe`** — `%SystemRoot%\System32\WindowsPowerShell\v1.0\`.
- **`cmd.exe`** — `%ComSpec%`.
- **Git Bash** — `HKLM\SOFTWARE\GitForWindows\InstallPath`, then `bin\bash.exe`.
  Launch with `-i -l`.
- **WSL distros** — enumerate
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`, reading
  `DistributionName` and `State` per subkey. **Not** by parsing `wsl.exe -l -v`,
  whose output is UTF-16LE with padding and decorations and has burned everyone
  who has tried it. Skip distros whose `State` is not installed.

One trap worth writing into the code rather than rediscovering: the
`%LocalAppData%\Microsoft\WindowsApps` entries for `wsl.exe` and `pwsh.exe` are
zero-byte reparse points. Probing them by path succeeds and yields a launcher
stub rather than the binary, so prefer the real install locations and treat the
`WindowsApps` path as the last fallback.

Detection is a snapshot taken when the dialog opens, not a watcher. Unlike COM
ports, nothing here is hot-plugged.

Rough size: ~250 lines with tests. The registry and path probing are both
straightforwardly testable behind a small trait; the launch itself is not, and
does not need to be — Phase 1's tests cover that.

## Phase 4 — the frontend

The long tail, and the reason this is a multi-day feature rather than a one-day
one. The real switch sites, all verified:

- `src/state/connectDraft.ts:7` — the `Protocol` union, plus the port and
  term-type defaults at `:167` and `:177`, neither of which applies to a local
  shell and both of which need a branch.
- `src/components/ConnectDialog.tsx:536` — the hard-coded
  `['ssh', 'telnet', 'serial']` tab list, plus `protocolIcons`, plus a
  `LocalFields` component alongside `SerialFields` at `:556`.
- `src/lib/connection.ts` — a `local` and a `localProfile` variant on
  `ConnectionSource`, the `invoke` arm, and `transportOf` at `:170`. That
  function's own comment records what happens when a new variant is added and
  this is missed: writes and disconnects silently route to the SSH commands.
- `src/lib/commandHistory.ts:56` — the `local://` key from decision 1, and the
  shell-family gate from decision 2. A PowerShell or CMD pane returns no key and
  records nothing; a WSL or Git Bash pane behaves like any other bash host.
- `src/lib/sessionSnapshot.ts:32` — local sessions are restorable (nothing to
  collect) but default to no auto-reconnect, per decision 5.
- `src/lib/dropUpload.ts:17` — add `'local'` to the transport union, per
  decision 3.
- `src/lib/profiles.ts:13` and `:132` — the protocol discriminator and the
  summary line, plus a `local: LocalProfile | null` field mirroring the existing
  `serial: SerialProfile | null` at `:58`.
- `src-tauri/src/profiles.rs` — the same field, `#[serde(default)]` so profiles
  saved before it existed still parse. The `default_protocol` helper stays
  `"ssh"`.
- `SessionBrowser.tsx:364`, `QuickConnectPalette.tsx:85`, `StatusBar.tsx`,
  `TabBar.tsx`, `paneFlood.ts` — icons, labels and per-transport affordances.

The `serial` precedent is worth following closely, including the part where
frontend-only config is stripped before `invoke` (`src/lib/connection.ts:141`) —
a local shell does not currently need that, but the pattern is where any future
presentation-only field belongs.

---

## What must not regress

- **Session ids stay namespaced.** The `"local"` prefix is what keeps a local
  session id from colliding with an SSH one in the coalescer's credit table, the
  logging sink and the frontend's pane map.
- **`transportOf` stays exhaustive.** The union is the only thing making the
  compiler catch a missed variant; widening the return type without adding the
  arm is the failure its comment already describes.
- **A dead local pane keeps its scrollback.** The pane is keyed
  `${leaf.id}-${leaf.generation}` (`src/App.tsx:1472`), and anything that bumps the
  generation on a child exit throws away the output that explains the exit.
- **Screen-harvest autocomplete never runs on a PowerShell or CMD pane** —
  local or remote. That gate belongs where the source is chosen, keyed on the
  shell family, not filtered afterwards and not keyed on the transport: a local
  bash pane must keep harvesting exactly as a remote one does.
- **The engine keeps answering `ESC [ 6 n`.** A local pane's shell does not
  start until it does — see "What Phase 1 actually did". Nothing should route a
  local session's output around the engine, or filter query replies out of the
  path back to `local_write`.
- **The dialog's other protocols are untouched.** Adding a fourth tab must not
  change SSH's port default, term-type default, or which fields the form shows
  for the existing three — `ConnectDialog.test.tsx` covers this.

## What this plan does not decide

- **A local file browser.** Out of scope by decision 3, and a real project if it
  is ever wanted.
- **Non-Windows local shells.** `portable-pty` would give bash on Linux and
  macOS nearly free, but nothing else in this app targets those platforms yet
  and pretending otherwise in the detection layer would be speculative.
- **A "run on connect" command field.** Explicitly excluded under decision 4.
- **Default profiles on first run.** Whether a fresh install auto-populates a
  PowerShell entry in the session browser, or leaves the user to add one, is a
  product call better made once the dialog exists.
- **Elevated shells.** Launching as administrator needs a UAC transition that a
  ConPTY spawn cannot perform, so it would take a different mechanism entirely.

---

## What Phase 1 actually did

Built as `crates/wr-local`, on `portable-pty` 0.9 as planned, with ten tests —
five on the config's serde shape and five that spawn real processes. Three
things about ConPTY were found by writing those tests the obvious way and
watching them fail, and all three outlive Phase 1.

### ConPTY blocks until the terminal answers a cursor query

A pseudoconsole opens by writing `ESC [ 6 n` — "where is the cursor?" — and
**emits nothing further until it gets an answer**. The first version of the
output test hung for its full 20-second deadline having received exactly six
bytes.

This is not something `wr-local` should fix. Answering is the emulator's job,
and in the app Ghostty's VT core does it: the reply travels back out through
the same channel as keystrokes, which `GhosttyEngine.ts:1702` already documents
("the merged output channel also carries mouse reports and query replies").
Answering it in the transport instead would mean replying to queries a real
terminal answers differently, and racing the engine to do it.

But it makes the engine's reply path **load-bearing for local sessions in a way
it never was for remote ones**. Over SSH, a terminal that failed to answer DSR
would break a few full-screen programs; here it means the shell never starts.
That belongs in the Phase 2 smoke test: if a local pane opens and stays blank,
this is the first thing to check.

### ConPTY is a renderer, so very short-lived output can be lost

ConPTY emits a rendered view of the console screen buffer, not the child's byte
stream, and it paints on its own schedule. `cmd /c echo marker` produced only
ConPTY's init sequences — the text never appeared. The same command followed by
a one-second wait produced it.

Every Windows terminal has this, and it cannot reach an interactive shell, which
lives for minutes and is painted continuously. It reaches the *tests*, which is
why `linger()` exists there. Worth knowing before someone reports "output is
missing" against a profile that runs a command and exits.

### Dropping the slave is a Unix requirement, not a Windows one

The plan called out the classic ConPTY trap — hold an extra handle and the
pseudoconsole never reports the child's exit. `session.rs` drops the slave for
it, but the reasoning only applies on Unix: `portable-pty` gives
`ConPtyMasterPty` and `ConPtySlavePty` the same `Arc<Mutex<Inner>>`, and `Inner`
owns the `PsuedoCon` whose `Drop` closes the pseudoconsole, so dropping one half
just decrements a refcount the other still holds. On Windows, EOF comes from
conhost closing the pipe when the child exits. The drop stays — it is required
on Unix and harmless here — but the comment saying why is now accurate rather
than inherited from the raw Win32 pattern.

## What Phase 2 actually did

`src-tauri/src/local.rs`, 120 lines, the telnet shape throughout: a `LocalEvent`
enum, a `LocalState` over `SessionRegistry::new("local")`, and four commands
registered in `lib.rs`. `Protocol::Local` added to `wr-core`. Compiles, passes
`clippy -D warnings` and the full workspace suite — but **nothing has exercised
it at runtime**, because no caller exists yet.

Two things worth recording:

**`local_connect` takes `cols`/`rows`; telnet does not.** A pseudoconsole is
given its size at creation and there is no deciding later, so passing the pane's
size is what stops the shell drawing its first prompt at 80 columns and
reflowing when the registry replays the real one. The reconnect factory carries
the size for the same reason.

**Auto-reconnect cannot currently fire for a local session, and that is
decision 5 holding structurally rather than by policy.** The registry retries on
`DisconnectKind::Lost`, and `wr-local` only ever reports `Closed` — a shell has
either exited or it has not, so there is no state where the process is gone but
the session should return by itself. The factory is still wired up, correct and
unreachable, so that a future `Lost` (a pty read failing under a live child)
relaunches properly rather than finding no way to.

## What the Phase 4 slice did

Enough of Phase 4 to open a pane, taken early because the DSR finding could
only be confirmed against the real engine: a `local` variant on
`ConnectionSource` with its `invoke` arm and `transportOf` case, `lib/local.ts`,
a `LocalFields` form, a fourth tab in the connect dialog, and the display cases
in `TabBar`, `App`'s status bar and `sourceLabel`.

**It works.** `pwsh` 7.6.5 runs in a pane, in the user's home rather than the
app's working directory, with input, output, PSReadLine's syntax highlighting
and its inline prediction all behaving. The status bar reads
`LOCAL pwsh Connected`.

Three things came out of it.

**The DSR dependency is confirmed satisfied, and now has a test.** The shipped
core answers `ESC [ 6 n` with the true cursor position, drained by
`GhosttyEngine.drainResponses` and routed back through `conn.write` — which is
source-generic, so a local session gets it for free.
`src/lib/ghostty/cursorReportLive.test.ts` pins it against the *shipped* binary
through `wasmBindings`, one layer above `main/effects.test.ts`, and says in its
own comment why a local pane in particular depends on it.

**A local pane auto-closes on exit, and takes the exit notice with it — and
that is correct.** `closeOnDisconnect` defaults to `true`
(`src/lib/settings.ts:500`), and a shell exiting is a clean `disconnected`, so
the pane is gone before `[process exited with code N]` can be read. That was
raised as a possible defect and resolved as **matching the native console
deliberately**: `pwsh.exe` launched from Explorer closes its window on `exit`
whatever the code, and a terminal that kept a dead pane around after `exit`
would surprise anyone coming from the thing it is replacing.

The exit notice therefore serves the case where the setting is off, which is
what that setting is for. **No code change** — the behaviour already matched.

Where a local pane deliberately does *not* match the native console is a shell
that fails to start: `isCleanDisconnect` (`src/lib/connection.ts:291`) counts
only `disconnected`, so a `failed:` status leaves the pane open on its overlay
with the reason visible. Native `pwsh` flashes the window shut and loses it.
Better is the right call there, and it is the reason `LocalError::NotFound` is
told apart from a spawn failure at all.

**The reconnect checkbox is offered for local sessions and cannot do
anything.** Harmless today, since auto-reconnect fires only on `Lost` and
`wr-local` never reports one, but the form should not offer a control that has
no effect. Phase 4 proper should hide it, alongside defaulting a saved local
profile's `autoReconnect` to `false`.

### Smaller things settled in code

- **The exit code goes into the output stream**, not the status.
  `ConnectionStatus::Disconnected` has no field for it, and adding one would
  touch every transport's match arms to serve a case only this one has. A dim
  `[process exited with code N]` line is what Windows Terminal, WezTerm and
  kitty all print, and it puts the code in the scrollback that explains it.
- **The wait thread is the only source of a terminal status.** The reader says
  nothing at EOF, so the status carrying the exit code can never be raced by one
  that does not.
- **`retryable` is false for `NotFound` and `Spawn`**, true for `Pty`. A missing
  executable is checked for before the pseudoconsole is opened, which is both
  cheaper than recovering it from an `anyhow::Error` afterwards and the case a
  stale saved profile actually produces.
