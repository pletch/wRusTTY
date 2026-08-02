# Clickable URLs in the Ghostty engine

Implementation plan for detecting URLs in terminal output and opening them in
the system browser.

Not implemented. Written against the engine as it stands after the
SelectionController/MouseReporter/MarkModeController extractions,
`readRows`/`RowText`, and the vendored shim that answers `is_row_wrapped` for
scrollback — all of which between them do most of what an earlier draft of this
plan budgeted for.

Two gestures, not one: **Ctrl+click** because it is what every other terminal
uses and it is how the feature gets discovered, and a **hint mode** because it
is the one that works when a program has grabbed the mouse, and because this
app already has the machinery for a modal keyboard interaction.

## What already exists

Four things that used to be the expensive part of this feature are done:

- **Row text.** `GhosttyEngine.readRows(from, to)` returns `RowText[]` —
  the row's text plus a `colStart` index, so a character offset maps back to
  a column without a string per cell (`lib/ghostty/rowText.ts`).
- **Logical lines.** `SearchController.findMatches` already joins wrapped rows
  into the line they belong to, using `readWrapFlags`, and reports a match as
  one hit carrying the per-row segments it covers. URL detection wants exactly
  that shape, and the join should be *extracted and shared*, not rewritten —
  see Phase 1.
- **Underline.** The renderer honours `CELL_UNDERLINE`, folding the style into
  the atlas key (`WebGLRenderer.ts`, ~line 775). Hover feedback is therefore a
  style bit on the covered cells, not new geometry.
- **A modal keyboard interaction.** `MarkModeController` is a mode that takes
  the keyboard, draws its own state, and gives everything back on Escape, with
  a narrow host interface and its own tests. Hint mode (Phase 6) is the same
  shape of thing and should be built by reading that file first.

## Phase 1 — extract the logical-line join

**Where:** `lib/ghostty/SearchController.ts` → new `lib/ghostty/logicalLines.ts`

`findMatches` walks rows, extends across `wrapped[]`, matches on the joined
text, then maps offsets back to per-row segments. Pull that walk out as
something like:

```ts
export interface LogicalLine { text: string; startRow: number; rowCount: number }
export function logicalLines(rows: RowText[], wrapped: boolean[]): LogicalLine[]
export function segmentsFor(line: LogicalLine, rows: RowText[], start: number, end: number): Segment[]
```

Search keeps its behaviour (its tests are the check); URL detection becomes a
different matcher over the same lines. Doing this first is what stops the
feature from growing a second, subtly different idea of what a line is.

**Done when:** the existing search tests pass unchanged against the extracted
version.

## Phase 2 — URL detection

**Where:** new `lib/urlDetect.ts`, with `urlDetect.test.ts`

```ts
export interface UrlMatch { start: number; end: number; url: string }
export function findUrls(line: string): UrlMatch[]
```

- Schemes: `https` and `http` only, until there's a reason for more. Bare
  `www.` is deliberately excluded — it fires on hostnames in log output.
- Trailing punctuation is the whole difficulty. `(see https://x/y)` and
  `https://x/y.` must not swallow the closer, but
  `https://en.wikipedia.org/wiki/Foo_(bar)` must keep its parens. Strip
  trailing `.,;:!?'"`, and strip a trailing `)` only when the match holds no
  unmatched `(`.
- **Reject a non-ASCII host.** `https://аpple.com` with a Cyrillic `а` is a
  different site than it reads as, and the status bar's own remote text is
  already stripped of the format characters that play the same trick
  (`lib/remoteIdentity.ts`). A URL whose authority component is not ASCII is
  not offered as a link at all; the text still sits there to be read and
  copied, which is the honest outcome for something we cannot render
  unambiguously.
- **The pattern stays linear.** No nested quantifiers, no alternation inside a
  repeat — a line of terminal output is attacker-supplied, and a pattern that
  backtracks catastrophically turns `cat` of a hostile file into a hung frame.
  Test with a pathological line, not just realistic ones.
- Offsets are into the logical line; Phase 1's `segmentsFor` maps them back.

