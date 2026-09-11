# Elevated tabs

Implementation plan for a local shell running as administrator, in a tab of
an ordinary, unelevated wRusTTY window.

**Phases 1–3 are built, and the whole path has been through a real UAC
prompt**: an unelevated wRusTTY opened an administrator `cmd` through the
elevated host and pipe. Phase 4 — the UI — is not built, so nothing in the
app asks for an elevated tab yet. What changed on contact is in the "actually
did" sections at the end.

Written against the code at `e7216ed` on 2026-09-10; every file and line
reference was checked against it rather than remembered. It builds on
`docs/LOCAL_SHELL_PLAN.md`, whose "Elevated shells" entry this replaces.

---

## What is being asked for, and who already does it

An administrator PowerShell (or cmd, or Git Bash) in a tab beside normal ones,
after one UAC prompt, with no system setting to enable first.

That is **not** what Windows Terminal does, which is worth being exact about
because it is the obvious reference. In Terminal a whole window is either
elevated or not. A profile marked `elevate`, opened from an unelevated window,
opens a **new elevated window**; only from a window that is already elevated
does it open as a tab ([Microsoft Learn][wt-elevate]). Admin tabs sitting in the
same window as everything else usually mean that window was started as
administrator — and then every tab in it is elevated, not just the one meant to
be. Microsoft's stated reason for refusing to mix the two is the risk recorded
under decision 1 below.

Mixed tabs are what **Tabby** does, with a small bundled `UAC.exe` wrapped
around the shell (`tabby-electron/src/services/uac.service.ts`), and what
**gsudo** does. Windows' own **Sudo**, in its *Inline* mode, does it too — but
Sudo is off by default and turned on under Settings → For developers, with
admin rights, which is too much to ask of someone for a standard feature. So
this plan builds its own, in the Tabby/gsudo shape, and treats Sudo as not
required.

---

## Why a local tab cannot simply be elevated

`wr-local` starts a shell with `CreateProcess` on a pseudoconsole. Three things
stop that from producing an administrator shell:

- **`CreateProcess` cannot request elevation.** Only `ShellExecuteEx` with the
  `runas` verb raises the UAC prompt and returns a high-integrity process.
- **`ShellExecuteEx` cannot be handed a pseudoconsole.** A pseudoconsole is
  attached through a `STARTUPINFOEX` attribute list, and `SHELLEXECUTEINFO` has
  nowhere to put one.
- **Even if it could, UIPI would stand between them.** A medium-integrity
  process is not allowed to drive a high-integrity one's windows or input.

The consequence is structural: something elevated has to own the
pseudoconsole. wRusTTY cannot.

---

## The design in one picture

```
 wRusTTY (you, medium integrity)                wrustty.exe --elevated-host (administrator)
 ┌──────────────────────────────┐   named pipe  ┌────────────────────────────────────┐
 │ tab → ElevatedConnector ──── │ ◄───────────► │ host ── LocalConnector ── ConPTY ──┼─► pwsh.exe
 │   (Connector/Session, like   │  framed bytes │   (the existing wr-local code,     │   (administrator)
 │    wr-local's)               │               │    unchanged)                      │
 └──────────────────────────────┘               └────────────────────────────────────┘
```

Opening an elevated tab runs `wrustty.exe` again through `ShellExecuteEx`/`runas`
in a windowless **host mode**. That one UAC prompt is the elevation. The host
starts the shell on a pseudoconsole using `wr-local`'s existing
`LocalConnector` — the shell never knows the difference — and relays bytes to
and from the tab over a named pipe. To the rest of the app the tab is one more
`Connector`/`Session`, which is the seam `wr-core` was built for.

Everything the tab does today still works through it, including the parts that
are easy to forget: the pseudoconsole's opening `ESC [ 6 n` is answered by the
tab's engine and relayed back like any keystroke (see `LOCAL_SHELL_PLAN.md`,
"What Phase 1 actually did"), resize is a relayed message, and the exit notice
with its code arrives as ordinary output, followed by a message saying the
shell is done.

---

## Six decisions, taken here

### 1. The risk is accepted, and recorded as two risks, not one

For as long as an elevated tab is open, a non-administrator program — wRusTTY —
holds a keyboard into an administrator shell. Two things follow from that:

- **Anyone at the machine** can use the tab for admin commands. This is the
  same as leaving any admin window open, and it was accepted as such.
