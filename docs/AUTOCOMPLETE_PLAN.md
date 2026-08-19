# Recent-command autocomplete

Implementation plan for suggesting previously-run commands as you type at a
remote prompt, in the shape Termius's "Helium" autocomplete has.

**Scope is recent commands only.** Not snippets, not password completion, not
path completion, not flag descriptions. Those are separate features with
separate storage and separate risks, and the command half is both the most
useful and the one this codebase is already most of the way to.

**All six phases are in.** The feature works end to end: it learns commands
from all three sources, reads the line being typed off the grid, offers
completions in a list under the prompt, and sends only the missing suffix when
one is taken.

What shipped differs from this plan in six places, each noted at the phase it
belongs to:

- **Phase 2 was smaller than budgeted.** The snippets already emit OSC 633
  `E`; only the routing was missing.
- **Phase 3 needed two engine additions this plan did not anticipate** — a
  render-snapshot sync, and deferring the `B` origin measurement until after
  the parse. Both are consequences of the OSC scanner running ahead of the
  parser, which is written up under "The hard part".
- **Phase 4 added a line-end condition** the plan did not state: a suggestion
  is only offered when the cursor is at the end of the line.
- **Phase 5's echo rule became a counting rule**, plus a store-side refusal of
  lines with no alphanumerics — which is what catches a password prompt that
  masks with `*` rather than echoing nothing.
- **Phase 6's per-host override is resolved in Rust, not the webview**, which
  avoided threading a boolean through seven files to reach the pane.
- **Phase 6 imports counts rather than timestamps**, because only zsh and fish
  record when a command ran and there is no honest per-entry time to invent.

Written against the engine as it stands after the ghostty-main port,
`readRows`/`RowText`, and the OSC 133 `CommandTracker`.

## What Termius actually does, and how much of it we want

Their docs are explicit about the mechanism:

> In remote sessions, Termius opens additional `exec` channels next to the
> main `shell` channel. It uses those channels to fetch data such as paths and
> command history.

Worth being precise about what that is and isn't. It is **not** a second SSH
connection — no second TCP handshake, no second authentication, no second
entry in the server's auth log, and no second Duo push for a host with 2FA at
connect time. It is `channel_open_session` on the connection that is already
up, followed by `exec` instead of `shell`. That is the same move
`get_or_open_transfer_sftp` already makes in `crates/wr-ssh/src/session.rs:123`
for bulk transfers, for the same reason: one stream serialises everything asked
of it, and the interactive one must not be made to wait behind bulk work.

So the answer to "does it run a parallel connection" is: parallel *channel*,
one connection. That distinction is the whole reason the approach is
acceptable here — a second connection would double the auth surface and would
be unusable on exactly the hosts this app targets (a jump box, a switch, a
device behind a 2FA gate).

It also explains their platform matrix. `exec` channels are an SSH feature, so
their autocomplete is available in SSH sessions and the local terminal and
nowhere else. Ours inherits the same shape: **telnet and serial get the
passive tier only** (Phase 2 below), because a telnet session is one byte
stream and a serial line is one wire. There is nothing to open a second
channel on, and it is not worth pretending otherwise.

## What already exists

- **`src/lib/shellIntegration.ts`** — a complete OSC 133 / OSC 633
  `CommandTracker`. It brackets the prompt (`A`, `B`), the command start (`C`)
  and the exit (`D`), tracks the alternate screen, and already parses
  OSC 633 `E;<commandline>` into `pendingCommand` and out through
  `CommandResult.command`. Where a host has shell integration installed, a
  correct, verbatim, per-command feed is *already arriving* and is currently
  used only to title a notification.
- **`onInput`** (`src/lib/terminalEngine.ts:92`) — user-originated bytes only:
  typing and paste, with mouse reports, focus reports and DSR replies already
  split off. Its doc comment says it is the callback anything redirecting
  input must use, which is exactly what this is.
- **`GhosttyEngine.readRows`** (`src/lib/ghostty/GhosttyEngine.ts:867`) plus
  `RowText.colStart` — per-column text for a row range, with grapheme
  clusters and wide-character spacers handled.
- **`GhosttyEngine.terminalCursorCell`** (line 2230) — cursor position in
  absolute buffer coordinates, i.e. already corrected for scrollback.
- **`renderer.getCellSize()`** — cell pixel metrics, used by
  `syncMouseSurface` at line 1010; what an overlay needs to sit on a cell.
