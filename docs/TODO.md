# TODO

Open items with enough context to pick up cold. Design decisions and the
gotchas already found live here so they don't have to be rediscovered — see
PROJECT_PLAN.md for the phased plan this sits alongside.

## ~~Rounded tab corners~~ — shipped, and the chrome went with them

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

**And then the half this section rejected shipped after all**, which is the
correction worth keeping. `9a7506e` gave the active tab the terminal's own
colour — exactly the "full version" ruled out above. The tangle it predicted
with vibrancy and per-pane opacity never appeared, because the tab is painted
the *theme's* background rather than the pane's composited result: the strip
stays an overlay rather than a finished colour, so a translucent window is
still translucent up here. What the objection got right is that it could not
be done by matching a fixed colour; what it got wrong is concluding that meant
it could not be done.

Three things followed that nothing above anticipated:

- **The strip's separation had to stop being a multiply** (`3d2ff1f`).
  `bg-black/20` scales with whatever it is given, so it has nowhere to go on a
  near-black background: Campbell (#0c0c0c) came out two levels darker than the
  terminal, and the strip, the quiet tabs and the active tab collapsed into one
  flat field. The same 20% took 51 levels out of the Light theme. It is now a
  wash chosen *away* from the background — white over dark, black over light,
  8% either way — which is flat addition and so lands 15-20 levels of
  separation on every preset instead of tracking how dark the theme is. It also
  no longer depends on what the OS paints behind the window, which mica and
  tabbed tint from the wallpaper.
- **Once the chrome sits on the terminal's colour, every literal `white/N` in
  it is wrong on a light theme** (`ae42c25`). On Light's #ffffff a
  `text-white/45` label is a label nobody can read. The tone is named once
  instead: a Tailwind `chrome` colour reading `--chrome-rgb`, set from the
  theme's luma, and 380-odd `white/N` became `chrome/N` mechanically so `/40`,
  `/[0.06]`, `hover:` and `group-hover:` all kept working. Two things not to
  undo — text on a saturated accent fill stays *literally* white, since what it
  needs contrast against is the button rather than the window; and the variable
  goes on the document element, not the app root, because dialogs and menus are
  portalled to the body.
- **The active tab's bottom corners flare out into the strip**, the join a
  browser tab makes with its page. `border-radius` cannot draw it — the curve
  is convex from the pane's side and a radius only cuts inwards — so each
  corner is a square of pane colour with a quarter *masked out* of it
  (`fb833db`). The first attempt painted the strip back over the square
  instead, which puts 8px of opaque strip on top of whatever is actually
  there — and what is there, when the pointer is on the tab next door, is that
  tab's hover fill. Keep the two-pixel ramp either side of the radius; a hard
  stop leaves the arc visibly stepped.

**Two gotchas from that work, both cheap to hit again:**

- `background: linear-gradient(…), <color>` is valid CSS that Chrome parses
  into a gradient and a *transparent* background-color — the colour layer is
  silently dropped. Set as two properties it composes as intended. This is what
  left the hover fill measuring from the strip rather than from the terminal.
- The corner fillets are positioned outside their tab, and an out-of-flow
  descendant still counts towards a scroll container's scrollable overflow — so
  at the *end* of the strip it added width the container could not show and
  faded a strip that fits exactly, while at the *start* there is no such thing
  and the first tab's fillet was simply clipped. `px-2` answers both ends.

## Settings not yet exposed

Raised while reorganising settings into a dialog.

- **Logging: auto-start per session, and a configurable path.** Logging is
  manual and writes to a fixed location.
- **Custom theme colours.** Presets only, no import of an existing scheme.
- Lower still: selection word separators, scroll sensitivity, rebindable keys.

## Ligatures: shipped, off by default

Recorded because the shape of the solution is not obvious from the code, and
because the reason it is *off* is a judgement rather than an omission.

The atlas used to rasterize **one cell at a time** — a codepoint keyed by
`codepoint * GLYPH_STYLE_COUNT + style`, or a grapheme cluster keyed by
`style:text`. Both reached the same `fillText`, and Canvas2D applies `calt`
only within a single call, so `=` and `>` went to two different calls and the
substitution had no input to fire on. Nothing was disabling ligatures; they had
no opportunity to happen.

`GlyphAtlas.getRunGlyph` now rasterizes a run of N same-styled cells as one
string into an N-cell slot, and the renderer **slices that raster at cell
boundaries** so each cell samples its own sub-rect. The slicing is the part
worth writing down: it is what keeps the one-quad-per-cell invariant that the
baked underline, the unfocused cursor outline and the DECSCUSR shapes all rest
on. Drawing the run as one wide quad instead is the obvious shortcut and
reopens three shipped decisions.

**Where the cost actually landed.** Not in the shaping — Canvas2D does that.
Two places instead:

- The atlas key stops being a codepoint and becomes run text, so the cache
  needs a bound it never needed, and the alphabet in `ligatureRuns.ts` is what
  keeps a path or a word from ever reaching it. Past the bound `getRunGlyph`
  declines and the cells fall back to drawing one at a time.

  **The bound counts cells, not runs** (`RUN_CACHE_CELL_BUDGET`), which is the
  half worth keeping. Counting runs meant what it reserved moved every time the
  maximum run length did: 512 runs of up to three already reserved 1536 cells
  of a 1024x1024 atlas that holds 1920 at an ordinary 16x34 device cell, so
  taking the maximum to five would have let one cache take the whole atlas.
- Every partial-cell case has to break the run. `computeRuns` breaks on the
  cursor's own cell (which is what other terminals do), on hint labels, on link
  state, and on any change of flags, second attribute byte or resolved colour.
  Selection and search highlighting deliberately do *not* break: those only
  tint a background, and each column carries its own in the instance data.

**Runs reach five cells** (`MAX_RUN_CELLS`), not three. At three, `<==>`,
`<-->`, `!===` and `====` were chopped and `<--->`, `=====` and `<===>` never
had a chance — not because the faces lack them, but for the same reason the
punctuation ligatures were missing until the alphabet grew past the operators
to the characters the substitution tables actually reach (`...`, `??`, `^=`,
and `w`, for `www` alone). Five is where the arrows stop; past it the faces
mostly stop enumerating and start repeating, which no fixed cap can follow.

**Off by default**, and not tied to the font. It costs atlas slots whether or
not the resolved face has the substitutions, and the platform default
(`ui-monospace`, Consolas) has none — so a default install would pay for
nothing. Cascadia Code and Cascadia Mono differ only in ligatures,
which is why offering both used to be a choice that did nothing; the picker no
longer has to curate either, since it is populated from the installed families
(see below).

## Font handling: shipped, with the non-obvious routes written down

The ligature work above pulled the rest of the font stack with it. Recorded
because three of these went through routes that look closed from the API docs,
and someone reading the code will otherwise assume they were unavailable.

- **`setFont` takes a `FontSelection`, not a family string.** A family per
  style; a flag per style saying that family *is already* a face of it (asking
  a face that is italic for italic gets a double slant on a good day and an
  upright on a bad one); and a sorted codepoint range table consulted ahead of
  all of them. Previously bold and italic were CSS keywords asked of one
  family, so a font shipping a real cursive italic rendered as its upright
  slanted by the rasterizer, and which face drew the private use area was
  whatever the webview picked, silently, per glyph.
- **OpenType features and variable axes reach Canvas through `@font-face`.**
  Canvas 2D has no API for either, but `font-feature-settings` and
  `font-variation-settings` are valid descriptors and Canvas resolves its
  shorthand against document fonts — so the family is declared again under a
  generated name with the descriptor baked in, and the atlas is handed that
  name. Measured, not assumed: ten H's of Bahnschrift are 325.8px plain and
  203.9px through a wrapped face at `"wdth" 75`.
  - **`FontFace` does not throw on a descriptor it cannot parse.** The code
    used to claim it did and had a `catch` written for that. It takes the
    string, discards it, and reads back `normal` — no exception, no error,
    which is exactly why a typo'd feature looked identical to a face lacking
    the feature. `CSS.supports` answers the question instead.
- **Fonts are enumerated by DirectWrite in the Rust process**, not by Local
  Font Access, which is Chromium-only and permission-gated. DirectWrite is
  already in the process, resolves against the same collection the webview
  will, and answers the monospace question outright via `IsMonospacedFont`
  rather than leaving it to PANOSE. Settings also reports which face in the
  stack actually *resolved* — a stack is a list of hopes, and which came true
  is the one thing worth knowing when the terminal is not drawing what you
  picked.
- **The range table resolves overlaps by rule, not by typing order.** It was
  documented sorted and non-overlapping and only the first was true, so
  `familyForCodepoint` — a binary search — landed on whichever claimant the
  table happened to split near, and adding an unrelated range further down
  could change the answer. `resolveRangeOverlaps` orders by start then widest
  first, and sets an overlapping entry aside whole rather than clipping it.
- **The atlas grows instead of falling off a cliff.** Running out used to be
  every glyph past the last slot drawing blank, with nothing evicted and one
  console warning — and the cliff is close: at DPR 2 a 14px cell is 16x34, so
  1024x1024 holds 1920 slots, or 960 of the double-width ones CJK uses. It now
  doubles to a 4096 ceiling on demand. Cached rects are mutated in place rather
  than replaced, because the renderer holds them across cells within a frame.
- **Colour glyphs get their own texture.** A colour glyph ignores `fillStyle`
  entirely, so an emoji through the single-channel atlas came out as a solid
  block of the cell's foreground. The companion first shared the coverage
  atlas's packing, which meant sharing its dimensions and therefore its every
  growth — a CJK pane dragged a 64MB companion along to hold three emoji. It is
  packed separately now, starting at 512.
- **Box drawing, blocks, Powerline and sextants are drawn to the cell rect**,
  not taken from the font's em box, which almost never matches
  `round(ceil(fontSize * 1.2) * dpr)` — so border rules fell a fraction short
  of the row beneath and the hairline gaps marched as the pane resized. Same
  substitution `GLYPH_CURSOR_OUTLINE` already made; the cache, slot packing and
  one-quad-per-cell are untouched. It also drops the font dependency for the
  glyphs covering the most screen on machines where fonts cannot be installed.

**Two non-goals, both deliberate:**

- **Relocating atlas rects on growth.** Slots are handed out strictly forward,
  so a doubling buys about three times the capacity rather than four. Recovering
  the rest means moving rects already given out, and the renderer holds them
  across a frame.
- **A run cap that follows the faces.** See `MAX_RUN_CELLS` above — past five
  the faces repeat rather than enumerate, so there is nothing for a cap to
  track.

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

**Two things have changed under this since it was written, and neither is a
preference.** Both are about where a prompt ends, which is the input everything
above assumes it has.

- **OSC 133 `B` now ships in all four snippets** (`a1077ba`). They bracketed
  commands — `A`, `C`, `D`, `E` — and stopped there, because `B` has to live in
  `PS1`, the part most likely to fight starship or powerlevel10k. That was a
  fair trade while the sequences existed for notifications; autocomplete
  changed it, because without `B` the prompt's end is inferred from a quiet
  period, and a quiet period cannot tell a shell prompt from `apt` pausing on
  `[Y/n]`. Every host was therefore on the inferred path and `originExact` was
  never once true. The framework fight is handled rather than assumed away:
  each snippet appends `B` from the hook that runs last and skips the append
  when it is already present, inside the shell's own zero-width wrapper so
  nothing mismeasures the prompt and wraps an edited line in the wrong column.
  - It also made a dormant branch live. `captureTypedLine` skipped passive
    capture whenever the prompt was marked, reasoning that an integrated host
    reports its own command lines — true of these snippets, which emit `E`, and
    false of a plain OSC 133 integration, which has no field for the command
    text. That host would have gone from recording every command to recording
    none. The guard is now "this host has actually reported a command line".
- **An inferred origin needs two characters before anything is offered or
  recorded** (`MIN_INFERRED_INPUT_LEN`, `db7f77c`). Pressing `n` at apt's
  `[Y/n]` was offering every remembered command beginning with `n`, and storing
  `n` itself as a command on Enter. The confusable case is always exactly one
  key — `y`, `n`, a menu's `1`, a pager's `q` — and nothing is given up in
  exchange, since a one-character prefix matches so much of any history that it
  was never a suggestion worth making. A marked prompt keeps the single
  character and needs no rule at all: `C` already says a command is running, so
  nothing is offered for the duration of the install in the first place.

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