- **Any program running as you** can do the same without being seen. Programs
  at your own integrity level can read wRusTTY's memory and send it input, and
  so can drive the elevated shell through it, with no UAC prompt of their own.
  This is the one Windows Terminal refuses over. It is accepted too, on two
  grounds: Microsoft itself does not treat UAC as a security boundary, and it
  ships exactly this model as Sudo's Inline mode.

Accepting it does not mean widening it. Decisions 2 to 5 exist to keep it to
*that* and nothing more — in particular, to make sure the elevated host can
never become a general-purpose way to run something as administrator.

### 2. The host runs one detected shell, for one tab, and then exits

- **It is told what to run when it is launched, not afterwards.** The shell's
  *id* (`pwsh`, `cmd`, …) is on the host's command line, fixed at the moment
  the UAC prompt was approved, and the host resolves it through
  `local_shells::detect` itself. Nothing arriving over the pipe can change what
  runs. There is no "run this command" message in the protocol at all.
- **Only detected shells can be elevated.** A hand-typed path cannot. Elevation
  is exactly where "run whatever path the profile says" would be most
  dangerous, and detection is what vouches for a binary.
- **One host per tab, and it lives only as long as the tab.** The host exits,
  killing its shell, the moment the pipe closes — whether because the tab was
  closed, the shell exited, or **wRusTTY itself crashed**. No administrator
  shell may outlive the window that asked for it.

WSL is left out of the first version (see "What this plan does not decide").

### 3. The pipe accepts exactly one client: the wRusTTY that launched it

- **The name is random**, 128 bits, generated by wRusTTY per tab:
  `\\.\pipe\wrustty-elevated-<hex>`.
- **The host creates the pipe**, with `FILE_FLAG_FIRST_PIPE_INSTANCE` (so if
  anything has created that name first, the host refuses to start rather than
  talk to it), `PIPE_REJECT_REMOTE_CLIENTS`, one instance, and a DACL granting
  only the current user.
- **The host checks who connected.** `GetNamedPipeClientProcessId` must equal
  the process id wRusTTY put on the host's command line, and that process's
  image must be the same `wrustty.exe` as the host's own. Anything else is
  disconnected and the host exits.
- **The host serves one connection and never accepts another.**
- **The tab checks who it reached, too.** `GetNamedPipeServerProcessId` must
  equal the process id of the host it launched, checked before the tab sends
  anything. Without it, something that created the pipe name first — which
  makes the real host refuse to start — would get the tab's connection in the
  moment before it noticed, and with it whatever is typed into what looks like
  an administrator shell. (Added in Phase 2; see below.)

### 4. Elevated tabs are never restored or reconnected automatically

A restored workspace or a reconnect would mean a UAC prompt appearing at a
moment the user did not choose, which trains people to click Yes. An elevated
tab restores as a blank pane offering "Open as administrator", and
auto-reconnect is off for it the same way it is for every local shell
(`LOCAL_SHELL_PLAN.md`, decision 5).

### 5. An elevated tab looks different, always

A shield on the tab and the word **Administrator** in the status bar, so there
is never a question which tab is the dangerous one. The shield replaces
nothing — it sits beside the shell's own icon.

### 6. Elevated tabs record no command history

What an administrator typed should not come back as a suggestion in an
ordinary tab. PowerShell and CMD record nothing anyway under
`LOCAL_SHELL_PLAN.md`'s decision 2; this extends that to an elevated Git Bash.

---

## The pipe protocol

Deliberately small, framed, and symmetric in format:

```
[type: u8][length: u32 little-endian][payload: length bytes]
```

| type | direction | payload |
|---|---|---|
| `Ready` | host → tab | none — the shell has started |
| `Data` | both | raw bytes: shell output one way, keystrokes and query replies the other |
| `Resize` | tab → host | `cols: u16, rows: u16` — and the tab's **first** message |
| `Exit` | host → tab | none — the shell exited; its code has already arrived as `Data` |
| `Error` | host → tab | UTF-8 message — the shell could not start |

No message names a program, a path, an argument or an environment variable, by
design (decision 2). The payload length is capped, and the host treats anything
malformed as a reason to exit.

---

## Phase 1 — the protocol and the host, testable without elevation

`crates/wr-local/src/elevated/`:

- `protocol.rs` — frame encode and decode, with the cap. Unit-tested,
  including truncated and oversized frames.
- `host.rs` — pipe server plus relay: accept the one client, verify it, start
  `LocalConnector`, pump `Data` both ways, apply `Resize`, send `Exit`. It uses
  no elevation of its own — it simply runs as whatever launched it.