Pure string work with no core and no DOM, so this is the part that's cheap to
test exhaustively. Table-driven, covering: wrapped, parenthesised, adjacent
URLs, a URL ending exactly at the right margin, a Cyrillic-homograph host, a
backtracking-bait line, and a line of ANSI-coloured `ls` output that contains
no URL at all.

## Phase 3 — hit-testing

**Where:** a `LinkController` beside the other three

`SelectionController` and `MarkModeController` are the model to copy: a
controller with a narrow host interface and its own tests. A `LinkController`
wants `readRows`, `readWrapFlags`, `coords`, `viewportY`, `rows`, `bufferGen`
and a way to set the highlight.

```ts
export type LinkSource = 'detected' | 'osc8'
export interface Link { url: string; segments: Segment[]; source: LinkSource }

linkAt(pos: Point): Link | null
linksInViewport(): Link[]   // hint mode's input
```

`source` is carried from the start even though only `'detected'` is ever
produced today. It is what lets OSC 8 arrive later as a second *producer*
feeding the same hit-testing, hover and activation path rather than as a
parallel system — and Phase 5 needs to know which one it is, because the two
have different disclosure rules.

**Scope detection to the viewport**, `viewportY`..`viewportY + rows()`, not to
the whole buffer. Search reads `0..total-1` because a search is *for* the
scrollback; a link is only ever activated where the pointer is. Reading ten
thousand rows to answer "what is under the cursor" is the one way to make this
feature expensive.

Cache the parse per viewport, invalidated on `bufferGen` change or a scroll —
the same signature/generation check `SearchController.search` does before it
reads a row.

## Phase 4 — hover feedback

**Where:** `WebGLRenderer.ts`

Add a highlight range the per-cell loop consults, and OR `GLYPH_UNDERLINE`
into `style` for covered cells — the same bit `CELL_UNDERLINE` sets, so the
rasterizer needs no change. Cost is one extra atlas entry per glyph that gets
underlined, which is bounded by the link's own text.

Set `canvas.style.cursor = 'pointer'` while a link is under the pointer, and
clear it on `mouseleave` **and** on modifier release, or the cursor sticks in a
pane the pointer has left.

Recompute only when the pointer crosses into a different *cell*, not on every
`mousemove` — the events arrive at pointer resolution and the answer only
changes at cell resolution.

## Phase 5 — activation by Ctrl+click

**Where:** `GhosttyEngine.ts` mousedown (~line 1121), `terminalEngine.ts`,
`components/Terminal.tsx`, `src-tauri/capabilities/default.json`

**Ctrl+click, not Shift+click.** Shift already means something specific and
load-bearing in every terminal including this one: *this click is the
terminal's, not the program's* (`if (this.mouse.tracking() && !e.shiftKey)`,
~line 1124). It is overloaded a second time for selection-extend (~line 1168).
A third meaning cannot be resolved against the other two without one of them
feeling broken, and no shipping terminal asks it to be: Windows Terminal, VTE,
WezTerm, VS Code and Ghostty itself all use Ctrl+click (Cmd on macOS), kitty
uses Ctrl+Shift+click, iTerm2 uses Cmd+click. Konsole's plain click is the lone
outlier and it ships a deceptive-link warning dialog because of it.

Ctrl is not free either — `MouseReporter` encodes it as bit 16
(`MouseReporter.ts:115`), so a program with the mouse grabbed can see a
Ctrl+click. That collision is real, and it is the one every terminal in that
list has decided to accept: it is rarer than shift-bypass and it does not
contradict a convention users already have. Hint mode (Phase 6) is the escape
hatch for anyone it bites.

Resolution order in mousedown:

1. **Ctrl held, pointer on a link** — the link wins, and the program does not
   see the click. This is the case the modifier exists for.
2. **Ctrl held, no link under the pointer** — unchanged behaviour: the click
   goes wherever it goes today.
3. **Shift** — entirely untouched. Bypass and selection-extend keep both of
   their current meanings, and neither has to be reasoned about again.
4. **Ctrl+drag** — must still do whatever it does today. Activate on mouse*up*
   with no movement since mousedown, never on mousedown, or a drag that begins
   on a link opens a browser.

