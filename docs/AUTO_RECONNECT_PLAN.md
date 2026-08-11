# Auto-reconnect

Implementation plan for a session that survives its transport going away.

**Phase 1 is built, and Phase 2's port forwards with it.** The rest of Phase 2
and all of Phase 3 are not. The three decisions below were
taken as written and are now load-bearing in the code; what changed on contact
is recorded under "What Phase 1 actually did" at the end.

This document was written against the code as it stood after the
keyboard-interactive auth work, and every file and line reference below was
checked against it rather than remembered. Line numbers have since moved.

The reason to build this as one thing rather than three is that
`PROJECT_PLAN.md`'s gap list names it in three places as though it were three
separate holes: the disconnect overlay that can only offer a button, a transfer
that cannot survive the connection going away, and the untested rekey corner on
a long-lived session. They are one missing capability. Built once, all three
close; built per-symptom, none of them close properly.

---

## The finding this plan turns on

`Slot<S>` in `src-tauri/src/session_registry.rs:61` is already the right shape:

```rust
pub enum Slot<S> {
    Connecting { input: Vec<u8>, size: Option<(u16, u16)> },
    Ready(S),
    Cancelled,
}
```

A reconnect is `Ready` → `Connecting` → re-handshake → `publish` back into **the
same slot, under the same session id**. The id is the key everything else hangs
off, so keeping it stable means the frontend's engine and scrollback, the
logging sink, the SFTP edit watchers and the coalescer's credit window all
survive a reconnect without knowing one happened. The queue-and-replay
behaviour that `Connecting` exists for — keystrokes typed at a pane mid-
handshake — is exactly what should happen to keystrokes typed at a pane
mid-reconnect, for free.

**The existing "Reconnect" button is not a smaller version of this.** It
dispatches `paneReconnected` (`src/state/tabs.ts:93`), which bumps
`leaf.generation`, and the pane is keyed `${leaf.id}-${leaf.generation}`
(`src/App.tsx:1349`) — so the pane remounts, takes a new session id, builds a
new engine, and **the scrollback is gone**. That is defensible for a button a
user pressed deliberately after reading a failure. It is not what should happen
when a laptop's wifi drops for four seconds.

So the button and this feature can coexist. They should: "reconnect from
scratch" remains a useful thing to ask for.

---

## Three decisions, taken here

### 1. Which drops are reconnectable

The code cannot currently express this distinction. In `SshSession`'s output
pump (`crates/wr-ssh/src/session.rs:355`), all three of these collapse to one
status:

```rust
Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => { /* Disconnected */ }
```

`Eof`/`Close` is the channel closing — which is what typing `exit` looks like.
`None` is `channel.wait()` returning nothing, which is the transport itself
having gone. **Auto-reconnecting after a deliberate `exit` would be
maddening**, and the two are indistinguishable downstream today.

The discriminator is already in hand; it just is not carried. So:

- **`None`, and a keepalive timeout, are reconnectable.** The transport died
  without being asked to.
- **`Eof`/`Close` is not.** The far end finished.
- **An authentication failure is never reconnectable.** Each attempt spends one
  of the server's `MaxAuthTries` (OpenSSH defaults to 6), so a retry loop locks
  the account out on the user's behalf.
- **A changed host key stops the loop and surfaces.** A background retry must
  never auto-accept a key it would have prompted about, and should not spam the
  prompt either.

This needs a field on the disconnect event saying which kind it was. Telnet and
serial need the same distinction drawn in their own terms — for serial,
"adapter unplugged" is reconnectable and is in fact the best case this feature
has.

### 2. Credentials are re-resolved, never retained

Today a secret is used during the handshake and dropped; `AuthMethod` is
`ZeroizeOnDrop` precisely so the copy cloned out of the vault at connect time is
not the one left in freed heap. Reconnecting needs a credential again, and the
tempting shortcut — keep the resolved `AuthMethod` alive for the session's
lifetime so retries are cheap — **quietly reverses that decision** for every
long-lived session in the app.

So: re-resolve per attempt, through the same `resolve_auth` path the first
connect used. What that costs is that reconnect inherits the vault's state:

| Auth type | Reconnects unattended? |
|---|---|
| `agent` | Yes — the agent holds the key and signs again. |
| `password` / `public_key` from the vault | Yes, **if the vault is still unlocked**. Locked means surface, don't prompt. |
| `keyboard_interactive` ("Ask each time") | **No.** By construction there is nothing stored. |