That last point is what makes the whole path testable. An integration test
starts the host unelevated in-process, connects to it over a real pipe, runs
`cmd.exe` through it and checks output, input, resize and the exit code — the
same five things `crates/wr-local/tests/spawn.rs` checks today, through the
pipe instead of directly. Only the `runas` step can't be automated.

Tests for decision 3 go here too: a second client is refused, a client with
the wrong process id is refused, a pre-existing pipe of the same name makes the
host refuse to start.

## Phase 2 — the tab side

- `ElevatedConnector` in `wr-local`, implementing `Connector`/`Session`. It is
  handed a **launcher** rather than calling `ShellExecuteEx` itself: the app
  passes one that does `runas`, and the tests pass one that starts the host
  unelevated. That keeps the `windows` crate in `src-tauri`, where it is
  already pinned, and keeps this testable.
- The launcher in `src-tauri`: `ShellExecuteExW` on `std::env::current_exe()`
  with `runas`, `SEE_MASK_NOCLOSEPROCESS` so the tab holds the host's process
  handle, and `--elevated-host --shell <id> --pipe <name> --client-pid <pid>`.
- **Declining the UAC prompt** comes back as `ERROR_CANCELLED` (1223). That is
  a `Failed: elevation was declined` in the pane, and not retryable.
- **Waiting for the host** has no fixed timeout — the user may take a while
  over the prompt — but ends the moment the host process exits, which the
  process handle makes knowable.

## Phase 3 — host mode in the binary

`src-tauri/src/main.rs` is currently one line, `wrustty_lib::run()`. Host mode
has to branch **before** that: before Tauri, before a window, and above all
before `tauri_plugin_single_instance` (`src-tauri/src/lib.rs:38`), which would
otherwise see a second `wrustty.exe`, hand its arguments to the running window
and exit — silently turning every elevated tab into a no-op.

The release build is `windows_subsystem = "windows"`, so the host has no
console of its own and shows nothing, which is what is wanted: its only output
is the pipe.

## Phase 4 — the UI

- A **"Run as administrator"** checkbox on the local tab of the connect dialog
  and on a saved local profile, offered only for shells decision 2 allows.
- The shield and the **Administrator** status-bar label (decision 5).
- Restore as a blank pane with "Open as administrator" (decision 4).
- **Focus after the prompt.** The UAC prompt appears on the secure desktop and
  takes focus from wRusTTY. `src-tauri/src/win_focus.rs` already exists to
  reclaim focus after a higher-integrity Windows prompt (it was written for
  Windows Hello); the elevated tab should go through it rather than grow its
  own copy.

---

## What must not regress

- **No orphaned administrator processes.** Closing the tab, the shell exiting,
  and wRusTTY being killed outright must each leave no elevated host and no
  elevated shell behind. Checked by hand in Phase 4 with Task Manager's
  "Elevated" column, since it cannot be automated.
- **Ordinary local tabs are untouched.** They never go through the host.
- **A normal second launch still just focuses the running window.** Host mode
  is recognised by its argument, and only by its argument.
- **The host never runs anything but a detected shell** (decision 2), and the
  protocol has no way to ask it to.

## What this plan does not decide

- **One prompt per tab.** A long-lived broker could serve several tabs from one
  prompt, at the cost of an administrator process that outlives any one tab.
  One per tab is the conservative choice and can be revisited.
- **Elevated WSL.** Elevating `wsl.exe` does not make the Linux user root; it
  elevates only what WSL runs back on the Windows side. That is confusing
  enough to leave out until someone asks for it.
- **Using Windows Sudo when it is on.** If Sudo is enabled in Inline mode, the
  shell list could offer it as an alternative. Nothing here depends on it.
- **The UAC prompt's appearance.** An unsigned build gets the yellow "unknown
  publisher" prompt. Code signing (`docs/TODO.md`, item 1) turns it into a
  prompt that names wRusTTY — worth doing before this ships to anyone else.

---

## What Phase 1 actually did

Built as `crates/wr-local/src/elevated/` — `protocol.rs` and `host.rs` — with
13 unit tests on the frame codec and 12 integration tests in
`crates/wr-local/tests/elevated_host.rs` that run the host for real over a
named pipe, unelevated, driving `cmd.exe` through it. Stable across repeated
runs.

**The protocol table changed in two places**, both now reflected above:

- **`Resize` is the tab's first message.** A pseudoconsole is sized when it is
  created, and the pane may have been resized while the user read the UAC
  prompt, so the host waits for the tab's current size rather than taking one
  from its command line. A tab that opens with anything else is refused.