Then:

- Add `onLinkActivate(cb: (url: string) => void): IDisposable` to
  `TerminalEngine` rather than calling Tauri from the engine — every other
  host interaction is `Terminal.tsx`'s, and the engine has no platform
  dependency today.
- `Terminal.tsx` calls `openUrl` from `@tauri-apps/plugin-opener` (already a
  dependency; `tauri-plugin-opener` is already in `src-tauri/Cargo.toml`).
- **Add `"opener:allow-open-url"` to `src-tauri/capabilities/default.json`** —
  it currently grants `opener:allow-open-path` only.
- Enforce the rules in **Security** below at this point, not only at detection.

Right-click → **Open Link** in the pane's context menu, for the same reason
VTE has it: it is the discoverable path for anyone who never learns the
modifier, and it costs one menu item over machinery Phase 3 already built.

## Phase 6 — hint mode

**Where:** new `lib/ghostty/HintModeController.ts`, `GhosttyEngine.ts`,
`components/Terminal.tsx`

Every link in the viewport gets a one- or two-character label painted over its
first cells; typing a label opens that link; Escape leaves. kitty's `hints`
kitten and Alacritty's hints are the same idea, and both exist because a click
gesture cannot be made to work while a full-screen program owns the mouse.

This is worth building **even though Phase 5 exists**, and it may be worth
building *first*:

- It is the only path that works under mouse tracking without fighting a
  program for the click.
- It needs no mousedown surgery at all — nothing in the Phase 5 ordering
  problem applies.
- It works without a pointing device.
- `MarkModeController` has already solved the hard parts of being a mode here:
  taking the keyboard only while active (`onMarkModeKey`, registered capturing
  so nothing reaches the wire), a single Escape that gives everything back, and
  `notifyMode` driving a visible indicator so the mode never surprises anyone.
  Read that file before writing this one; the host interface should look like
  its sibling.

Bind it beside the existing mode toggles — `Ctrl+Shift+M` is mark mode, so
`Ctrl+Shift+U` for links keeps the family. Labels come from
`LinkController.linksInViewport()`, so detection is shared with Phase 3 and
this phase adds a mode, a label painter and a key handler, nothing more.

## Phase 7 — xterm parity

`lib/xtermEngine.ts` exists as the benchmark harness's comparison engine.
Whether it needs links at all is a judgement call: if the harness is its only
remaining user, skip it and let `onLinkActivate` be optional on the interface,
the way `toggleMarkMode` and friends already are.

## OSC 8 — a later producer, not an alternative

Not in scope for the first cut, but the shape above is chosen so it can arrive
without a rewrite. The two are complementary and every terminal that has one
has both: OSC 8 is *explicit* (the program declares the URI, so wrapping and
trailing punctuation stop being problems and the link text may differ from the
target), detection is *implicit* and works on the overwhelming majority of
output that never emits OSC 8 — logs, `curl`, a pasted README, anything from a
host with older tooling.

It is currently **more** work than detection, not less. Cells carry a
`hyperlinkId` (`wasmBindings.ts`, cell bytes 12-13) but nothing resolves that
id to a URI — `ghostty-web`'s own `getHyperlinkUri()` returns `null`. The
vendored shim is ours now (`lib/ghostty/vendor`), so the honest fix is to
export an accessor from it, which means a rebuild. Mirroring the core's id
allocation order from the outside instead would be fragile across core updates
and should not be attempted.

When it lands it produces `Link` values with `source: 'osc8'` and everything
downstream already works — except the disclosure rule in Security below, which
exists precisely for it.

## Security

Remote output is attacker-controlled text, and this is a terminal for SSH and
serial connections to equipment. The far end is untrusted by construction —
the same boundary `lib/remoteIdentity.ts` and `lib/osc52.ts` already document.
None of this makes the feature unsafe to build; it makes the following
non-negotiable.