- **`src/lib/remoteIdentity.ts`** — OSC 7 user/host/cwd, so history can be
  scoped and ranked per host and per directory.
- **`src-tauri/src/profiles.rs`** with `wr-fs` — the established pattern for
  an atomically-replaced JSON store.
- **`crates/wr-ssh/src/session.rs`** — `channel_open_session` on a live
  handle, twice already, with the head-of-line-blocking rationale written out.

Two of these are `private` on `GhosttyEngine` and need adding to the
`TerminalEngine` interface. That is the only engine surgery in the whole
feature.

## Where suggestions come from

Three tiers, best first. All three feed one store; the store does not care
which produced an entry beyond a provenance tag for debugging.

### Tier 1 — harvest the remote history file over an `exec` channel

On connect (lazily, on first prompt rather than during the connect path), open
one `exec` channel and read the shell's history file, then close it. One
round trip, a few tens of kilobytes, and the user has useful suggestions from
the very first keystroke on a host they have used for years — which is the
thing that makes the feature feel like it works rather than like it is
learning.

Notes that will otherwise be rediscovered:

- **Do not `cat ~/.bash_history` blindly.** The interactive shell has not
  flushed the current session's history yet, the file may be huge, and the
  path is shell- and configuration-dependent (`HISTFILE`, `zsh`'s extended
  format with `: <ts>:<dur>;<cmd>`, `fish`'s YAML-ish
  `~/.local/share/fish/fish_history`). Ask the shell instead, with a bounded
  command: `tail -n 5000 -- "${HISTFILE:-$HOME/.bash_history}"`, and parse per
  shell. The shell an `exec` channel gets is the *login* shell, which is the
  one whose history file we want.
- **Bound everything.** Byte cap on the response, a timeout, and one attempt
  per session. A host where this fails (no such file, restricted shell, a
  network appliance whose `exec` returns its own CLI) must degrade to Tier 2
  silently and permanently for that session, not retry.
- **`exec` is not always allowed.** `ForceCommand`, restricted shells and
  appliances will return something unusable. Detect and give up.

**Gated behind its own setting, separate from the feature's.** Every other
tier records what the user types in front of us. This one reaches out and
reads a file on their server that they never asked us to open, on a host that
is often not theirs alone — a shared jump box, a customer's appliance, a
production bastion whose history file is somebody else's audit trail. That is
a different question from "may this app remember my commands", and it gets a
different switch:

- `autocomplete.enabled` — the feature. Off by default until the user turns it
  on; when off, nothing captures, harvests or stores.
- `autocomplete.importRemoteHistory` — the Tier 1 harvest. Nested under the
  first, meaningless without it, and **off by default even when the feature is
  on**. Turning the feature on must never, on its own, cause the app to read a
  file on a remote host.

Both are per-host overridable, the same way the rest of the profile model
works, so the harvest can be on for the homelab and off for the customer's
bastion — or the reverse.

Two consequences for the implementation:

- The setting is read *before* the channel is opened, not before the result is
  stored. A harvest that runs and then discards its answer has still read the
  file and still shown up in whatever the host logs; that is the thing being
  avoided.
- Turning the setting off later does not retroactively delete what a previous
  harvest imported. It should therefore be possible to tell harvested entries
  from captured ones and drop just those — which the provenance tag the store
  already carries makes cheap. "Forget imported history" belongs next to the
  toggle.

### Tier 2 — OSC 633 `E`, free where shell integration is installed

`CommandTracker` already produces this, and — corrected from an earlier draft
of this plan, which claimed otherwise — the snippets in
`src/lib/shellSnippets.ts` already *emit* it. All three (bash's DEBUG-trap
preexec, zsh's `preexec` hook, fish's `fish_preexec`) print
`OSC 633 ; E ; <cmdline>` with the escaping the parser expects, and
`docs/SHELL_INTEGRATION.md` documents it in its sequence table. So a host set
up for shell integration has been reporting every command line it runs all
along, and this app has been parsing it and using it only to title a
notification.

The work is therefore routing alone: take `CommandResult.command` where the
tracker already hands it over and record it, instead of dropping it.

This tier is exact — no reconstruction, no guessing, no risk of recording
something that was never typed.

### Tier 3 — passive capture from the grid

The fallback, and the only tier telnet and serial get. Covered in the next
section, because it is the same machinery that tracks what is being typed
*now*.

