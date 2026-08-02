# Clickable URLs in the Ghostty engine

Implementation plan for detecting URLs in terminal output and opening them in
the system browser on shift-click.

Not implemented. Written against the engine as it stands after the
SelectionController/MouseReporter extraction, `readRows`/`RowText`, and the
vendored shim that answers `is_row_wrapped` for scrollback — all of which
between them do most of what an earlier draft of this plan budgeted for.

## What already exists

Three things that used to be the expensive part of this feature are done:

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
- Offsets are into the logical line; Phase 1's `segmentsFor` maps them back.

Pure string work with no core and no DOM, so this is the part that's cheap to
test exhaustively. Table-driven, covering: wrapped, parenthesised, adjacent
URLs, a URL ending exactly at the right margin, and a line of ANSI-coloured
`ls` output that contains no URL at all.

## Phase 3 — hit-testing

**Where:** `GhosttyEngine.ts`, or a `LinkController` beside the other three

`SelectionController` is the model to copy: a controller with a narrow host
interface (`readRows`, `coords`, `cols`, `setSelection`) and its own tests.
A `LinkController` wants `readRows`, `readWrapFlags`, `coords` and a way to
set the highlight.

```ts
linkAt(pos: Point): { url: string; segments: Segment[] } | null
```

Only run it while Shift is held. `mousemove` is on the render thread's back,
and gating on the modifier means an ordinary session pays nothing. Cache per
logical line against the same buffer signature the search cache uses.

## Phase 4 — hover feedback

**Where:** `WebGLRenderer.ts`

Add a highlight range the per-cell loop consults, and OR `GLYPH_UNDERLINE`
into `style` for covered cells — the same bit `CELL_UNDERLINE` sets, so the
rasterizer needs no change. Cost is one extra atlas entry per glyph that gets
underlined, which is bounded by the link's own text.

Set `canvas.style.cursor = 'pointer'` while a link is under the pointer, and
clear it on `mouseleave` **and** on Shift release, or the cursor sticks in a
pane the pointer has left.

## Phase 5 — activation

**Where:** `GhosttyEngine.ts` mousedown (~line 1121), `terminalEngine.ts`,
`components/Terminal.tsx`, `src-tauri/capabilities/default.json`

The mousedown handler is no longer a blank slate — shift is already
overloaded there, twice:

- `if (this.mouse.tracking() && !e.shiftKey)` (~line 1124) hands the click to
  the program unless shift takes it back.
- `if (e.shiftKey && !this.mouse.tracking() && ...hasAnchor())` (~line 1168)
  extends an existing selection from its anchor.

A shift-click on a link has to be resolved **against both**, and the ordering
is a real decision, not a detail:

1. Program has the mouse, shift held, pointer on a link — open the link. The
   program never sees the click. Defensible: shift already means "this one is
   mine, not yours".
2. No mouse tracking, shift held, a selection exists, pointer on a link —
   ambiguous. Extending a selection and opening a link are both reasonable
   readings. Suggest: link wins only when the pointer is *on* a link and there
   is no in-progress drag; document whichever way it lands, because the loser
   will feel broken to whoever relies on it.
3. Shift-drag: must still select. Detect activation on mouse*up* with no
   movement since mousedown, not on mousedown, or a drag that begins on a link
   opens a browser.

Then:

- Add `onLinkActivate(cb: (url: string) => void): IDisposable` to
  `TerminalEngine` rather than calling Tauri from the engine — every other
  host interaction is `Terminal.tsx`'s, and the engine has no platform
  dependency today.
- `Terminal.tsx` calls `openUrl` from `@tauri-apps/plugin-opener` (already a
  dependency; `tauri-plugin-opener` is already in `src-tauri/Cargo.toml`).
- **Add `"opener:allow-open-url"` to `src-tauri/capabilities/default.json`** —
  it currently grants `opener:allow-open-path` only.
- **Allowlist the scheme at the point of opening, not only at detection.**
  `http`/`https`. Remote output is attacker-controlled text and the opener
  hands it to the OS; `file://` alone is enough to be a problem. This is the
  same trust boundary `lib/remoteIdentity.ts` and `lib/osc52.ts` document.

## Phase 6 — xterm parity

`lib/xtermEngine.ts` exists as the benchmark harness's comparison engine.
Whether it needs links at all is a judgement call: if the harness is its only
remaining user, skip it and let `onLinkActivate` be optional on the interface,
the way `toggleMarkMode` and friends already are.

## Explicitly out of scope

**OSC 8 hyperlinks.** Cells carry a `hyperlinkId` (`wasmBindings.ts`, cell
bytes 12-13) but nothing resolves that id to a URI — `ghostty-web`'s own
`getHyperlinkUri()` returns `null`. Supporting it means tracking
`OSC 8 ; params ; uri` in the scanner and mirroring the core's id allocation
order, which is fragile across core updates. The vendored shim is ours now
(`lib/ghostty/vendor`), so the honest fix is to export an accessor from it —
a separate piece of work with its own rebuild.

## Test plan

Phases 1-2 are pure and get ordinary unit tests. Phase 3 follows
`selectionDrag.test.ts`: jsdom, a stubbed renderer, real `MouseEvent`s through
the real handlers — that file exists because the bugs in this area live in
what one handler leaves behind for the next, which is exactly true of the
shift overloads in Phase 5. A live test (`remoteIdentityLive.test.ts`
pattern) can cover detection against a real core with real wrapped output.

By hand, in a running pane:

- a URL wrapped across two and three rows, and one ending exactly at the
  right margin
- a URL scrolled into scrollback, then hovered — the scrollback/active
  boundary in `readRows` is where this breaks first
- hover while the viewport is scrolled up: coordinates must stay absolute
- shift-drag starting on a link (must select), and shift-click on a link
  while `top` is running (must open, and `top` must not see the click)
- `printf 'https://example.com/%s\n' $(seq 200)` with the pointer moving, for
  detection cost on a redrawing screen
