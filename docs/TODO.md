# TODO

Open items with enough context to pick up cold. Design decisions and the
gotchas already found live here so they don't have to be rediscovered — see
PROJECT_PLAN.md for the phased plan this sits alongside.

## ~~Rounded tab corners~~ — shipped

Kept because the shape it landed in is not the shape either option here
described, and the difference is the interesting part.

Shipped in `9fb5008` and `8b32c84`: `rounded-t-lg`, matching the window's own
radius. The companion change this predicted was needed and was not enough. The
pane map did have to come off the edge the radius eats — it stops a radius
short at each end and caps itself, and sits 2px down, since a line pinned to
the lip of a rounded object looks stuck to it rather than placed on it.

What this file did not anticipate: **the vertical hairline between tabs had to
go with the corners** — a rule meeting a curve reads as a defect — and it was
load-bearing, because both tabs either side of it were transparent. A faint
fill on every tab plus a 2px gap replaced it, and paid twice over: a radius
only shows against something, so the fill is also what makes the rounding
visible at all. The tabs also drop 4px below the window's top edge, for the
reason Chrome and Windows Terminal do it.

**The "full version" question resolved differently than posed.** It framed the
choice as the active tab's fill matching the terminal background so the two
read as continuous — which would have tangled with vibrancy and per-pane
opacity, since that background is not a fixed colour. The actual fix was the
other half of the same idea: drop the strip's **bottom hairline** outright, so
the active fill runs into the terminal rather than being cut off from it. The
strip's own `black/20` still separates it by tone. Erasing that line under only
the active tab was never available — every fill in the strip is translucent, so
overpainting tints the border rather than removing it.

## Settings not yet exposed

Raised while reorganising settings into a dialog.

- **Logging: auto-start per session, and a configurable path.** Logging is
  manual and writes to a fixed location.
- **Custom theme colours.** Presets only, no import of an existing scheme.
- Lower still: selection word separators, scroll sensitivity, rebindable keys.

## Autocomplete: what is left is preference, not unfinished work

All six phases in `docs/AUTOCOMPLETE_PLAN.md` shipped. Recorded here so the
plan's "Open questions" section isn't mistaken for a backlog — each of these
is a default to pick, and picking none of them leaves a working feature.

- **Tab-accept on by default, or opt-in.** The most natural key and the most
  likely to annoy someone whose muscle memory belongs to the remote shell.
- **Asking in context rather than only in Settings.** An unobtrusive "import
  this host's shell history?" the first time autocomplete comes up empty on a
  host is the moment the user can actually judge the question — against being
  one more prompt in an app that already has host-key and auth prompts.
  Bounded by asking at most once per host and never after a decline.
- **Skipping the harvest where Tier 2 already feeds the store.** Shell
  integration gives us everything from the moment it is installed, so the
  harvest only adds history from *before* that — valuable once, then never.
- **Vault-encrypting the store.** Deliberately a plain file today, because
  suggestions that need an unlock before they work feel broken. The command
  surface is shaped so this is a change to one module and nothing above it.

PowerShell and CMD hosts stay a non-goal: the prompt and echo model differs
enough to be its own piece of work. Note this is *autocomplete* only — those
hosts do get shell integration.

## ~~Flake: `port_open_reports_a_closed_port_as_closed`~~ — fixed

Kept for the correction, because the diagnosis recorded here was wrong in a way
that would have sent the next person at the wrong thing.

The conclusion held: the test took an ephemeral port, dropped the listener, and
assumed the number stayed closed, and that assumption is genuinely violable. The
*mechanism* did not. This blamed "the neighbouring `wake` tests binding
ephemeral ports of their own in parallel" — there are six of them, and the
numbers say that cannot be it. Windows hands out ephemeral ports **sequentially**
(twelve consecutive bind/close cycles measured 56816, 56817, ... 56827), so a
just-freed port is the *last* to come back, not the first. Handing it out again
took **15,732 allocations** — a full wrap of the dynamic range. Six tests are
four orders of magnitude short.

What actually does it is that the pool is **machine-wide**: a browser, a dev
server and a relay harness churn ports fast enough to wrap it, and the test's
window between the drop and the probe is scheduler latency, not microseconds,
once the whole suite runs in parallel. That is why it showed up under
`--workspace` on a busy machine and would not reproduce on demand — 28 clean
runs while hunting it.

Fixed by taking the port from a band *below* the ephemeral range
(`CLOSED_PORT_BAND` in `wake.rs`), where no ephemeral allocation can ever be
handed it: none of those 15,732 landed there. The two other tests that used the
same bind-and-drop helper were on the same footing and are fixed with it.

**The first attempt at the fix reproduced the race it was removing**, which is
the more useful half of the story. It picked the band slot from the process id,
which separates two test binaries and makes every caller *inside* one agree — so
all three tests chose the same port, and one test's bind-probe was still
listening when another probed that number and concluded the host was awake. A
stress loop caught it on the 28th run. The port has to be free *and* nobody
else's; an atomic per-call counter is what supplies the second half.

**The general lesson, worth keeping:** a test that frees a resource back to a
shared pool and then asserts the pool did not reissue it is asserting something
about the whole machine, not about itself. There is no timeout to widen — the
failure is a port that is genuinely open.

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