## The hard part: knowing what is currently typed

Everything else in this plan is plumbing. This is the part that decides
whether the feature is pleasant or dangerous, so it gets the detail.

The naive design accumulates `onInput` bytes since the last Enter and calls
that the current line. It works in a demo and inserts garbage in real use,
because the line on screen is edited by things whose bytes we never see:

- readline history recall (Up arrow, `^R` reverse-i-search) replaces the whole
  line from the far side
- Tab completion inserts text the remote chose
- `^W`, `^U`, `^K`, `^A`/`^E`, Alt+B/F move and delete by units we would have
  to model exactly
- bracketed paste arrives as one blob but is echoed subject to the remote's
  own rules
- a wrapped line spans rows; a multi-line prompt starts partway down one
- the remote may not echo at all (a password prompt)

**So the keystroke buffer is a hint, and the screen is the truth.** The rule:

1. At OSC 133 `B` — prompt finished drawing — record the cursor cell. Call it
   the *input origin*.
2. On each keystroke, and on each parsed write coalesced to a frame, read the
   rows from the input origin's row to the cursor row and take the text from
   the origin column to the cursor column. That string is the current input.
3. Suggest against that string. Never against the keystroke buffer.

This falls out well:

- Tab completion, history recall and reverse-i-search all just work, because
  whatever they did is on screen and we read it.
- Wrapping works, because `readRows` plus the existing `is_row_wrapped` shim
  already reconstructs logical lines for links and search.
- **Password prompts record nothing, by construction.** Nothing was echoed, so
  there is nothing between origin and cursor, so there is nothing to store.
  That is a property of the design rather than a heuristic that has to
  enumerate what a password prompt looks like — and it is the reason to build
  it this way even though the keystroke buffer is easier.

Without OSC 133 (Tier 3 on a bare host) there is no `B` marker, so the input
origin has to be inferred: on the first keystroke after a period of quiet,
take the current cursor cell as the origin. Cruder, wrong sometimes, and the
suggestion is simply absent or unhelpful when it is wrong rather than
destructive — because acceptance re-reads the grid before sending anything.
Recording, in this tier, should be **conservative**: only store a line when
Enter follows a stretch where every typed printable character visibly landed
at the cursor. A single non-echoing keystroke disqualifies the whole line.

**Gates.** Suggestion is off entirely while:

- the alternate screen is up (`onBufferChange`) — vim's `:` line is not a
  shell prompt
- `CommandTracker` reports a command running
- the input is empty; never suggest at a bare prompt, which is a list rather
  than a completion, and is noise
- the pane is a serial line in Readline mode, where `LineEditor` owns input
  and has history of its own

## Ranking

Per host, then per directory, then global — with the more specific tiers
weighted up rather than searched exclusively, so a fresh directory on a known
host still gets that host's commands.

Frecency in the usual form: the score decays with age and increments on use,
and accepting a suggestion counts for more than merely typing the command.
Prefix matches first, then a **word-initials** match as a second-rank fallback,
ordered strictly below every prefix hit so the top suggestion is never
surprising.

Initials, and not the plain subsequence this plan originally called for. A
subsequence test shipped and was wrong in practice: a command line is long and
full of common letters, so almost any short input matched almost everything —
typing `exit` matched `/home/tim/Repos/xrdp/xrdp_accel_assist/...` on the `e`
of *home*, the `x` of *xrdp*, and an `i` and `t` out of *assist*. Ordering it
below prefix hits was not enough, because when nothing matches by prefix the
whole list is noise, and a list that answers something other than what was
typed is worse than an empty one. Two rules fix it: every matched character has
to begin a word, and the first has to begin the command — so `gcm` still
reaches `git commit -m`, and whatever is offered always starts with the letter
that was typed. Once a space has been typed the input is a command line being
written rather than an acronym, and only prefix matching applies.

Never suggest the line currently being edited back to itself, and never
suggest anything that is not strictly longer than what is typed.

## UI

A dropdown popover, not inline ghost text, for the first version.

Anchored at `originCol * cellWidth` by `(cursorRow - viewportTop + 1) *
cellHeight` within the pane, flipping above the cursor when it would fall off
the bottom, rendered as DOM over the canvas the way the existing pane overlays
are. Up to about five entries, the current one highlighted.