The last row is a feature, not a limitation. A session whose whole point is that
its credential is never stored must not sprout a password dialog at 3am because
a link flapped. Those panes get the manual button, which is what it is for.

### 3. The connector is rebuilt, not cloned

`Connector::connect(self)` consumes `self`, so a retry needs something that can
produce a fresh one. `SshConnector` could be made `Clone` cheaply — its fields
are an `Arc` apart from the config — but a factory closure is the better answer
for a reason beyond mechanics: rebuilding re-resolves from the profile.

`tabs.ts:100-105` already argues for exactly this on the existing button, and
the argument holds here verbatim: editing a profile's host or port after
connecting should take effect on the next connection attempt, rather than
replaying the source baked in when the pane first opened.

---

## Phase 1 — reconnect in place *(built)*

The whole of the user-visible value, and all three transports at once, because
`SessionRegistry` is generic over `Connector` and `telnet.rs`/`serial.rs` both
already go through `spawn_connect`.

- **`wr-core`** — add `ConnectionStatus::Reconnecting { attempt, in_seconds }`.
  It belongs beside `Waking`, and for the same reason that variant documents:
  the status line has to say something different for "this will come back on its
  own in 8 seconds" than for "this is hung". Carry the clean-close vs
  transport-died distinction on the disconnect event.
- **`session_registry.rs`** — a reconnect path that takes the slot back to
  `Connecting`, runs the factory, and retries with exponential backoff plus
  jitter, bounded by both attempt count and total elapsed time. Cancellation
  needs no new machinery: `removed()` and `Slot::Cancelled` already mean "the
  pane is gone, stop", and closing a pane mid-reconnect is the same event as
  closing one mid-handshake.
- **`ssh.rs` / `telnet.rs` / `serial.rs`** — supply the factory. SSH's
  re-resolves auth per attempt and refuses to auto-retry a session whose auth
  needs a human (see decision 2).
- **Frontend** — `Terminal.tsx` stops treating a disconnect as terminal and
  renders a reconnecting state instead; `status_label`, `connection_status.rs`
  and `StatusBar` learn the new status. **The pane must not remount**, which is
  the entire point — so this path must not go anywhere near `paneReconnected`.

Serial gets an unearned win here. A saved serial session already resolves its
COM port from the adapter's USB identity at connect time rather than from a
stored port name, so unplug-and-replug reconnection works with no serial-
specific logic at all.

## Phase 2 — what a live session was holding *(port forwards built)*

Phase 1 restores the shell. These are the things that were attached to the old
connection and are silently dead without further work.