- **Allowlist the scheme at the point of opening, not only at detection.**
  `http` and `https`, checked again immediately before `openUrl`. The opener
  hands the string to the OS, and detection and activation are far enough
  apart in the code that the second check is not redundant. On Windows this
  matters more than usual: a `file://` or UNC-flavoured target can provoke an
  outbound SMB authentication attempt and leak credentials to a host of the
  attacker's choosing. `vbscript:`, `javascript:`, and whatever custom schemes
  other installed software has registered are the same class of problem.
- **Never open without a deliberate gesture.** Not on hover, not on plain
  click. The modifier is a security control as much as a UI one, which is the
  other argument against Konsole's model.
- **Show the true target before opening an OSC 8 link.** Its display text is
  arbitrary and may read `https://your-bank.com` while pointing elsewhere;
  this is *the* OSC 8 security issue and the reason `Link.source` exists. A
  detected link is its own text and needs no such disclosure — what you see is
  what you get. Put the resolved URL in the hover tooltip for `'osc8'`, and
  consider a confirmation for a mismatch.
- **Reject non-ASCII authorities** (Phase 2), and show the resolved host in the
  tooltip so a long path cannot push the real destination out of view.
- **Keep the matcher linear** (Phase 2). A hostile line should cost what a
  friendly one costs.

## Performance

Detection does **not** run on the parse path. `write()` → `parseAndDispatch` is
untouched by this feature; its only coupling to it is `bufferGen++`
(`GhosttyEngine.ts:1421`), a counter increment that is already there for
search. A pane printing at full rate with nobody hovering does exactly what it
does today.

What the regex costs, it costs on demand:

- **On hover**, gated on Ctrl being held and recomputed only when the pointer
  crosses a cell boundary (Phase 4). An ordinary session never holds Ctrl over
  the grid and never pays.
- **On entering hint mode**, once per viewport.

The scale is the reason this is affordable: one viewport is on the order of
10k characters, and a linear scheme scan over that is microseconds. For
calibration, `SearchController` already runs a user-supplied regex over the
*entire scrollback* on every keystroke of an incremental search, tens of
thousands of rows, and that is considered usable — this is a fraction of it,
far less often.

The costs actually worth guarding, in order:

1. **Scope creep to the full buffer.** Detecting over `0..total-1` the way
   search does would be the one change that makes this expensive. Viewport
   only (Phase 3).
2. **`readRows` allocation per `mousemove`.** The string building, not the
   regex, is the per-event cost. Cell-granularity recompute plus the
   `bufferGen`/scroll-keyed cache is what keeps it off the hot path.
3. **Catastrophic backtracking.** A pathological line is the only way a
   detector this small becomes slow, and it is remote input. Covered by
   Phase 2's linearity requirement and its test.

Phase 4's hover underline adds at most one atlas entry per underlined glyph,
bounded by the link's own length, and reuses the `CELL_UNDERLINE` path the
renderer already has.

## Test plan

Phases 1-2 are pure and get ordinary unit tests. Phase 3 follows
`selectionDrag.test.ts`: jsdom, a stubbed renderer, real `MouseEvent`s through
the real handlers — that file exists because the bugs in this area live in
what one handler leaves behind for the next, which is exactly true of the
modifier ordering in Phase 5. Phase 6 follows `MarkModeController`'s tests: the
controller driven by real `KeyboardEvent`s against a stub host. A live test
(`remoteIdentityLive.test.ts` pattern) can cover detection against a real core
with real wrapped output.

By hand, in a running pane:

- a URL wrapped across two and three rows, and one ending exactly at the
  right margin
- a URL scrolled into scrollback, then hovered — the scrollback/active
  boundary in `readRows` is where this breaks first
- hover while the viewport is scrolled up: coordinates must stay absolute
- Ctrl+drag starting on a link (must not open), and Ctrl+click on a link while
  `top` is running (must open, and `top` must not see the click)
- shift-bypass and shift-extend, both unchanged — the regression this design
  is chosen to avoid
- hint mode with forty links on screen, and with none
- `printf 'https://example.com/%s\n' $(seq 200)` with the pointer moving and
  Ctrl held, for detection cost on a redrawing screen
- a line of `https://` followed by a few thousand characters of no delimiter,
  for the backtracking case
