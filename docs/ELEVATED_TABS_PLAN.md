# Elevated tabs

Implementation plan for a local shell running as administrator, in a tab of
an ordinary, unelevated wRusTTY window.

**Nothing here is built.** Written against the code at `e7216ed` on
2026-09-10; every file and line reference was checked against it rather than
remembered. It builds on `docs/LOCAL_SHELL_PLAN.md`, whose "Elevated shells"
entry this replaces.

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
"What Phase 1 actually did"), resize is a relayed message, and the exit code
comes back as its own message so the pane's exit notice still has it.

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
| `Resize` | tab → host | `cols: u16, rows: u16` |
| `Exit` | host → tab | `code: u32` — the shell exited |
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

[wt-elevate]: https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-general