- ~~**Port forwards.**~~ **Built**, as planned: the `ForwardSpec` is kept beside
  the handle, each is re-established against the new `client::Handle`, and one
  that cannot be — its local port taken in the meantime — says so instead of
  vanishing. Six things the plan did not foresee:
  - **The registry needed a hook, and it needed *two* phases.** `spawn_connect`
    and `supervise` take an `on_transport` step called with
    `TransportPhase::Lost` and then `Restored`, never on the first connect
    (`NoRestore` is telnet's and serial's answer, since nothing of theirs
    outlives a transport). It is awaited rather than spawned, so a second drop
    during the restore is seen after it rather than raced with it — otherwise a
    forward could be re-established onto a handle that had itself already died,
    and recorded as live.
    - **Reporting only `Restored` was the first version, and it was wrong.**
      Between the drop and the reconnect landing — up to the whole backoff
      budget, so minutes — every forward was still described as healthy, which
      is the precise "listener accepts and carries nothing" state this work
      exists to eliminate, just relocated. `Lost` fires even for a session that
      can *never* reconnect: what died is the connection, and nothing is coming
      to correct the record.
  - **Liveness cannot be read off the handle.** The obvious `handle.is_some()`
    is wrong in both directions. The handle is deliberately *kept* through an
    outage — dropping it leaks the local listener (the port stays bound with
    nothing able to reach it), and stopping it frees that port for anything else
    on the machine to take, turning a restore that would have worked into the
    one failure the user cannot fix from the app. So the handle stays, holding
    the port warm, and a separate `live` flag carries the truth beside it.
  - **The panel cannot refetch on a status change.** `Connected` is emitted from
    inside `SshConnector::connect`, *before* `supervise` publishes the session
    and before the hook runs, so a refetch triggered by it reads the list as it
    stood before the reconnect touched it — and nothing afterwards said to look
    again. The backend emits `ssh-forwards-changed` once each phase has finished
    writing; that is what the panel actually trusts.
  - **`ForwardHandle::stop` had to start awaiting its aborted accept task.**
    `abort` only asks; until the task actually stops it still owns the
    `TcpListener`, and that listener holds the very port the restore is about to
    rebind. Stopping without waiting failed every local and dynamic restore with
    "address in use" — and the bug was invisible before, because nothing had
    ever stopped a forward in order to immediately reopen it.
  - **The frontend was the second owner of the list, and had to stop being.**
    `ForwardPanel` kept its forwards in component state while being unmounted on
    close, so closing the panel lost track of forwards still running in the
    backend, with no way left to stop them. That was a live bug independent of
    reconnects, and it is also what made "the panel still lists them" only
    half-true. `ssh_list_forwards` makes the backend the authority; the panel
    re-reads on open and whenever the pane's connection status changes, which is
    how it learns a reconnect happened.
  - **Retrying a dead forward is a button, not a loop.** The failure that
    actually occurs is a local port taken by something else, which no amount of
    background retrying frees. `ssh_retry_forward` re-opens one against the
    session's current connection, and the panel shows the backend's answer
    rather than assuming the retry worked. A `reestablishing` flag keeps that
    button and a reconnect's restore off the same entry: without it the loser
    records "address already in use" onto a forward the winner has just brought
    up, and returns that error for something that is working.
  - **A forward remembers the port it *got*, not the one it asked for.**
    `bind_port: 0` means "any", and the panel produces exactly that from an
    empty port field (`Number(bindPort) || 0`) — so this is an ordinary input,
    not an exotic one. Replaying the spec verbatim rebinds somewhere else on
    every reconnect, breaking every client pointed at the old number while the
    row still claims the forward is healthy. `ForwardHandle::bound_port` reports
    what was actually bound, and the row displays that rather than `:0`.
- ~~**The SFTP `OnceCell`s must be reset.**~~ **Done in Phase 1.**
  `SshSession::disconnect` reset `sftp` but not `transfer_sftp`. Harmless while
  a disconnected session was always on its way to being dropped, and exactly the
  "hands back the same dead channel forever" failure the moment a session is
  reused across a reconnect — so it could not wait for Phase 2. The reconnect
  path closes the displaced session rather than dropping it, which is what runs
  this.
- **In-flight transfers resume onto the new channel.** The retry-and-resume work
  that already shipped does the hard part; what is missing is the trigger and
  the new channel to resume onto.
- **SFTP edit watchers survive deliberately.** They are keyed by session id and
  the remote file is still there; a reconnect should not discard someone's open
  editor. They pick up the new channel through `get_or_open_sftp` once the cell
  is reset.

## Phase 3 — policy *(not built)*

A per-profile toggle, attempt and backoff limits, alongside the existing
`closeOnDisconnect` setting, which is the nearest neighbour and the obvious
place for it to live.

---

## What must not regress

`session_registry.rs`'s locking is carefully reasoned, and the reasoning is
written into `publish_if_wanted`'s doc comment: narrowing the map lock reopened
a race where a `disconnect` lands between the membership check and the replay,
and queued input reaches a host the user just declined to trust — which, if what
was typed was a password meant for the next prompt, is a real leak rather than a
cosmetic bug. `Slot::Cancelled` is what closes it.

Auto-reconnect adds a **second way a slot can leave `Ready`**, and every one of
those invariants needs re-checking against it. In particular: a pane closed
while a reconnect is in flight must not have queued input replayed into a
session that arrives afterwards, which is the same hazard one layer along.

The existing tests are a good harness for this. `FakeConnector` and
`FakeSession` extend naturally to a factory that fails a set number of times
before succeeding, so backoff, attempt bounds, cancellation mid-retry and the
replay ordering can all be pinned without a transport.

---

## What this plan does not decide

- **Whether a reconnected shell is the same shell.** It is not, and cannot be —
  SSH has no session resumption. The remote process is gone, the working
  directory is back to the login default, and anything unsaved in a full-screen
  program is lost. The scrollback survives because it is ours, not the server's.
  The UI has to be honest about this rather than implying continuity: a marker
  in the scrollback saying where the connection dropped and where it came back
  is probably the minimum.
