# TODO

Open items with enough context to pick up cold. Design decisions and the
gotchas already found live here so they don't have to be rediscovered — see
PROJECT_PLAN.md for the phased plan this sits alongside.

## Rounded tab corners

Windows 11 apps (Edge, Windows Terminal, File Explorer) round the top corners
of tabs. wRusTTY's are square.

**The modest version** — `rounded-t-lg` on the tab div in `TabBar.tsx`, plus
one required companion change:

- The pane map is `absolute inset-x-0 top-0`, anchored to the exact edge the
  radius eats. At an 8px radius the fill is inset ~8px per side at y=0,
  tapering to ~2.7px by y=2, so a 2px bar would render as a stub with its
  ends chewed off. Change it to `inset-x-2` so it sits on the straight part
  of the top edge. Costs 16px of a 130px minimum tab, which it can spare.
- Content padding needs nothing: `px-3` (12px) already clears an 8px radius.
- The radius is only ever *visible* on the active tab and on hover, since
  inactive tabs have no background at all (`bg-white/10` on active,
  `hover:bg-white/[0.06]` otherwise). Small change, correspondingly small
  risk.

**The full version, as a separate decision.** In Edge and Windows Terminal
the rounding works because the active tab's fill matches the content area
behind it and the strip's bottom border breaks underneath it, so the tab
reads as continuous with the page below. Here the active tab is a translucent
white overlay above an unrelated dark terminal, with an unbroken `border-b`
on the strip — so the modest version gets the shape of the convention without
the thing the shape is *for*. Doing it properly means the active tab's fill
matching the terminal background and interrupting that border, which
interacts with the vibrancy/opacity settings since the terminal background
isn't a fixed colour.

## Settings not yet exposed

Raised while reorganising settings into a dialog.

- **Logging: auto-start per session, and a configurable path.** Logging is
  manual and writes to a fixed location.
- **Custom theme colours.** Presets only, no import of an existing scheme.
- Lower still: selection word separators, scroll sensitivity, rebindable keys.

## Flake: `port_open_reports_a_closed_port_as_closed`

`src-tauri/src/wake.rs:564`. Fails intermittently under `cargo test --workspace`
and passes every time `wake::` is run on its own, which is the tell.

The test binds an ephemeral port, drops the listener, and asserts nothing
answers on that number. Its own comment calls this "as close to 'definitely
closed' as a test can get" — and that is true of a test running alone. It is
not true here: the neighbouring `wake` tests bind ephemeral ports of their own
in parallel, the OS is free to hand the just-freed number straight back to one
of them, and then something *is* listening on it.

So the assumption to fix is the sharing, not the assertion. Either take the
port from a range nothing else in the file can be handed, or stop the `wake`
tests racing each other for ephemeral ports. Resist the urge to widen the
timeout — the failure is a port that is genuinely open, not one that answered
slowly.

## Performance: one open question, and it is not the baseline

Recorded here because the state of this is easy to misread from
`EVALUATION_DECISIONS.md`'s table alone — read its 2026-08-07 postscript, not
just the Decision column.

**The only thing actually undecided is B4**, the `FLUSH_INTERVAL` matrix:
8/16/24 ms × typing/flood, at `src-tauri/src/coalesce.rs:26`. It resists being
settled by reasoning because it is a latency-versus-throughput trade rather
than an optimisation — there is no direction that is just better, so changing
the constant on argument alone swaps a known-good echo latency for an
unmeasured throughput gain. A one-line edit and a rebuild per cell.

**The rest of Track B is closed.** B1a and B2 shipped and need no number (both
are strictly fewer allocations with no behaviour change). B1b and B3 are
rejected, on evidence that arrived sideways: `tools/parse-probes/iter.mjs`, run
to justify the ghostty `main` port, measured the worst full redraw at **0.21 ms
against an 8.3 ms frame**. B3 was deferred pending proof that B1a and B2 left us
short of target; at ~2.5% of frame budget there is no target being missed, so
the honest outcome is rejection rather than another deferral.

**The committed baseline (B0) is optional and gates nothing.** Its remaining
value is regression detection, not tuning. If you do want it, now is the
cheapest moment — the VT core was swapped underneath (v1.3.1 → `main` at a pin,
742,403 → 1,308,136 bytes) with no frame-level number on either side, and that
gap only widens as changes land on top. `docs/bench/README.md` has the
protocol; it needs your machine, mains power and roughly an untouched hour.

Do not let the harness's existence imply the perf track is unfinished. It is
finished bar B4.

## Watch: cursor position after closing a tab

Fixed in 872b9b3 by giving `closeTabNow` the `refit()` every other
visibility-changing path already had. That fix is probabilistic, not proven —
the race is too rare to reproduce on demand, so what it claims is parity with
its siblings, not a bug observed disappearing.

If the cursor lands a few columns off after a tab close *again*, the
transitional-size theory is wrong and the next place to look is the
`ResizeObserver` / WebGL-reload interaction in `Terminal.tsx:786`.

## Wake-on-LAN: the two pieces deliberately left out

Shipped: a per-session MAC (`SessionProfile.wakeOnLan`), a probe-first wake in
`src-tauri/src/wake.rs`, the pre-connect hook it runs from
(`SessionRegistry::spawn_connect_prepared`), the form field, and a **Wake**
item in the session context menu. Two known gaps, both scoped out on purpose
rather than missed.

**Automatic multi-NIC broadcast.** `wake::send` binds `0.0.0.0`, so the
routing table picks the interface and a limited broadcast has no way to
influence that choice. On a machine with Wi-Fi, Ethernet and a Hyper-V switch
all up, the packet leaves by whichever one wins. The current answer is the
per-profile *Broadcast to* field: a directed broadcast (`192.168.1.255`) has a
route, so naming the subnet picks the interface.

Doing it automatically means enumerating interfaces and sending on each, which
needs a dependency — `if-addrs` is the small, obvious one. Worth it only if
the manual field turns out to be a recurring annoyance; the failure it fixes
is invisible (the packet goes somewhere, just not where you meant), which
argues for doing it eventually.

**Waking through a jump host.** `start_connection` currently *skips* waking
when a profile has a jump host, and the form hides the field, because a magic
packet is a broadcast on this machine's segment and the target isn't on it —
sending anyway would waste the whole wait probing a host with no route to it,
failing a connection that would otherwise work.

Doing it properly means the packet originating on the far side: open the jump
connection first, run `wakeonlan`/`ether-wake` there (or send raw UDP through a
forwarded channel), then wait for the target. That reorders the connect path —
today the jump is established as part of `SshConnector::connect`, i.e. *after*
the pre-connect step — so it isn't a small change. It also can't assume the
jump host has either tool installed, which is the part with no clean answer.