- **`Exit` carries no code.** `wr-local` already writes
  `[process exited with code N]` into the output, so the code reaches the tab
  as ordinary `Data`; `Exit` only has to say the shell is done.

**The pipe needed an explicit security descriptor, and not only for
tightness.** An elevated process's objects default to a *high* integrity
label, and no-write-up would then stop the unelevated tab from writing to its
own pipe. Their default permissions also go to the elevated token's owner —
usually the Administrators group, which the tab's filtered token holds only as
deny-only — while granting read to Everyone. So the defaults would have locked
out the one client the pipe is for and let everyone else read it. The host now
creates it with `D:P(A;;GA;;;<current user>)S:(ML;;NW;;;ME)`: full access for
the current user alone, labelled medium with no-write-up.

That needed Win32 security APIs inside `wr-local`, so the crate now depends on
`windows` — pinned to exactly the version `src-tauri` pins, which resolves to
the same single copy.

**Dropping a `LocalSession` now kills its shell.** `disconnect` already did,
but an early return or a cancelled task never reaches it. The host relies on
this for "no administrator shell outlives its tab", and it is a better
invariant for ordinary local tabs too. The existing suite is unaffected.

**Decision 3, tested:** a pipe name without the host's prefix is refused; a
name something else created first stops the host from starting; a client whose
process id is not the expected one is refused before the shell starts; a second
client cannot connect; a host-only frame from the tab ends the session; a tab
that does not send its size first is refused. The relay tests cover output,
input, the first and a later resize (read back from `mode con`), the exit, a
shell that cannot start, and the tab closing its end — which ends a
sixty-second shell well inside the test's ten-second limit.

Not yet checked, because only a real elevation can check it: that the
descriptor lets an *unelevated* tab reach an *elevated* host. The tests run
both ends at the same integrity level. That is the first thing to confirm in
Phase 2.

## What Phase 2 actually did

Built as `crates/wr-local/src/elevated/connector.rs` — `ElevatedConnector` and
`ElevatedSession`, taking an injected `Launcher` — and `src-tauri/src/elevation.rs`,
which holds the `runas` launcher and the `elevated_connect` / `_write` /
`_resize` / `_disconnect` commands on a registry of their own under the
`elevated` prefix. Nine integration tests in
`crates/wr-local/tests/elevated_connector.rs` drive the real connector against
the real host over a real pipe, with only the launcher replaced by one that
starts the host in-process; three unit tests pin the host's command line.

**The tab now checks the pipe's server**, the mirror of the host's check on
its client — added to decision 3 above. The plan had the host verifying who
connected but not the tab verifying what it connected to. Tested with a
launcher that creates a rogue pipe itself: the tab refuses it, and the rogue
end receives nothing at all, not even the size.

**A race, found by repeating the tests.** While waiting for the shell to start,
the tab first watched both the pipe and the host's exit. A host that cannot
start the shell writes its `Error` and exits at once, and when the exit won the
race, the real reason — sitting unread in the pipe — was replaced by "the
host exited before the shell started". It failed about one run in three. Once
connected, the host going away already shows on the pipe (what it wrote stays
readable, then the pipe ends), so the tab now watches only the pipe, bounded by
a timeout. Fifteen consecutive runs clean since; the host's own suite eight.

**Settled in code:**

- Declining the prompt is `ElevationDeclined` — "elevation was declined" in the
  pane — and the connector is never retryable: every retry would be a prompt.
- An elevated session only ever ends `Closed`, never `Lost`, so nothing can
  invite the registry to reconnect it; and `elevated_connect` passes no
  reconnect factory at all. The registry gained `NoReconnect` to say so.
- Dropping an `ElevatedSession` closes the pipe, which is what ends the host
  and its shell, so a tab that never calls `disconnect` still leaves nothing
  running.
- The host's process handle is waited on by a thread started at launch, not by
  a future that is only polled while connecting, which would have leaked it on
  every successful connect.
- The UAC prompt is parented to the main window, so it opens in front of it.
- Only `pwsh`, `powershell`, `cmd` and `git-bash` can be elevated, checked in
  the command and again in the launcher; the host's command line is refused if
  anything in it would need quoting.

**Still unverified: a real elevation.** Nothing has yet gone through an actual
UAC prompt, because `wrustty.exe --elevated-host` does nothing yet — that is
Phase 3. So the question left open at the end of Phase 1 is still open: whether
an unelevated tab can reach an elevated host through the pipe's descriptor.
Phase 3 is small, and the first real prompt answers it.