- ~~**Interaction with `closeOnDisconnect`.**~~ **Decided** — and the premise
  here was the mistake. "A pane set to auto-close on disconnect and also set to
  auto-reconnect is a contradiction" is only true if *disconnect* means both
  kinds at once. It does not: a shell that exited and a transport that vanished
  are different events, and the setting was always documented as covering the
  first. See "What Phase 1 actually did" above.
- **The rekey corner.** `PROJECT_PLAN.md` lists rekey behaviour on a long-lived
  session as untested, and calls it the same session-lifetime question asked
  earlier. That is right, but this plan does not test it — it only makes the
  answer survivable if rekey turns out to drop the transport.

---

## What Phase 1 actually did

The three decisions held. Five things the plan did not foresee:

- **The supervisor hears about the drop through the coalescer**, not through a
  task interposed on the event channel. `forward_coalesced` is the only thing in
  the process that already sees every status, so it took a synchronous
  `on_status` observer. An interposed task would have made every `Data` chunk
  pay a channel hop for an event that fires once per connection, and would have
  doubled the buffering `CONNECTION_EVENT_CHANNEL_BOUND` exists to impose.

- **`Slot::Ready` had to start carrying the pane's size.** Not mentioned above,
  and a visible bug without it: a transport opens its PTY at the size its
  connector was built with, which on a reconnect is the size the pane had when
  it first opened. Any pane resized during its life would have come back wrong.
  `begin_reconnect` seeds the new `Connecting` window from it and the existing
  replay does the rest — so the fix is three lines and no new mechanism.

- **A factory failure retries rather than ending the run.** The plan implies a
  config that will not resolve is a configuration fault no waiting fixes. That
  is wrong for the case this feature serves best: a serial profile resolves its
  COM port per attempt, so "does not resolve" is precisely what an adapter that
  has not been plugged back in yet looks like. A locked vault reads the same
  way, and retrying means unlocking within the window is enough.

- **A first handshake that fails is not retried.** Auto-reconnect restores a
  session that *was* up. Retrying a connect the user just pressed, silently, for
  four minutes behind a "failed" message is not what they asked for.

- ~~**`closeOnDisconnect` wins, for now.**~~ **Settled, and the expedient was
  wrong.** The reasoning above — "a pane the user asked to close when the
  connection goes is not one they want quietly brought back" — quietly assumed
  the two settings were in conflict. They are not, and the setting's own
  description said so all along: *"when a connection ends cleanly (the remote
  shell exits or the server hangs up)"* (`lib/settings.ts`). That is a different
  event from the transport dying under a live session, and `disconnected` and
  `lost` are separate words on the wire precisely so the difference can be acted
  on. The implementation threw the distinction away and applied the setting to
  both.

  The cost was total rather than cosmetic: the setting is **on by default**, and
  closing a pane removes the session id, which is exactly what stops a reconnect
  run. So every user with the default had no auto-reconnect at all, and no way
  to have both. Found by running the manual test with a real transport — the
  first drop closed the pane 800 ms later and there was nothing left to observe.

  Now: a clean end closes the pane, a lost transport is left to reconnect
  (`shouldAutoClosePane` in `lib/connection.ts`, with the rule pinned in
  `connectionStatus.test.ts`). A `lost` transport that cannot come back — a
  credential that must be typed, or a run that spends its budget — leaves the
  pane open on its disconnect overlay rather than closing it, deliberately: that
  pane is the only place the failure is legible and the only place the Reconnect
  button lives.

  The suppression of the disconnect overlay had to move with it. It keyed off
  the *setting* rather than off what the setting would do, so a `lost` pane with
  auto-close on ended up showing neither an overlay nor a close.

Also settled in passing: a run of retries produces one toast, not twelve. Each
attempt reports its own failure from inside the transport, so the frontend
suppresses `failed` toasts while a run is in flight and the run's give-up
message carries the last error.

**Not covered by tests:** a real transport actually dropping. The registry's
reconnect logic is pinned against a scripted fake connector (backoff schedule,
both bounds, cancellation mid-retry, replay ordering, the auth-failure stop),
and `status_label` is pinned against the frontend's parser from both sides. What
no test touches is whether SSH, telnet and serial each classify a real drop
correctly — that is a judgement about `russh` and the OS, and it needs a live
session and an unplugged cable.