Inline grey ghost-text after the cursor is the prettier form and can come
later. It needs either a second draw path in the WebGL renderer or an
absolutely-positioned span that stays pixel-aligned through font changes, DPI
changes and re-fits. Not worth blocking the feature on.

Keys, chosen to collide with nothing the remote reasonably wants at a prompt:

- **Right arrow at end of line**, or **Tab while a suggestion is showing** —
  accept. Tab is contentious, being the remote's own completion key. The
  resolution: Tab accepts only when a suggestion is displayed and highlighted,
  and passes through untouched otherwise, so completing an unmatched prefix
  behaves exactly as it does today.
- **Up/Down** — never claimed. They always reach the remote shell.

  This plan originally gave them to the list "only while it is open", on the
  reasoning that the first Up on a closed list would still reach the shell.
  That shipped and was wrong twice over. Recalling a command **redraws the
  line**, which opened a list — so the second Up was eaten by a popup the first
  Up had just conjured, and history recall stopped working after one press. And
  even without that, a list opened by typing then swallowed the arrows of
  someone who had given up typing and gone hunting through history instead.
  Walking history is the single most common thing anyone does at a prompt.
- **Ctrl+Up/Ctrl+Down** — move through the list. No shell binds them, and they
  are claimed only while a list is showing.
- **Esc** — dismiss, sending nothing.

**A list only opens in response to typing.** The other half of the same fix,
and the more important one: a printable keystroke arms the offer and anything
else — an arrow, Home, `^R`, a function key — disarms it. Without this the list
follows the *contents* of the line, and a line rewritten by the far end reads
exactly like a burst of typing when it is read off the grid. Arming on intent
rather than content is what keeps a suggestion from appearing over the history
someone is in the middle of walking through.

**Acceptance re-reads the grid first.** Recompute the current input from the
screen, confirm the suggestion still extends it, then write only the missing
suffix through the existing `conn.write` path. If the input moved underneath
us — output arrived, the line was redrawn — dismiss instead of sending. This
is what makes a wrong input-origin guess harmless rather than destructive.

## Storage and secrets

The part to settle before any of the rest ships.

A plaintext JSON file of every command typed on every production host is a
meaningful new asset, and it sits badly beside how this app treats everything
else at rest: the vault holds one data key, secrets decrypt only in the Rust
process, and nothing decrypted goes back to the webview. Command lines
routinely carry credentials — `mysql -pHunter2`, `curl -H "Authorization:
Bearer …"`, `ansible-vault --vault-password-file`, an rsync URL with a token
in it.

Decisions to make explicitly rather than by default:

- **Where it lives.** Either a `wr-fs`-replaced file next to profiles, or
  inside the vault. The vault costs an unlock before suggestions work, which
  is bad for something that must feel instant — though the host list is
  already behind it. Leaning: its own file, encrypted under a key wrapped by
  the vault the way other secrets are, readable only in-process and only after
  unlock, with suggestions simply absent until then.
- **Redaction on write**, not on display: a pattern list applied before
  storing (`-p<anything>`, `--password=`, `Authorization:`, high-entropy token
  shapes), dropping the whole line rather than masking part of it.
- **Two switches, not one** — `autocomplete.enabled` and, nested under it and
  independently off by default, `autocomplete.importRemoteHistory`. Both
  per-host overridable. See Tier 1 for why the harvest does not ride on the
  feature's own toggle. Off means genuinely off: no harvest, no capture, no
  store.
- **A visible way to read and clear it.** If the app remembers what you typed,
  you get to see the list and delete from it.
- **It never leaves the machine.** No sync, no telemetry, not part of a
  workspace export.

## Phases

1. **Store and settings.** *(Done.)* The Rust-side store — scoped by host,
   frecency, redaction on write, atomic replace — plus the settings toggle and
   the view/clear UI. Nothing captures anything yet. The ranking and redaction
   tests are pure and went in first.

   Two decisions taken here rather than deferred. **The ranking runs in Rust
   and is queried per keystroke**, instead of shipping each host's entries to
   the frontend once and ranking there. The round trip buys keeping every
   command the user has ever run out of the webview — the same process that
   renders untrusted remote output — and handing it only the strings about to
   be shown. **The store is a plain `wr-fs`-replaced file**, not vault
   encrypted, because suggestions that need an unlock before they work are
   suggestions that feel broken; the command surface is shaped so that
   encrypting it later is a change to one module and nothing above it.