## What Phase 3 actually did

`main` asks `elevation::elevated_entry_point` before anything else, so
`wrustty.exe --elevated-host …` serves one shell and exits without Tauri, a
window or the single-instance plugin ever starting. Its command line is parsed
strictly — exactly the three options the launcher writes, in that order — and
the shell id is resolved by the elevated process's own detection, allowlist
first. Debug builds also have `--elevated-smoke`; release builds do not.

**The real-elevation check, done on 2026-09-10.** `wrustty.exe --elevated-smoke`
from an ordinary terminal, UAC prompt approved:

- the shell's `whoami /groups` showed `Mandatory Label\High Mandatory Level`
  (`S-1-16-12288`) and `BUILTIN\Administrators` as an *enabled* group, owner —
  a genuinely elevated token, not the filtered one;
- its title became `Administrator: C:\WINDOWS\system32\cmd.exe`;
- `exit` went through, the pane received `[process exited with code 0]`, and
  the run ended with exit code 0;
- afterwards no elevated `wrustty.exe`, `cmd.exe` or console host was left
  running.

That closes the question left open since Phase 1: the pipe's descriptor
(current user, medium label, no-write-up) does let an unelevated tab reach an
elevated host. It also exercised host mode's parsing, detection running
elevated, and the prompt itself, which showed the expected yellow
unknown-publisher banner for an unsigned build.

**A real declined prompt, done the same evening.** The same smoke run, with the
prompt answered **No**, reported `could not open the elevated shell: elevation
was declined` and exited at once, with no retry and no host or shell started.
So `ERROR_CANCELLED` maps to the declined error in practice, not only against
the stand-in launcher the tests use.

## What Phase 4 actually did

**A new connection source, not a flag on `local`.** `{ protocol: 'elevated',
shellId, profileId }` goes to `elevated_connect` and carries a shell id only —
never a command line — so the frontend has no way to ask the host for anything
decision 2 did not allow. Everything keyed on the transport treats it as its
own case: `historyKeyForSource` returns null (decision 6), `sessionSnapshot`
never restores it connected, and drag-and-drop upload knows it as `elevated`.

**The checkbox.** "Run as administrator" sits under the local fields, with a
shield. It is enabled only when the picker has identified the shell *and*
`canElevate` accepts its id (`ELEVATABLE_SHELL_IDS` in `src/lib/local.ts`,
mirroring `ELEVATABLE_SHELLS`), so a hand-typed path or a WSL distro shows it
disabled with a tooltip saying why. It clears itself when the shell stops
qualifying — but not while detection is still answering, or editing a saved
administrator session would lose its tick in the instant before the list
arrives. Ticking it shows the risk from decision 1 in one sentence, where it is
chosen. `submit` checks `canElevate` again rather than trusting the box.

**Saved sessions.** `LocalProfile.elevated` (Rust `#[serde(default)]`, so older
profiles read as `false`). Opening a saved administrator session builds an
elevated source directly, with a UAC prompt, because opening it *is* the
deliberate click; its subtitle in the list ends in "· Administrator".

**Restore (decision 4).** `paneConnected` takes an optional `initialForm`,
merged into the pane's `initial`. An elevated connect passes the pane's own
form — same shell, box ticked, the saved id when there is one. The snapshot
drops the source as it does for every unrestorable one, but `sanitizeTabs` now
keeps a tab whose only pane was elevated, and `countUnsaveable` does not count
it as lost, since what comes back is that form rather than nothing.

**Marking it (decision 5).** An amber shield before the tab title, the shell's
own icon as the tab glyph, and `ADMIN` in amber in the status bar with
"<shell> · Administrator" as the target. Like an ordinary local tab it shows no
"Connected" dot once running.

**Focus after the prompt.** `RunasLauncher` calls
`win_focus::restore_after_broker_prompt` once `ShellExecuteExW` returns,
whichever way the prompt was answered.

**Tests.** `ConnectDialog.elevated.test.tsx` pins the box: enabled for a picked
PowerShell, disabled and cleared for WSL, not re-ticked on switching back,
disabled for a typed path, the warning only when ticked, and the source sent
each way. `sessionSnapshot.test.ts` and `commandHistory.test.ts` cover restore
and history.

**Not yet checked in the running app.** The in-app flow — tick, prompt, shield,
restart, restore as a form — and the Task Manager check for orphaned
administrator processes (see *What must not regress*) both need a rebuilt
`wrustty.exe` and a person at the prompt.

[wt-elevate]: https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-general