2. **Tier 2 capture.** *(Done.)* Route `CommandResult.command` into the store. Smaller
   than budgeted: the snippets already emit `E`, so no shell-side change is
   needed at all. At the end of this phase the app is learning, with no UI.
3. **Input tracking.** *(Done — `src/lib/promptInput.ts`.)* Four optional
   members on `TerminalEngine`, not the two budgeted: `cursorCell`,
   `readRowText`, `cellSize`, and `syncReadState`.

   The two extra ones are the same discovery from opposite ends. **The core's
   read snapshot is only rebuilt on a drawn frame**, so a read taken on the
   keystroke that caused it sees the previous frame; `syncReadState` rebuilds
   it on demand. And **the OSC scanner dispatches ahead of the parser** — at
   the moment `B` arrives the prompt it terminates has not been drawn, so
   measuring the origin there puts it at the *start* of the prompt and every
   read would include the prompt text as if the user had typed it. The
   measurement is deferred to `onWriteParsed` instead. The live test found
   both; the fake-grid unit tests could not have.
4. **UI and acceptance.** *(Done — `src/lib/autocomplete.ts` and
   `src/components/SuggestionPopover.tsx`.)* Popover, key handling,
   grid-revalidated acceptance.

   One rule added: **nothing is offered unless the cursor is at the end of the
   line.** Acceptance appends, so offering after a left-arrow or Home would
   splice text into the middle of the command and send something the user
   never composed. `PromptInput.atEnd` carries it.
5. **Tier 3 passive capture.** *(Done — `captureTypedLine` in Terminal.tsx.)*
   The "every typed character must visibly land" rule is implemented by
   counting printable bytes out against visible columns back: less on screen
   than went out means something swallowed it, and the thing that swallows
   keystrokes is a password prompt.

   That test has one blind spot the plan missed — a prompt that masks each
   character with `*` satisfies it exactly, since every character *did*
   appear. So the store refuses any line containing no letter or digit, which
   is a property no real command has and every mask does.
6. **Tier 1 harvest.** *(Done — `exec_capture` in `crates/wr-ssh/src/session.rs`,
   the parsing and `command_history_harvest` in `command_history.rs`.)* Its own
   setting and the per-host override first, then the `exec` channel behind
   them, per-shell history parsing, bounds and failure handling, and "forget
   imported history". Last, deliberately: the largest new surface, the only
   part that touches the SSH crate, and the only part that reads anything on
   the remote host.

   **The per-host override is resolved in Rust, not the webview.** The plan
   assumed the pane would know it, which would have meant threading one boolean
   from `sessions.json` through the tab reducer, the pane tree, App and Pane to
   reach `Terminal.tsx`. The profile is already readable backend-side, so the
   harvest command takes the global setting and a profile id and resolves both
   halves in one place — before it opens anything.

   **Counts are imported, timestamps are not.** Only zsh and fish record when a
   command ran; bash usually does not. So an entry arrives with how often it
   appears in the file, which is real information present in every format, and
   with the import time rather than a fabricated last-used — and an entry that
   already exists keeps its own timestamp, or every stale command in the file
   would come back looking like it was run a moment ago.

Phases 1–4 are the feature. 5 and 6 are how good it feels on the first day on
a host.

## Non-goals

- Snippets, saved commands, path completion, flag and argument descriptions.
- Password or credential completion. The vault deliberately does not hand
  secrets to the webview, and this is not the feature to change that for.
- PowerShell and CMD hosts. Termius excludes them too; the prompt and echo
  model differs enough to be its own piece of work.
- Any form of sync.

## Open questions

- Vault-encrypted store versus a plain file — the unlock-before-suggestions
  tradeoff above.
- Whether Tab-accept is on by default or opt-in. It is the most natural key
  and the most likely to annoy someone whose muscle memory belongs to the
  remote shell.
- Whether the Tier 1 setting should be *discoverable in context* rather than
  only in Settings — an unobtrusive "import this host's shell history?" the
  first time autocomplete comes up empty on a host, which is the moment the
  user can actually judge the question. Risks being one more prompt in an app
  that already has host-key and auth prompts; resolved by asking at most once
  per host and never again after a decline.
- Whether the harvest, once enabled, should still be skipped on hosts where
  Tier 2 is already feeding the store. The integration gives us everything
  from that point on, so the harvest only adds history from *before* it was
  installed — valuable once, then never again.
