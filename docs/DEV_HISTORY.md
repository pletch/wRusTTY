# Development history

Why the code looks the way it does: bugs that were found and fixed, approaches
that were tried and replaced, and the measurements behind design decisions.

This material used to live in source comments. It moved here so comments can
describe what the code does now, while this file records how it got there.
Entries are grouped by area, roughly in the order they were written down; file
and symbol names refer to the code at the time of writing, and some have since
moved or been renamed. For decisions that are still in force, the comment at
the relevant code is the authority.

## Terminal engine (src/lib/ghostty)

### Ghostty engine

- **Scrollback is a byte budget.** The core's `scrollbackLimit` reaches
  Ghostty's `PageList` as `max_size`, in bytes. A row count was tried first:
  measured against the v1.3.1 build, 1000 through 100000 all retained ~1100
  rows at 80 columns (~250 at 200), with the heap pinned at its initial 6.6 MB,
  because every value fell below the ~530 KB minimum page. `vendor/README.md`
  once asserted the opposite and dismissed ghostty-web's "it's bytes" docs
  (their PR #151); they were right. A row-count setting was offered and broken
  twice before the setting became the budget itself.
- **Bytes per cell moved with the port.** v1.3.1 delivered 12.65 bytes per
  cell; ghostty `main` delivers 8.5-9.7 from 80 to 400 columns for budgets from
  6 MB up (10.5-12.6 below ~3 MB, where whole-page eviction dominates, hence
  the wider band on the smallest tier in `scrollbackLimit.test.ts`), so the same
  budget bought ~37% more depth after the port.
- **Memory tiers were re-measured for the port to `main`.** Its binary is
  1.3 MB against 742 kB with more static data, so every budget landed one heap
  doubling higher. Flooded to saturation at 80/200/400 columns and three flood
  shapes (steps were width- and shape-independent). The tiers take the top of
  each step because, e.g., 6.5 MB and 12 MB cost the same 17 MB heap but differ
  ~2x in depth. The renderer's scratch buffers share the same linear memory and
  are not in the measurement.
- **Scrollback estimate accuracy.** Against the vendored binary across 80-400
  columns the row estimate runs -27% to +8%; all of the -27% is the 8 MB tier.
  From 16 MB up it is within -5% to +8%.
- **Pre-ready buffer was unbounded.** It hid a never-loading core behind a blank
  pane and a misleading throughput figure; it is now capped at 1 MB.
- **Last column clipped by the scrollbar.** The scrollbar overlays the canvas,
  so a grid fitted to the full width ran underneath it; whenever
  `width % cellWidth` was narrower than the scrollbar, the last column's glyph
  was clipped, only at some font sizes and widths. `fitGrid` now reserves a
  gutter, as xterm's FitAddon does.
- **Out-of-memory was silent.** An OOM core kept returning null pointers that
  no call site handled, and the pane just stopped responding. `fatalError` now
  covers died-later as well as never-started.
- **Copy of rows still on the active screen came back shifted or blank.**
  `readRows` mapped absolute rows through the live scrollback count while
  reading the render snapshot's grid, which was taken before later output
  scrolled in. `snapshotScrollback` pins the count to the snapshot.
- **Failed scrollback reads were discarded.** `get_scrollback_line` leaves the
  buffer untouched on failure, so a miss became spaces on the first read and a
  duplicate of the previous row afterwards, and copy reported either as buffer
  contents. Every invented blank is now recorded in `rowReadFailures` and
  reported by `dumpState`, including which path produced it, since a dump that
  reported only some of them would point the reader at the wrong cause.

- **Session-to-session parse speed.** The same WASM parsed ~2.6x faster in one
  page session than another, stable within each, while the pure-JS pass over
  the same bytes barely moved. Two candidates remained: engines accumulating
  across hot reloads, or V8's WASM tier being fixed early. `diagnostics()` is
  reported with every throughput figure to tell them apart.
- **Per-pane compile.** Fetching and compiling the binary in each engine put
  the whole binary's cost on every pane opened; it is now compiled once.
- **Cursor stopped blinking.** An earlier version skipped writing the cursor
  preference when it matched what looked like the core's default, assuming a
  fresh terminal is a blinking block. The core leaves DEC mode 12 off (steady),
  and once the render loop took blink state from the core the cursor stopped
  blinking.
- **First-load grid didn't fill the pane.** The ResizeObserver fired before WASM
  finished compiling, and the panel width (from react-resizable-panels) and
  the cell metrics (measureText reports the fallback face until the font loads)
  both settle after the first fit without resizing the container again, so the
  grid stayed stale until a manual window resize. Fixed with a fit on renderer
  setup, another on the next frame, and a renderer rebuild on `fonts.ready`.
- **StrictMode double-mount.** A pane disposed while its WASM fetch was in
  flight still built a renderer, started a render loop nothing would cancel,
  and re-registered the debug hook against an off-screen terminal.
- **Wedge after a native prompt.** A mouse release outside the window never
  arrives, so a stuck "still held" kept reporting drags and a stuck "still
  selecting" swallowed clicks and typing. Blur now clears both.
- **Unanswered queries.** Nothing drained the core's responses at first, so
  every CPR/DA query a shell or TUI made at startup went unanswered and the
  program waited out its timeout.
- **`readRows` allocated per cell.** It used to return `string[][]`; a
  full-scrollback search at 10,000 x 200 allocated ~2M short strings plus 10k
  arrays, and every caller joined them straight back together, causing a GC
  pause on the first search keystroke. It now returns joined text plus column
  offsets. A null buffer pointer used to return an empty result, handing copy
  and search a page of blanks.

- **Render loop died silently on a throw.** Once refused allocations started
  throwing, the frame body ran inline with the `requestAnimationFrame`
  reschedule as its last statement, so one throw stopped the pane painting for
  good. The frame is now split out and the loop owns error handling.
- **Initial sizing race.** The ResizeObserver in Terminal.tsx demonstrably
  missed the first layout settle, leaving the grid cropped until a manual
  resize; the render loop now samples the container every 6th frame.
- **Benchmark ran at the wrong size.** Pinning the grid larger than the
  container relaid out the page, the sampling poll measured the consequence
  and undid the pin. A benchmark asking for 200x60 silently ran at 5x18, and a
  "geometry does not matter" conclusion was drawn from runs below 2,000 cells
  while a real pane is ~10,000. Fitting is now skipped while `autoFit` is off.
- **Steady cursors blinked.** Only DECSCUSR's shape was honored, so 2/4/6
  blinked like 1/3/5.
- **Native image-drag of the canvas.** A click that moved a pixel started a
  drag of the canvas as an image (no-drop cursor, gray drag image, focus
  stolen; WebView2 won't cancel it on Esc).
- **Clicking a focused pane wedged it.** A mousedown on the canvas let the
  browser move focus off the hidden textarea: no keystrokes, no blink, until a
  tab switch. Right-click-to-paste also lost typing this way.

- **Shift-drag under mouse reporting couldn't start a new selection.** Shift
  meant both "give this drag to the terminal" and "extend the selection", so
  once any selection existed every shift-drag was anchored to its start.
  Extend-by-shift-click is now disabled while a program has the mouse.
- **Backspace translation broke mouse reports.** `^?`/`^H` translation used to
  be applied to the whole outgoing channel, which also carries mouse reports;
  the legacy format encodes column 95 as 0x7f, so a click there was reported
  as column 8. It now applies to keystrokes only.
- **Closed panes leaked their scrollback.** The terminal wasn't freed on
  dispose, leaking the core's pages for the whole budget on every closed pane.
- **Pre-ready buffer reported impossible throughput.** A core that never
  resolved left every write buffered: the pane stayed blank, each write
  returned promptly having parsed nothing, and a benchmark fed 300 MB into the
  buffer and reported the fastest parse ever recorded, since the instrument
  counted bytes handed to `write` and no phase timer was entered. Nothing was
  logged and it survived for weeks.
- **OSC handlers saw stale state.** The scanner used to scan a whole chunk and
  dispatch before parsing any of it, so handlers saw the terminal as it was
  before the chunk. Parsing is now split at each event. The byte-level scanner
  also dropped the full-chunk decode the old string scanner did on every
  write.
- **String writes reordered output.** Routing string writes through a dynamic
  `import()` put them a microtask behind later byte writes, so a status line
  could land inside a later chunk and pick up its SGR state.
- **Paste with an embedded terminator.** Brackets used to be concatenated by
  hand, so an embedded `ESC[201~` ended the bracket early and the rest was
  delivered as typing. `encodePaste` uses Ghostty's encoder.
- **Canvas never filled the container.** `fit` measured cells independently of
  the renderer, which caches metrics from (possibly) the fallback face; once
  the two disagreed no re-fit could make the canvas fill the container.
- **Scanner cost.** Watching for RIS (`ESC c`) makes the scanner run `indexOf`
  on every 'c' (it hunts ']' for OSC, which escape-dense output rarely
  contains), so the reset handler is only registered while needed. Handler
  dispatch is timed separately as the first suspect for the gap between
  harness and production throughput.

- **Font change reset opacity and colors.** Opacity once had its own setter, so
  a font change (which builds a fresh renderer) silently reset the pane to
  fully opaque. Losing the theme on rebuild recolored only default-colored
  text while palette-colored text kept its colors, which looked like the
  terminal's colors shifting on their own.
- **Bundled fonts measured against the fallback.** A bundled family arrives via
  fetch, so the first measurement mixed one face's advance with another's
  glyphs; spacing was visibly wrong until something rebuilt the renderer.
- **Cursor reset default.** The host used to compare reset and DECSCUSR ticks
  to restore the preferred cursor after RIS; the `main` ABI takes the
  preference at construction and restores it itself.
- **Search across wraps.** Search originally matched per visual row and missed
  hits straddling a wrap, because the core only answered `is_row_wrapped` for
  the active screen. Our shim now exports the scrollback form, so rows are
  joined into logical lines before matching.
- **Copy missed its tail.** Copy isn't tied to a drawn frame, so once output
  landed after the last frame the bottom rows of a selection fell past the
  snapshot's screen and read back blank.
- **Pane dump (Ctrl+Shift+D).** Text pasted out of a pane came back with runs
  missing, always on a row boundary. A hole is one of three things: wrong
  cells, a wrong wrap flag welding unrelated rows, or
  `SelectionController.text` mis-slicing correct inputs. The clipboard only
  holds the answer, so `dumpState` writes out the working. It dumps the
  selection plus 20 rows of margin rather than the whole buffer, which would
  be megabytes and seconds of frozen window.

- **Fragment shader precision.** It used to declare `mediump`; the corrected
  blend divides by a luminance difference, where mediump goes visibly wrong.
  Every target (WebView2 on desktop GPUs) treats both the same, so `highp`
  costs nothing.
- **Cell metrics measured twice.** When the renderer and the engine's fit
  measured separately, cols came from one width and the canvas from another,
  and nothing could reconcile them; `measureCell` is now the one place.
- **Fractional DPI drift.** At 125% or 150% a logical cell is a fractional
  number of device pixels; the canvas height truncated and each row boundary
  drifted further off a real pixel, so glyphs sat a pixel or two off the cursor
  cell further down the screen. Cells are now whole device pixels, which also
  lets the atlas rasterize at native resolution instead of NEAREST-upscaling.
- **History flicker overlay.** The obvious implementation, a DOM band in the
  background color over the canvas, was wrong on a translucent pane: stacking a
  second translucent background made a dark patch rather than a hole. Hidden
  glyphs also showed as opaque silhouettes until their alpha followed the
  background.
- **Per-frame viewport allocation.** The viewport scratch buffer was allocated,
  zero-filled and freed every frame (192 KB at 200x60). Now it's cached; the
  vendored PR #142 zero-initializes fresh WASM pages but not a reused buffer, so
  the explicit fill stays.
- **Scratch buffer growth.** Freeing the old buffer before allocating the new
  one meant a single refused allocation discarded the working buffer and pinned
  its size at 0, so the pane could never repaint again.
- **Bar cursor erased the character.** Bar and underline cursors used to replace
  the cell's glyph, leaving only the bar; they now draw in a second pass.

- **Glyph atlas.** Wide characters squeezed into one-cell slots came out narrow
  and overlapped until `GLYPH_WIDE`. Clusters used to draw only their first
  codepoint, leaving accented letters bare and joined emoji as their first
  component. Ligatures never fired because cells were drawn one `fillText` at a
  time.
- **Run cache budget.** It used to be 512 runs (up to three cells each), already
  reserving 1536 cells of a 1024x1024 atlas that holds 1920 at a 16x34 cell;
  raising the run length to five would have let this cache overflow the atlas,
  so the budget became 1536 cells.
- **Atlas growth.** Running out was a cliff: every glyph after the last slot drew
  blank, nothing evicted, and the pane stayed that way until its font changed.
  At DPR 2 a 14px cell is 16x34, 1920 slots (960 double-width), and a thousand
  distinct Han characters is an ordinary document. The atlas now doubles.
- **Atlas mirror.** The CPU copy used to be the canvas itself (RGBA), 64MB once
  a CJK pane grew the atlas to 4096; it is now one byte per texel.
- **Color glyphs.** Making the coverage atlas RGBA for emoji would cost four
  bytes a texel for every pane; sharing coverage's packing would drag a 64MB
  color atlas along to hold three emoji. Color glyphs got their own atlas.
- **Glyph overrun.** Fallback faces wider than the measured cell were clipped,
  losing their right-hand side for the session, until they were condensed.

- **Stale row colors.** The ghostty-web ABI replaced an earlier hand-built binary
  with a bespoke 23-export wrapper. That build predated upstream's "clear
  scrolled row cells" fix, so a row scrolled into view kept a previously erased
  row's cell memory: uncolored `ls -l` output came out in dmesg's palette.
- **Mouse reports as strings.** `onData` once carried strings; a legacy mouse
  report past column 95 isn't valid UTF-8, so `TextDecoder` produced U+FFFD,
  which `TextEncoder` turned into three bytes, destroying the coordinate and
  desynchronizing the far end's parser.
- **Null terminal writes.** Writing to `termPtr` 0 used to succeed silently
  (the core null-checks and returns); that is how the flood-stress benchmark
  rows came to claim 13,000 MB/s. It now throws. Parse cost was measured
  invariant to content shape, grid width and scrollback depth, which motivated
  timing the buffer handoff separately before blaming the core.
- **Allocation failures.** Every call site used to return quietly on a null
  pointer from `ghostty_wasm_alloc_u8_array`, so an out-of-memory pane looked
  hung; `GhosttyOutOfMemoryError` replaced that.
- **Per-cell objects.** `parseCell` allocated per cell, ~720k objects a second at
  200x60 and 60 fps, which V8 may or may not scalar-replace; `parseCellInto`
  reuses one.
- **Mouse mode constants.** 1002, 1003 and 1006 were removed once
  `MouseEncoder` read tracking mode and format from the terminal.

- **OSC scanner: canceled sequences.** Before CAN/SUB were honored, a canceled
  OSC stayed open until the next BEL and was dispatched with the following
  output as its payload.
- **OSC scanner: pending cap.** At the old 4 KB cap, any OSC 52 copy over
  about 3 KB of text that straddled a chunk boundary (nearly all of them) was
  silently dropped. The cap is now 1 MB, which keeps the cost of prepending a
  never-terminated sequence to each delivery in the tens of milliseconds.
- **OSC scanner: hunting ']' instead of ESC.** Escape-dense SSH traffic put an
  ESC every few bytes, costing an `indexOf` call per escape; a live pane
  measured 1.675 ms/MB against plain text's 0.431. Hunting ']' makes that a
  single memchr returning -1. An earlier version also called `indexOf` for
  both bytes at every hit, rescanning to the end for whichever was absent and
  going quadratic on dense output; caching positions fixed that.
- **OSC scanner: RIS cost.** Hunting `ESC c` on color-wrapped prose took the
  scan from 0.43 to 1.92 ms/MB (4.4x), so it's only enabled while a reset
  handler is registered.
- **OSC scanner: phantom bells.** Resuming the outer scan inside an
  unrecognized OSC used to ring the bell for every unrecognized OSC form,
  since its BEL terminator was read as a bell.
- **Why the scanner wasn't replaced by an export.** Ghostty v1.3.1's OSC parser
  has no ident for 633; dropping the scanner would half-break shell integration
  for VS Code-configured shells. Scanning for 633 alone costs the same as
  scanning for everything (see the OSC-scan findings in `bench/runner.ts`).
- **Selection: drag past the top ran away.** `stepDragScroll` once negated the
  signed scroll amount, so dragging above the pane scrolled forward instead of
  into the scrollback.
- **Selection: shift-click extend.** `extendFromAnchor` once left `start`
  null (as a double-click does), so an extend was only a click: the selection
  didn't follow the pointer and drag-autoscroll never armed. It also didn't set
  `rectangular`, so a shift-alt extend dropped back to linewise on the first
  move.
- **Selection: one-cell gray block.** Rendering start == end as a selection
  left a gray cell after a click, most visibly on the click that reactivates
  the window.
- **Selection: copied text.** Keeping trailing blanks on a triple-click pasted
  a command followed by a screenful of spaces. Inserting `\n` at each soft wrap
  turned a copied long command into several broken ones when pasted into a
  narrower pane.

- **Hand-rolled key encoding replaced.** `GhosttyInputHandler` once carried
  its own ~90-line table (modifier mask, a switch over named keys, SS3 for
  application cursor mode). Ctrl+Alt+letter and Ctrl+Shift+anything fell
  between its two branches and produced nothing; there was no Ctrl+digit or
  Ctrl+Space; and Shift+Enter, Ctrl+Enter and Ctrl+Tab were indistinguishable
  from the bare key, which is what TUIs adopt the Kitty protocol to tell apart.
  `KeyEncoder` now wraps Ghostty's encoder.
- **ViewportReader cost.** Before the `6b22215c` pin, the iterator path couldn't
  amortize what `get_viewport` did in one call: measured with
  `tools/parse-probes/iter.mjs` at 1.4x-2.5x of a 0.21 ms worst case (against
  an 8.3 ms frame), with skipping clean rows at 0.05x-0.14x.
  `RS_ROW_DATA_CELLS_RAW` brought the codepoint-only case to 0.1x of the
  batched call; the full reader saves one call per cell rather than 10x.
- **Grapheme length off by one.** Main's `GRAPHEMES_LEN` includes the base
  codepoint while the packed field doesn't; the mismatch was invisible in
  behavior and caught only by the byte-parity test.

- **Composed text dropped.** Input once came straight off the canvas's
  keydown, enough for control keys but not text: IME input (`keyCode: 229`
  placeholders, then composition events) and dead keys (`key: "Dead"`, then
  the accented character) were dropped. The offscreen textarea fixed both.
  Canceling keydowns that had no sequence was what lost composed characters.
- **App bindings and the encoder.** In-app handlers were written against a
  keyboard that mapped Ctrl+Shift+C to nothing, so consuming the key cost
  nothing on the wire. The encoder maps it to `^C`, which is why `isOurs`
  checks `defaultPrevented`.
- **Stranded compositions.** Switching to another Windows app fires no `blur`,
  so a composition could stay open; `composing` stuck true dropped every
  printable key while Enter and arrows still worked (the tell for this wedge).
  Separately, WebView2 could leave the textarea focused with a dead input
  context after reactivation, fixed by blurring and refocusing a frame later.

- **ScrollbackReader resolve cost.** One `grid_ref` resolve per cell made a
  full search pass 9x slower than before the port; resolving once per row and
  stepping `x` measured 0.8x-0.9x of the row-at-a-time read it replaced,
  holding at 0.86x at 100k rows (`tools/parse-probes/search.mjs`).
- **Grid point size.** `resolve` once zeroed 16 bytes of the grid point,
  until the layout was checked against `ghostty_type_json`: it's 24, so the
  last eight bytes of the union stayed stale and the allocation was eight
  bytes short of what the core reads. `abi.manifest.test.ts` pins it now.
- **Union payload.** Unpacking the cell payload unconditionally turned an
  ED/EL blank into a control character: a cleared row with bg 0x445566 came
  back with codepoint 1.
- **Wrap flag.** `ROW_DATA_WRAP` and `ROW_DATA_WRAP_CONTINUATION` mark the two
  ends of a wrap and both answer plausibly; the vendored build reports row 1
  of a two-row line where `ROW_DATA_WRAP` reports row 0, a mistake that
  survived until compared.

- **Hand-rolled mouse encoding replaced.** `MouseReporter` once built the wire
  format itself (button number plus modifier bits, an SGR branch, X10 via
  `String.fromCharCode(32 + n)`). It handled two of five formats and three of
  five tracking modes: X10 (mode 9) is press-only but got drags and releases,
  urxvt (1015) and UTF-8 (1005) were missing, and SGR-pixels (1016) was
  impossible because the reporter only knew the cell. `MouseEncoder` wraps
  Ghostty's encoder instead.
- **Keys without a `code`.** The key table the encoder replaced keyed off
  `key`, so injected keys with `code: ""` worked; without the
  `codeFromKeyName` fallback, the switch would have silently killed every
  control key on those sources. Found via `SendInput` without
  `KEYEVENTF_SCANCODE`.

- **Controllers extracted from GhosttyEngine.** The engine had grown to about
  2,000 lines and 55 fields spanning WASM lifecycle, WebGL context loss, mouse
  tracking, selection, OSC dispatch, clipboard, search, cursor blink and
  viewport math. Groups of fields that only talked to each other (search's
  four, selection's seven) became `SearchController`, `SelectionController`,
  and later `MarkModeController` and `LinkController`.
- **Search across wraps.** Searching row by row missed matches straddling a
  wrap. That was once unavoidable because the core answered `is_row_wrapped`
  only for the active screen; once the shim exported the scrollback form,
  rows were joined into logical lines before matching.
- **Visual check page.** A bar or underline cursor that erased the cell it sat
  on looked correct on a blank, which is how it shipped; the visual check
  parks the cursor on a character.

- **xterm.js demoted to oracle.** xterm.js was once a user-selectable fallback
  renderer: a second input path and bug surface behind a setting nobody could
  evaluate, since the gaps it existed to escape were WASM-build limits users
  couldn't recognize. It became a test oracle and benchmark reference only.
  The cost was the WebGL-context-loss fallback; context loss is recoverable
  in-engine, and a second renderer doesn't fix a core that won't load. Full
  removal was rejected because the parity test would become a self-snapshot;
  worth revisiting once Ghostty has been the sole engine long enough.
- **`upstream` gaps closed.** The flag once meant "we can't close this",
  written when the binary came from `ghostty-web@0.4.0`, whose exports
  couldn't be extended. After building from the Ghostty v1.3.1 tag with our
  own `patches/`, the four flagged gaps went: Primary DA was never a gap (it
  already replied, on the old binary too, so the ledger line was stale), and
  the other three were closed by two new exports and a spare byte in the cell
  struct.
- **Parity ledger colors.** "Glyphs, colors, layout" once covered glyphs only;
  the colors half was unenforced prose until per-cell color assertions landed.
- **DECSCUSR blink.** Honoring only the cursor shape left ESC[1 q and ESC[2 q
  identical, since the pane blinked on its own timer regardless.

- **readRows representation.** Rows were once one string per cell; they're
  now text plus a column index. `readRows.test.ts` was added because the
  cell walk had no coverage at all.
- **Selection shifted by unpainted output.** Pairing the per-frame render
  snapshot with a live scrollback depth shifted every active-screen row by
  however many rows had scrolled since the frame: a selection came back
  correct through its scrollback rows, then jumped backward. It happened for
  real when an SSH host wrote while a drag finished.

- **Hand-rolled paste replaced.** `GhosttyEngine.paste` was once four lines:
  read DEC 2004 and, if set, wrap the text in `ESC [ 200 ~` / `ESC [ 201 ~`.
  It pasted an embedded terminator verbatim (the standard bracketed-paste
  breakout, easily copied from a web page), and sent raw `\n` when bracketing
  was off. Both were fixed by moving to the engine's paste encoder.
- **Redraw put the origin at the end of the line.** When readline redrew the
  prompt and line in one write (SIGWINCH, `^L`), measuring the `B` origin at
  the end of the write placed it after the recalled command, so reads returned
  a fragment or nothing: the history flicker blinked the tail of a wrapped
  command and stopped entirely once the window was widened.

- **Scrollback limit units.** Both directions shipped wrong. A row-shaped
  value sat under the core's ~530 KB minimum page, so every setting collapsed
  to a two-page floor: 1000 and 100000 both kept ~1100 rows at 80 columns and
  the picker did nothing. And since zero means unlimited, any path producing 0
  removed the cap.
- **Refused row reads.** `readRows` once discarded the 0 that
  `get_scrollback_line` returns for an unresolvable row, so the miss reached
  copy as content: spaces on a fresh buffer, the previous row's text on a
  reused one. A reported copy fault (a wrapped line cut at exactly the pane
  width, and long runs of spaces) traced to this.
- **Pre-ready buffering.** A core that never loaded made every write buffer
  silently, producing a published parse figure ~3x too fast. Engines
  surviving a hot reload, each with their own linear memory, were one of two
  live explanations for the same WASM parsing 2.6x faster in one page session
  than another.

- **ESC k patch check.** The `#176` assertion was the other way round until
  the patch existed: against a stock `main` build, `SCREENTITLE` reached the
  grid, which is how the fix was confirmed to still be needed.
- **Cursor across reset.** The old shim exposed a tick pair
  (`last_reset_seq` / `last_cursor_style_seq`) that the host compared, then
  rewrote DECSCUSR if the reset was newer (`restoreCursorAfterReset`). It had
  to tell a TUI that reset and set its own cursor in one write from one that
  only reset; getting it wrong overwrote the application's choice. On ghostty
  `main` the core holds the configured cursor across the reset.
- **DECSTR.** Ignored outright until upstream f473f3109; a test once asserted
  that an application's bar cursor survived it, an assumption nothing had
  checked.
- **Selection drag bugs.** `mousemove` was bound to the canvas, so a pointer
  outside it reported nowhere and selection stopped dead at the edge. Shift
  was read as "extend", so a second shift-drag stayed anchored to the first
  selection's start and nothing could begin a selection elsewhere.
- **New exports.** `is_scrollback_row_wrapped` and `get_cursor_style` closed
  parity gaps once marked "upstream, cannot be fixed here".
- **Shortcut defaults.** Defaults are the bindings the app shipped before
  shortcuts were configurable.

## The port to ghostty main, and platform plumbing

### Port to ghostty `main` (src/lib/ghostty/main)

See also docs/PORT_GHOSTTY_MAIN.md.

- **Export count.** Upstream keeps consolidating: 187 -> 202, then 201
  (`mode_get`/`mode_set` folded into the generic accessors), then 180 at the
  `b1d9492c` pin, which replaced the type-specific allocators (`_u8_array`,
  `_usize` and others) with one `ghostty_wasm_alloc` (upstream `a8e9b413f`) and
  `render_state_colors_get` with `RS_DATA_COLORS`. The new allocator is aligned
  for any C struct, which `alloc_u8_array` never promised and several call sites
  quietly relied on.
- **`GHOSTTY_NO_VALUE` was -3.** It was transcribed as -3 until the key encoder
  needed `OUT_OF_SPACE`, which is -3. It was never compared against, so nothing
  broke, but a `!== GHOSTTY_NO_VALUE` test would have read a too-small buffer
  as an empty answer.
- **`GhosttyPoint` layout.** `point.h` reads as `x@+4, y@+8` on a 4-aligned
  target; the union has an 8-aligned member, so `value` begins at +8 (found by
  probing known grid content; the tell was `y=1` returning column 1 of row 0).
  `POINT_SIZE` was 16 until the manifest was consulted: probing finds field
  offsets but not where a struct ends. Nothing visibly broke (the core read the
  union's unused tail and `grid_ref` succeeded either way), but the zeroing loop
  in `ScrollbackReader.resolve` cleared only 16 of 24 bytes.
- **Grid ref cost.** Resolving a point is O(scrollback depth), 14 ns at row 0
  and 188 ns at row 39,540, so resolving once per row instead of per cell is a
  9x difference.
- **Packed cells.** Unpacking the `uint64_t` cell in JS is 1.7x faster on a
  scrollback walk than per-field queries. Running `codepointOf` on a
  background-color cell (`0x445566`) yields `1`, so a cleared row read as
  control characters until `cellHasText` was checked.
- **`GhosttyStyle` layout** was found by probing, not by reading `style.h`,
  which looks 4-aligned.
- **Structured render reads.** Reconstructing the cursor took eight separate
  `render_state_get` calls, visible per frame in wasm profiles, until upstream
  `16c833c5f`.
- **Cursor outside the viewport** was drawn at (0,0) when `viewport_x`/`_y`
  were read without checking `viewport_has_value`.
- **Row cells view** (`6b22215c` pin): measured with
  `tools/parse-probes/iter.mjs`, codepoints only, it runs at 0.1x the v1.3.1
  batched `get_viewport` (1.9 µs vs 14.1 µs at 80x24, 10.3 µs vs 90.1 µs at
  200x60) and 5.8x-11.4x faster than per-cell `RS_CELLS_RAW`.
- **Mode accessors.** `ghostty_terminal_mode_get`/`_mode_set` were removed
  upstream in `cfc19e805` (ABI breaking). The old signature was a live trap: it
  took three arguments, not four, since `main` folds `(mode, is_ansi)` into one
  `GhosttyMode`. Calling it with four put the out pointer in the mode slot,
  wrote to address 0, returned success and reported "still set" forever. The
  ANSI bit was originally found by probing (`ESC [ 4 h` read back false for
  `4`, true for `4 | 0x8000`) before `modes.h` documented it.
- **Effect callbacks.** Until `OPT_WRITE_PTY` and friends are registered, the
  grid renders correctly but device-attribute and status queries go
  unanswered: the worst failure shape, since it looks like it works.
- **Scrollback caps.** Setting only `MAX_LINES` left 456 rows of a requested
  10,000 at 200 columns, byte-pruned. `MAX_LINES` is new relative to our ABI,
  where the byte budget read like a row count; that trap shipped as a bug twice.
- **Title report injection.** Before upstream `38e891e6c`, registering the PTY
  write callback (required, or every query times out) also made the terminal
  answer `CSI 21 t` with the window title. A remote host that can set the title
  via OSC 0/2 could read it back as typed input: command injection with one
  keystroke. Upstream now defaults it off behind `T_OPT_TITLE_REPORT`.
- **ConPTY resize pull.** Measured on a real ConPTY: after a resize it repaints
  its buffer from the top, so pulled-back rows are painted over and lost from
  history (a 10 -> 20 row grow after 40 lines lost lines 22-31). Upstream
  `c55f213aa` (#14294) describes the non-repainting variant. Render hold:
  upstream `e50779498` (#14317). DECRQCRA: upstream `9272a2f7c`, `7e2d1793d`.
- **Palette stride.** At stride 4 a palette of `rgb(i, 100, 200)` resolved index
  7 to `(100, 200, 0)`: shifted by one channel, plausible and wrong.
- **Dirty state.** `mark_clean` used to clear only the global flag, leaving all
  24 rows of an 80x24 viewport reading dirty (measured).

- **Why a shim.** The port's status list ended at "select the reader in
  `GhosttyEngine` / `WebGLRenderer`", but `GhosttyEngine` alone used twenty-odd
  exports across the render loop, search, links, mark mode, mouse reporting and
  resize. Moving them all with the binary would have been one unreviewable,
  unbisectable change, so the boundary moved instead: the shim presents the
  existing 83-export ABI over `main`'s 202 (now 180).
- **Reset cursor.** `cursorResetLive.test.ts` passed unchanged after
  `last_reset_seq`/`last_cursor_style_seq` were dropped, through an entirely
  different mechanism.
- **Synchronized output.** Before the render-hold callback the core only set the
  mode bit and we drew whatever the grid held at animation-frame time, which for
  a redraw spanning two chunks was half of each.
- **Cursor reads.** Answering each per-field cursor getter with its own
  `render_state_get` was six boundary crossings per frame for one struct.
- **Foreground/background pairing.** Found by measurement against the pin:
  setting a foreground without a background left the render state reporting
  white forever while `terminal_get` reported the set color. It only showed on
  themes with a `#000000` background, which packs as 0 ("unset").
- **Dirty rows.** `rowDirty` used to walk every row up to `y`; since upstream
  `ad6e72ddc` it jumps between dirty rows (two calls instead of twenty-five for
  one edited row). `mark_clean` used to clear only the global flag, leaving an
  80x24 viewport 24-rows-dirty forever; harmless only because nothing read it.

- **Local connect form default.** It once pre-filled a hardcoded
  `C:\Program Files\PowerShell\7\pwsh.exe`, right on the developer's machine
  and wrong on one without PowerShell 7, where it offered a path that could
  only fail. It now starts blank and fills from detection.
- **`wr-fs` consolidation.** Atomic writes lived in three places (`wr-vault`,
  `wr-ssh`, and the app's `atomic_file.rs`) on the theory that a shared helper
  wasn't worth a dependency edge between standalone crates. The copies
  diverged (the app's lost the explicit Unix permission step), so they were
  collapsed into one crate with one function.
- **Windows rename retry.** Without the retry ladder, saves surfaced as
  "saving a session profile randomly fails", with no pattern a user could
  describe: AV, Search or OneDrive briefly held the destination.

## Terminal panes

- **Ack threshold.** Left at 1 MB when the backend's in-flight window went from
  4 MB to 16 MB: larger batches mean fewer, bigger credit grants, which is the
  shape that starved the frontend at the smaller window.
- **Engine failures went nowhere in release builds.** The webview console isn't
  inspectable on a user's machine, so `console.error` alone was the same as
  saying nothing; failures now go to the Rust-side log.
- **Search box Escape.** Search once had its own Escape handlers on the
  container and input, which fired regardless of what else was open, so
  closing search with a forwarding panel up closed that too. It now uses
  `useDismissable`.
- **Drop destination.** Reading only OSC 7 meant a session that plainly showed
  its directory still had none as far as a drop was concerned; OSC 133/633
  `P;Cwd=` and OSC 1337 `CurrentDir=` are now read too. Guessing `~` or
  scraping the prompt put files where the user didn't ask; a host emitting
  `OSC 7 ; file://h/var/www/html` could redirect a drop to a web root, hence
  confirmation of each newly reported directory.
- **Reconnect storm.** Pane.tsx passes fresh inline closures every render; when
  these were effect dependencies, each status update re-rendered the parent,
  re-fired the connect effect and produced more status updates. The result was
  stacked "connection reset by peer" toasts behind a host-key prompt that never
  got answered. Callbacks are now read through refs.
- **Search close lost focus.** Closing search unmounted the focused input,
  dropping focus to `<body>`, so the pane looked active but swallowed every
  keystroke until clicked.
- **New panes ignored settings.** The settings effects run before the engine
  exists on first mount and only fire on changes, so new panes came up with
  the engine's gray-on-black defaults, and later the cursor preference shipped
  wrong (new panes showed the default block). Every setting is now applied when
  the engine is built.

- **Custom scrollbar origin.** It replaced xterm.js's scrollbar widget, which
  doesn't support arrow buttons (its source throws if `verticalHasArrows` is
  set). Without an explicit `z-index` on the container, the scrollbar's own
  z-index escaped and painted over the connecting/failed/search overlays,
  eating their clicks.
- **"Terminal doesn't fill the container until you resize the window."** The
  opaque scrollbar mask was sized once, while the canvas was at its 80x24
  fallback, so it covered the right half of the pane and painted the theme
  background, which looked like text truncated on a column boundary. Only a
  window resize recomputed it. It now observes the canvases.
- **Hidden scrollbar geometry.** `display: none` made `track.clientHeight` read
  0, corrupting the thumb when a pane resized while unfocused (e.g. a sibling
  split off), and nothing recomputed it until the next scroll or write.
- **Progress stuck after SIGKILL.** Apps should clear OSC 9;4 on exit, but a
  killed one can't, and the indicator spun for the pane's lifetime. A new
  prompt (`A`) or exit report (`D`) now clears it.
- **Killed programs left modes on.** Mouse reporting or the Kitty protocol left
  on made bash read pointer movement as typed text and ignore the keyboard,
  the same symptom as a dropped link. Modes are now snapshotted at `C` and
  reset at the next `A`/`D`.
- **Claude Code pane swept until its first turn.** It opens with `9;4;0`;
  treating a clear as a program reporting for itself keeps the pane quiet from
  launch.
- **Window froze during floods.** Writing inline as IPC delivered froze the
  window for up to 106 ms: ~30 deliveries of 3.5 ms each with no chance to
  render between them. Writes are now metered against the frame; an idle
  keystroke echo still goes in synchronously.
- **Disconnect overlay vanished.** Suppressing the overlay based on the
  auto-close *setting* rather than on whether the pane would actually close
  left a `lost` pane with auto-close on showing nothing and not closing (only
  a clean disconnect closes).
- **MOTD wrapped to the wrong width.** Connecting while the container was still
  0x0 created the PTY at 80x24, stranding the MOTD in a narrow column. A
  two-frame stability check then wasn't enough: the panel layout rests on
  intermediate widths, so the PTY was created at ~38 columns and the server
  truncated the MOTD to match, which no later resize could repair. Now waits
  for ~6 steady frames, capped at 1 s for hidden tabs.

- **Byte channel for input.** The engine's data callback became bytes because
  mouse reports aren't valid text; the line editor decodes for itself.
- **Broadcast fan-out.** Fanning out `onData` sent mouse reports (wrong cell in
  a differently sized sibling), focus reports, and query replies (leaving the
  asking host waiting and sending unasked text to other machines). Broadcast
  now uses `onInput`. Backspace translation still follows the originating
  pane's setting; per-target translation was judged not worth the machinery
  for a case nobody has hit.
- **Link opener refused everything.** `opener:allow-open-url` enables the
  command "without any pre-configured scope", so every URL was refused until
  the capability named a scope. A refused scope and a missing browser also
  looked identical until the toast included the reason.
- **Paste confirmations.** The line-count guard couldn't catch a single line
  carrying a bracketed-paste terminator; the engine's `isPasteSafe` does.
  Naming only the line count for a multi-line paste that also carried an
  escape sequence left the more dangerous property unmentioned.
- **Paste keybinding.** With `rightClickPaste` off there was no way to paste;
  the same hole the copy binding was added to close.
- **Tab switch cursor desync.** Hidden tabs are `display: none` (0x0); fitting
  to that resized the PTY to nothing and back on every switch, leaving the
  cursor a few columns off until a full redraw.
- **Resize SIGWINCH storm.** Each intermediate size during a drag was its own
  SIGWINCH; measured against apt's progress bar, a drag across five row
  boundaries left five stranded bars and scrolled real output off screen.
  Resizes now go out once the drag settles.
- **Blank rows after moving a pane between tabs.** React portal retargeting
  detaches and reattaches the canvas, which can clear the WebGL drawing buffer
  while the context survives. The xterm-era fix (`clearTextureAtlas` +
  `refresh()`) wasn't enough; rebuilding the renderer forces a full repaint.
- **Wedged pane after Alt-Tab.** Returning from another window (including the
  Windows Hello prompt) left the active pane with no keystrokes and no blink
  until a tab switch. WebView2 emits no DOM focus event for native
  activation, so Tauri's window focus event re-asserts focus, deferred a frame
  past WebView2's own restore. Deactivation can also sever the IME context so
  only Enter/arrows work, hence `resetInputContext`.
- **Stale rows when the footer appeared.** The status footer reflowing the
  layout didn't fire a window resize, leaving the row count stale; a
  ResizeObserver on the container fixed it.
- **Padding color.** An earlier attempt matched the padding color one level up
  in App.tsx, and drifted the moment a non-default theme was tested. Then the
  padding composited lighter than the grid at reduced opacity (the grid is
  seen through one more layer), giving three distinct grays; the border-only
  frame fixes it. A frame at z-10 painted over the scrollbar thumb and arrows.
- **Host-key dialog focus.** Auto-focus fires when the session id returns, which
  for a new host is before the handshake finishes; clicking Accept stole focus
  and dropped it to `<body>` when the dialog unmounted.
- **Multi-step auth.** Without a per-request key React reused the dialog and the
  previous round's values filled the next, submitting a password as the
  verification code.
- **Search toggle chord.** The search input is a sibling of the container, so
  the pane's capture handler never saw the chord; a second press went nowhere.

- **Last column clipped "sometimes".** The grid was derived from the full
  container width, so the canvas ran under the scrollbar overlay and the last
  column was clipped whenever `width % cellWidth` was under the gutter. That's
  most widths at a typical cell size but not all, which is why it read as the
  last character vanishing sometimes rather than a grid one column too wide.
- **Escape closed two surfaces.** Canceling a confirmation raised from the
  forwarding panel closed both the confirmation and the panel, losing the form
  just filled in. The dismiss stack fixed it.

## Tabs, splits and pane state

### Tab strip (src/components/TabBar.tsx)

- **Pane map segments.** Segments were once scaled to each split's real sizes,
  which rendered lopsided siblings as invisible slivers. Stacked children were
  then divided evenly, which for `vertical{ A, vertical{ B, C } }` drew A at full
  thickness and B and C at 1px; and a flat bar height gave a nested stack two
  0.5px lines. Rows are now counted so every leaf is exactly 2px.
- **Phantom overflow.** Each split level's gap overflowed its box by
  `(children - 1) * 2px`, invisibly inflating the strip's `scrollWidth` after a
  second nested split until the fade tripped with nothing clipped. Rounding
  also produced 1px false overflows (e.g. when the split icons appeared).
- **Running marker.** A lighter tint of the bar's color washed out against the
  focused tone, hence red; a proportional width changed size with layout and
  title length, hence a fixed 28px.
- **Pane map position.** It used to sit flush against the tab's top edge, which
  looked stuck on once tabs were rounded. A four-row map ran into the protocol
  glyph and title until contents were pushed below it.
- **Spinner removed.** A spinner in the icon slot duplicated the pane-map marker
  and cost the protocol icon. The icon slot used to come and go when focus moved
  between a connected pane and a new empty one, resizing the tab.
- **Gap fill.** The pane map's gaps had a hardcoded dark fill from when the
  active tab was a lightened tint.
- **Hover wash direction.** Hover used a white wash, which on a dark theme moved
  a hovered tab lighter than the strip while the active tab is darker: the
  wrong direction. Rounding every tab, or using a lighter tint for the active
  one, were also tried and rejected.
- **Fillets.** Overpainting the strip color around each fillet antialiased
  slightly better but painted an 8px wrong-colored box over a hovered
  neighbor's fill; masking replaced it. The strip's `px-2` fixed the last tab's
  fillet counting as overflow (fading the last tab) and the first tab's being
  clipped square.
- **Close button.** Hover-gating it everywhere made it unreliable: after
  canceling a close confirmation, `:hover` isn't re-evaluated until the pointer
  moves, so the ✕ was invisible, and missing it re-selected the already active
  tab, which looked like nothing happened.
- **Badge box.** Sizing the badge to its glyph made it resize several times a
  second as the program alternated between emoji and spinner frames.

- **Leftover modes after reconnect.** Claude Code had any-motion mouse
  tracking and the Kitty keyboard protocol on when a link dropped, so after
  auto-reconnect every pointer movement reached bash as `35;39;1M...` text and
  every keystroke as a CSI-u sequence readline couldn't read. This led to
  `sessionModeReset`, and later `leftoverModeReset` for a program killed under
  a live shell.
- **Title badges.** Windows Terminal's apparent "custom tab icon" for Claude
  Code is just the `✳` at the start of its title, which Segoe UI Emoji draws
  as a white asterisk on a green square beside the profile icon.

- **Ghostty as the only engine.** After the Phase 7 A/B, Ghostty presented one
  display frame sooner than the xterm.js WebGL path across typing, streaming
  and TUI redraws, achieved real background transparency the xterm path
  couldn't, and matched scrollback, selection, search, bell and mouse/focus
  reporting. The four gaps then remaining were ABI limits of the pinned
  `ghostty-web@0.4.0` (overline/curly underline, DECSCUSR shapes, wrapped-line
  search in scrollback, Primary DA), since closed. Parser throughput was at
  parity; the WASM build is scalar, so native SIMD didn't apply. Panes once
  carried a toolbar-switchable `engine` field as an escape hatch for those
  gaps; it was removed (see the xterm.js note under the engine section).
- **Pane map height.** The tab strip's pane map once sized itself from "is the
  top split vertical", which gave a nested stack the height of one row and
  rendered its segments sub-pixel (two 0.5px lines in a 3px segment).
- **Inline suggestion vs dropdown.** The dropdown it replaced caused three
  faults in use: it covered the line being typed, captured the arrow keys
  used for history, and painted over the status bar. Drawn as a text run, the
  ghost text drifted a fraction of a pixel per character and ended visibly
  short of the real text on a long command.

- **Sessions reconnecting on split.** Splitting a pane or popping it to a new
  tab reparented PaneLeafView, remounting its slot div, and React's
  `updatePortal` recreates a portal's subtree whenever the target container
  changes, tearing down the live session. Two earlier fixes assumed a timing
  gap where the slot went missing (a fixed delay, then a hidden fallback
  container); both still hit it, since switching to a fallback is itself a
  container change. The fix gives each leaf one permanent container that is
  moved between slots with plain DOM calls.

- **Resize coalescing.** A window drag was measured producing six
  ResizeObserver events in 80 ms. Against a pinned apt progress bar, a drag
  across five row boundaries left five stranded bars and scrolled the output
  away; the same drag delivered once left one bar. The trace also showed
  dozens of unchanged (`sameAsLast=true`) resizes on tab switches, harmless
  only because the kernel ignores an unchanged winsize.
- **Pane-run animation.** An earlier version encoded the sweep's travel as a
  percentage of the element, which silently broke whenever its 28px width
  changed.
- **Floating surfaces.** Were a hardcoded dark hex; once chrome text flipped
  to black on light themes, those dialogs were unreadable.

- **Pane runtime consolidation.** Eight parallel `Record<paneId, T>` hooks in
  App.tsx (statusByPane, connectedAtByPane, loggingByPane, forwardsOpenByPane,
  filesOpenByPane, sessionIdByPane, activityByPane, attentionPanes) had to be
  kept in step by hand; closing a pane meant deleting from all eight, and
  nothing did. `paneRuntime` holds one record per pane.
- **Menu dismissal clicked through.** A window-level listener closed the
  session menu, but the same click went on to the session list underneath,
  connecting to the wrong host (or replacing the browser with its unlock
  prompt). The menu now swallows its dismissing click.
- **History repeat without a write.** Measured against a live host, recalling
  a duplicate often puts nothing on the wire, so a watcher that waited for a
  write couldn't see the case it exists for. A held key once produced no
  feedback until it was released.

- **Hover-gated close button.** Showing ✕ only on hover made it intermittently
  impossible to click: after canceling a confirmation the tab isn't hovered
  until the pointer moves, so ✕ was invisible; hitting it closed the tab,
  missing landed on the tab body and seemed to do nothing.
- **Manual refits.** A `refit()` call was once sprinkled at the end of every
  function that could change what's on screen, easy to forget in a new one;
  `layoutSignature` drives a single layout effect instead. Tab actions map
  roughly 1:1 onto functions that once called `setTabs` directly in App.tsx.
- **Click at column 95.** DEL-to-BS translation once ran over the whole output
  channel, turning a legacy mouse report's 0x7f column byte into 0x08 and
  reporting a click at column 95 as column 8.
- **Dirty rows.** `mark_clean` once cleared only the global dirty flag, leaving
  every viewport row dirty forever; nothing read per-row dirty, so nothing
  broke visibly.
- **Theme name per keystroke.** Typing "Mine" would have renamed the theme per
  letter, each a settings write, with deduplication then finding "M" taken.

## Search

- **Why native search.** The JS controller keyed its match list on a buffer
  generation, so a resize left stale rows highlighted, an alternate-screen round
  trip (opening and leaving vim) restarted it, and scrollback pruning shifted
  every row index it held.
- **Start from the viewport.** Native search originally selected the newest
  match first, on the reasoning that searches start at the prompt. Scrolled
  back, that yanked the viewport to the bottom the moment the query was typed,
  and since a term in history usually also appears near the prompt, search
  looked like it could only see the current screen. Settling on the oldest match
  found in the first frame budget was also wrong on deep scrollback, hence the
  anchor that converges across frames.
- **Highlights vanished when scrolled.** The first version drew from
  `VIEWPORT_MATCHES`, relative to the core's viewport, which never moves here, so
  it drew nothing whenever the pane was scrolled back (exactly where a search
  leaves you). `nativeSearch.test.ts` pins the scrolled case.

- **Native search highlights.** The first version drew highlights from
  `VIEWPORT_MATCHES`, relative to the core's own viewport, which never moves;
  highlights were pinned to the bottom of the buffer, so a pane scrolled back
  (where a search leaves you) showed none.
- **Fresh query jumped to the bottom.** A fresh query once took the newest
  match (one `SELECT_NEXT`), throwing the viewport to the bottom as the query
  was typed, so anything that also occurred near the prompt looked like it was
  only found on the current screen.

- **Native search cost.** At 200x60 with ~10k rows, a cold native pass took
  42.7 ms against 21.3 ms for the JS walk-and-match, so the core is ~2x slower
  on the first pass, but a feed afterward costs 0.69 ms regardless of depth,
  where the JS path re-reads and re-matches everything on each change.
- **search.mjs baseline measured nothing.** The probe's first run had `today`
  timing an empty loop (no `render_state_update`, so every row read blank),
  and reported grid_ref as 5.2x slower than a baseline doing nothing.
- **Keypad mode misread.** The first reading was that the encoder ignored
  mode 66 entirely; the DEC 1035 gate was simply invisible.
- **Injected keys found live.** Driving the real window through `SendInput`
  produced a pane where arrows, function keys and control chords were dead
  while letters typed (letters go through the browser's text path).
- **History recall eaten.** Up rewriting the line once looked like typing and
  opened a suggestion list, which ate the next Up, so recall stopped after one
  press.
- **List overlapped the line.** Placing the list above by `items.length`
  terminal rows left it overlapping the typed line, since list rows are taller.
- **Settings migrations.** Renaming the scrollback field avoided reading an old
  `scrollback: 10000` as 10,000 MB (the largest tier, roughly ten times the
  agreed memory). An earlier opacity attempt made a 5% dim take the tab strip
  from 90% to 63%.

## Fonts and glyph rendering

- **Invisible descriptor failures.** The catch around `FontFace` was assumed to
  handle malformed descriptors until measured: the constructor accepts them and
  they read back as `normal`, nothing throws. `CSS.supports` was then measured
  to agree exactly with what survives, including that one bad tag
  (`"ss01" 1, nonsense`) discards the whole list.
- **Italic wrapper.** Asking a wrapped face for italic rendered the upright glyph
  when the wrapper declared `font-style: italic`, and something other than the
  family's real italic when it didn't, so unset italic slots stay unwrapped.

- **Bundled fonts reported missing.** Measured in the running app:
  `document.fonts.check` answers "can this be drawn right now", so a declared
  but unfetched bundled face read as absent and Settings reported it as not
  installed until something loaded it. `hasFamily` now checks the bundled table
  first.
- **Font switches after bundling.** `GhosttyEngine` already guarded the
  initial load via `document.fonts.ready`, but switching fonts later needed no
  equivalent until fonts shipped in the app; a shipped family arrives over a
  fetch, so `bundledSettled` was added.
- **Monaspace defaults.** Monaspace keeps its coding ligatures in ten stylistic
  sets, all off by default, so without default features it rendered `!=` and
  `->` as plain characters whatever the Ligatures toggle said. The defaults are
  the tags GitHub's documentation recommends.

- **Inline suggestion a pixel high.** The suggestion, the only DOM text over
  the grid, sat a pixel high in Monaspace Neon and JetBrains Mono and flush in
  Fira Code and Consolas. Measured at 14px in a 17px cell:

  | face           | atlas | CSS | shift |
  |----------------|-------|-----|-------|
  | Monaspace Neon |    14 |  13 |    +1 |
  | JetBrains Mono |    14 |  13 |    +1 |
  | Fira Code      |    13 |  13 |     0 |
  | Consolas       |    13 |  13 |     0 |

  Not a Monaspace or bundled-font problem: two baseline formulas whose
  agreement was luck until three fonts with different vertical metrics
  shipped. `cellBaseline.ts` now shares one computation.

## Themes and chrome

- **Tab strip wash.** The strip was `bg-black/20`, a multiply: on Campbell
  (#0c0c0c) it came out two levels darker, so the strip, quiet tabs and active
  tab collapsed into one field, while on Light it took out 51 levels. A fixed
  amount added away from the background gives similar separation on every
  preset.
- **Tab hover.** Washing the strip further only moved away from the active tab,
  so on a dark theme hovering made a tab lighter while the active tab is darker.
  An earlier attempt as one `background: linear-gradient(...), <color>`
  shorthand failed because Chrome kept the gradient and dropped the color.
- **Chrome tone.** All chrome was literal `white/N`: fine on five presets,
  unreadable on Light (`text-white/45` on #ffffff). `--chrome-rgb` flips it.
- **Surfaces.** Floating surfaces were a literal `bg-[#1f2028]` in 21 places;
  once `chromeRgb` flipped text to black, Light themes got black labels on a
  near-black dialog. `SURFACE_LEVELS = 10` reproduces the old color against
  wRusTTY Dark's #16171d to within two levels.
- **Color scheme.** `color-scheme` was a static `light dark` in index.css,
  resolved against the OS preference, so a light theme on a dark-mode machine
  had black slider tracks and drop-downs in a cream dialog.
- **Palette editor layout.** A flat list of 19 fields truncated "Bright
  magenta" to "Bright ma..." and made "Bright bla..." and "Bright blue"
  indistinguishable, hence normal/bright pairs.

## Output delivery and instrumentation

### Output delivery and flow control (src-tauri/src/coalesce.rs)

- **Flush threshold 32 KB -> 256 KB.** At 32 KB a 100 MB flood went out as 2931
  messages of ~33 KB. Measuring both ends (`delivery_stats` and
  `src/lib/deliveryStats.ts`) put the per-message IPC tax at ~0.70 ms against
  ~1.06 ms of engine work, a 40% surcharge. The frontend was mostly idle, not
  blocked: a rAF series across its longest starved window showed frames at a
  clean 15.2 ms cadence while it waited on bytes already sent. At 256 KB a
  100 MB local flood went from 15.1 to 19.7 MB/s with 459 flushes. A flood
  still flushes on the size branch (256 KB accumulates in ~6 ms at 41 MB/s, so
  the median flush is 257 KB); only lulls flush on the ticker. IPC cost
  decomposed into ~0.61 ms fixed per message plus ~2.9 ms per MB; 1 MB would
  save ~6% more wall time but make each engine write ~32 ms (visible jank). At
  256 KB the write is ~8 ms and the worst frame gap moved only 106 -> 121 ms.
  A doc comment kept saying "the 32 KB threshold" long after the change.
- **Unbounded webview queue.** The channel bound never engaged: `Channel::send`
  is fire-and-forget, so the forwarder always drained `rx` at full speed and the
  growth happened in the webview's message queue. Measured on a 100 MB flood
  over LAN SSH, the backend finished sending at 2.56 s while the frontend was
  still draining at 3.69 s, roughly 50 MB of resident `ArrayBuffer`s at peak;
  `yes` or `cat /dev/urandom` grew it until the webview was killed. Credit-based
  flow control (`ack_delivery`) fixed it.
- **In-flight window 4 MB -> 16 MB.** Three 100 MB floods over LAN SSH with
  identical engine work (1553/1551/1543 ms inside write, coreWrite
  1305/1309/1309):

  | window | genuinely starved | active window | worst freeze |
  | ------ | ----------------- | ------------- | ------------ |
  | 4 MB   | 448 ms (19.2%)    | 44.3 MB/s     | 25.2 ms      |
  | 16 MB  | 93 ms (4.3%)      | 47.6 MB/s     | 25.1 ms      |
  | 32 MB  | 54 ms (2.5%)      | 48.8 MB/s     | 25.1 ms      |

  4 MB was the first guess; its reasoning (~56 ms of queued work is plenty)
  ignored that the queue drains in bursts against a frame budget. Past 16 MB the
  constraint becomes the write scheduler's `FRAME_BUDGET_MS`: deliberate pacing
  rose (328 -> 529 ms) as starvation fell, and throughput moved only 10%. 8 MB
  is on the Ctrl+Alt+W cycle if the per-session memory trade needs revisiting.
  The backpressure test once broke silently when the default was retuned, so it
  now pins its own window.

- **`transportOf`.** Routing used to be three separate ternaries defaulting to
  `ssh_*`, so every new source variant silently sent its writes and disconnects
  to the SSH commands until someone noticed.
- **Delivery report warm-up.** Measured on `yes | head -c 100000000`, the wait
  before bulk output was ~1.0 s; counting it made a local flood read 19.1 MB/s
  instead of 24.0 and pulled the parse share under the verdict threshold.
  Excluding only the gap right before the bulk window reported 11 ms of warm-up
  where 2258 ms had been excluded (a run opened with echo, a wait, another small
  delivery, then bulk), understating the backend rate threefold. Warm-up gaps
  also crowded the top-gaps list until filtered.
- **Pacing read as starvation.** Scheduler waits were indistinguishable from an
  idle producer, so a deliberate pause was reported as `idle (starved) ...
  BLOCKED` with the verdict blaming the frontend; `recordPaced` separates them.

- **Write phases.** `deliveryStats` established a local flood was
  engine-bound but left a 2.7x gap between the benchmark harness (~88 MB/s)
  and a live pane (~33 MB/s). `writePhases` narrowed it to `writeBytes` (93%),
  ruling out the JS OSC scan, response draining and callbacks; the cost was
  invariant to content shape, grid geometry and scrollback.
- **Page-state context line.** The same WASM in the same binary parsed at
  11.9 ms/MB in one page session and 30.5 in another, stable to 0.2% within
  each, while a pure-JS pass over the same bytes moved 8%. Workload, grid,
  scrollback, volume and backend were measured and cleared; a throughput
  figure with no record of page state let that go unnoticed for weeks.
  (The eventual cause was the attached inspector; see Benchmarks.)
- **Unparsed bytes.** Buffered writes (core not yet loaded) entered no phase,
  so the throughput line divided bytes by time nobody spent; that's how a
  Ghostty figure about 3x too fast reached the published findings.

- **Write scheduler's motivation.** On a 100 MB flood into a live pane the
  worst main-thread block was 106 ms, while one delivery cost 3.50 ms at the
  median and 7.30 ms at p95: roughly thirty deliveries ran back to back
  because `onData` wrote synchronously as IPC handed bytes over. The
  benchmark harness never showed it, since it yields between deliveries
  (worst stall ~1 frame). At ~86 MB/s the parser itself was no longer the
  constraint.

- **Pacing counted against the engine.** The first delivery report after the
  write scheduler landed counted its deliberate waits against the engine,
  lowering the parse share below the ENGINE-BOUND threshold and the delivery
  rate below the backend's, so a frontend yielding to render read as one that
  couldn't keep up.
- **Report split out.** At ~200 lines of formatting, the reporting half was
  the bulk of what release bundles carried for a tool unreachable in release
  builds, so it moved to `deliveryReport.ts` behind a dynamic import.

### Ligatures (src/lib/ghostty/ligatureRuns.ts)

- **Why ligatures never fired.** Canvas 2D runs the full shaping stack; drawing
  one cell at a time was the only reason ligatures never happened. Nothing
  disabled them.
- **Missing punctuation.** Leaving `...`, `?.`, `??` and similar out of the
  run alphabet was why fonts' dot and question-mark ligatures never fired.

- **Pane flood's purpose.** A live pane parsed ~2.66x slower than the harness
  running the same WASM in the same WebView with identical page state.
  Content, delivery size, scrollback, backend contention, queue depth and
  engine accumulation were each cleared, leaving two confounded candidates:
  every production measurement came over SSH, and production grids were about
  six times larger than any the harness had measured. With no local shell in
  the app at the time, `paneFlood` injected bytes on the frontend instead.
  Read against ~30 ms/MB (the SSH pane) and ~11 ms/MB (the harness). The
  answer turned out to be the attached inspector: 11.14 ms/MB with DevTools
  closed against 30.65 open (2.75x), while the pure-JS pass moved 16%.
- **Unsaved local shells restored.** An unsaved local shell was once dropped
  on restart alongside unsaved SSH sessions, a rule meant for passwords that
  were never stored. A restart lost every ordinary shell tab while an
  administrator one came back as its form.

## Benchmarks (src/bench, tools/parse-probes)

- **Parse probes' motivation.** Ghostty's WASM parsed at ~29 ns/byte, 100+
  cycles per byte, while xterm.js (a JavaScript state machine) was about twice
  as fast on the same flood. The suspicion was per-cell work (grapheme
  segmentation, width, style resolution, PageList bookkeeping) without native
  Ghostty's SIMD fast paths; the vendored binary had no v128 anywhere.
- **Coalescer model.** `COALESCE_THRESHOLD` was once documented as a cap and
  the harness fed exactly that size, a best case the app never produces: small
  deliveries parse in well under a frame, so the stall metric bottomed out at
  the refresh interval regardless of engine speed. The threshold was raised
  from 32 KB to 256 KB after measuring a ~40% per-message IPC tax on top of
  engine time at 32 KB.
- **`scrollsMainScreen` guard.** Added because a silently dead benchmark round
  cost weeks.
- **Phase 8.** The block workloads measured the flood freeze that moving the
  parser to a Web Worker was meant to remove.

- **`setTimeout(0)` yields.** Nested timers are clamped to 4 ms after five
  levels, so a feed loop awaiting a timer slept 4 ms per yield: at 100 MB, 400
  yields put 1.6 s of sleep into a drain with ~1.2 s of parsing, burying the
  difference between engines. Replaced with a `MessageChannel` macrotask.
- **Paced parse measurement.** An earlier version fed both engines a
  rate-limited stream and timed presentation, which throttled the synchronous
  engine (its parse counted against the frame budget) while the async one
  enqueued and escaped, inverting the result.
- **Dead rounds.** The harness published a Ghostty parse figure about 3x too
  fast for weeks: the engine could accept writes and parse none, completing in
  milliseconds. A run with two of three rounds dead reported ~82 MB/s against
  a true ~31, which is why a live pane appeared 2.7x slower than the harness;
  both were always the same speed. The row-count check (`MIN_FLOOD_BYTES`)
  now rejects such rounds.
- **Batched yields.** The block feed once yielded every eighth delivery,
  measuring a stall the app can't produce and hiding the per-delivery one.
- **Drain vs parse.** Wall-clock drain once conflated the harness's yields
  with engine time, making it incomparable; `parseMeanMs` separates them.
- **Visibility guard.** The geometry-based guard for a paused renderer was
  wrong in both directions: it fired on the harness's own resize and missed
  results tables pushing the hosts off screen. Counting empty trials became
  the backstop, replacing the earlier empty-trial flag.
- **Inspector skew.** Every figure was off by ~2.75x for a while because the
  recorders could only be reached by typing into the console, which attaches
  an inspector and puts V8's WebAssembly into a debuggable tier. Days went
  into chasing the discrepancy through the workload, grid, scrollback,
  transport, backend and page state. Two published claims were retracted and
  then un-retracted.

- **iter.mjs baseline path.** The probe defaulted to `vendor/ghostty-vt.wasm`
  until the port put a main binary there; both probes then died on
  `ghostty_terminal_new_with_config is not a function` (the v1.3.1 ABI asked
  of a main binary), which read as broken probes. They now default to
  `vendor-131/`.
- **RAW measured slower than four gets.** Allocating a DataView per cell made
  RAW measure 2x slower than four separate gets, which is arithmetically
  impossible and was the tell.
- **Terminal constructor change.** When iter.mjs was first written, the
  terminal constructor took a GhosttyTerminalOptions struct by pointer; tip
  takes cols and rows as plain arguments, and scrollback became a
  `terminal_set` option.
- **viewport.mjs bound.** From call-shape costs alone, the iterator model was
  bounded at 3.0x-11.3x the single batched read.

- **Host visibility guard.** Paused xterm rendering silently gutted the TUI
  row: 18 usable samples of 120, the other 102 flagged `⚠️ empty`, because a
  two-minute workload is long enough for someone to scroll down and read
  tables that had already landed. The survivors were the first 15% of the
  run, and the flag was easy to read past, so runs now abort instead.
  The first version of the guard latched on the grid-pin resize and aborted
  every 200x60 run before a trial ran, with a message blaming the user; the
  message now says whether the host is still hidden.

- **allocCompat copying exports.** The compatibility shim first copied the
  exports with `Object.assign`, costing ~1.85x on call-heavy loops (60.2µs vs
  32.5µs per 200x60 frame on the `iterate` path). Since only the `main` arm
  was wrapped, it looked like an upstream regression on the `d9ffbbf17` bump
  (`iterate` and `raw` ~2x slower) until the same loop against unwrapped
  exports showed the two pins identical. Delegating via `Object.create`
  measured 30.1µs, i.e. free.
- **Unanswered DSR on local shells.** Found by writing `wr-local`'s tests the
  obvious way: a shell that should print one word produced exactly six bytes
  and hung, because ConPTY waits for a cursor position reply. See
  docs/LOCAL_SHELL_PLAN.md, "What Phase 1 actually did".

- **Harness took a shorter path.** Without a bell handler, the harness took
  the shorter `parseSegment` path while the app went through
  `parseAndDispatch` and its full-buffer `scanOsc`, so it wasn't measuring the
  code the app runs.
- **Ignored readiness check.** Ignoring the engine's ready boolean is how a
  parse figure ~3x too fast reached the findings.
- **Grid pin undone.** Auto-fit undid a pinned grid larger than the container:
  a run asking for 200x60 measured 5x18 and said so only in a header nobody
  read.
- **Visibility latch on resize.** Pinning 200x60 resized both canvases from
  roughly 640x400 to 1600x1020, transiently perturbing intersection; the latch
  recorded it and never cleared, so every large-grid run aborted before a
  trial. 80x24 moved too little to trip it, so it looked like a large-grid
  problem rather than an ordering one.
- **Hosts below the results.** The engine hosts once rendered below the
  results tables, so each completed workload pushed them down; a
  seven-workload suite walked them out of view on its own, causing the TUI
  row's n=18 of 120.

- **Main-ABI oracle traps.** Almost every trap found during the port
  (`GhosttyPoint`'s offsets, the palette stride, blank scrollback reads)
  produced plausible output; only comparing the same core through both ABIs
  told a correct port from a plausible one. Truncating `attrs2` in the
  oracle's `trimRow` once produced arrays equal in every value but length,
  which read as a color divergence.
- **Grid snapshot colors.** Colors and attributes weren't compared at first,
  so the renderer's default-color remap could break outright with every test
  passing. The cell packing also once dropped overline and underline styles
  (every underline arrived as one bit).
- **Backpressure window question.** A 100 MB flood left the frontend idle 33%
  of the active window, ~431 ms across 475 deliveries (~0.9 ms each): either
  the window was too tight or the IPC round trip showed through with a 4 MB
  queue instead of 50. Cycling window sizes was added to separate the two.
- **Measurement overlay.** Added because both recorders were console-only, so
  an inspector was attached to every production measurement (see the
  inspector note above). The harness never had the problem since it renders
  results on screen.

## Command activity and progress

- **Indicator stuck after quitting tmux or nano.** Markers were once ignored
  while the alternate screen was up. OSC dispatch runs before the parser, so the
  chunk leaving the alternate screen (carrying the closing `D`/`A`) still read
  as alternate and was dropped, stranding the run. Now only the display is
  suppressed on the alternate screen.
- **"It never stops."** The shell reports a long-lived program (`claude`,
  `cargo watch`) as one command for the whole session, so the running marker
  never stopped. A program reporting OSC 9;4 now owns the indicator for the
  rest of the run; it's sticky so the marker doesn't return between turns.

## Autocomplete and command history

- **Subsequence matching was too loose.** The fuzzy fallback was a plain
  subsequence test. A command line is long and full of common letters, so
  almost any short input matched almost everything: from a real screenshot,
  typing `exit` matched `/home/dev/Repos/xrdp/xrdp_accel_assist/...` (the `e`
  of *home*, the `x` of *xrdp*, an `i` and a `t` from *assist*), and with no
  prefix hits to outrank them the whole list was noise. It was replaced by
  word-initials matching anchored at the command's first character.
- **Ranking in the backend.** Ranking in the webview would save an IPC round trip
  per keystroke, but would ship every command the user has ever run into the
  process that renders untrusted output. It also leaves room for a
  vault-encrypted store without changing the API.

- **Key bindings.** Tab was once claimed while a suggestion showed, making the
  two completions race; the remembered command won over the path being typed.
  Up/Down have had three rules: first claimed whenever anything showed, which
  broke history recall (recalling a command redrew the line, which opened a
  list, so the second Up was eaten by a popup the first had conjured); then
  never claimed, which was right while lists could appear unbidden; now
  claimed only in the explicitly summoned list mode.
- **Inline by default.** The list produced three faults in practice (covering
  the typed line, overflowing the pane, stealing navigation keys); the inline
  view can't produce any of them.
- **List placement.** An earlier version checked whether `items.length` cells
  were free below the cursor, but a list row is half again as tall as a
  terminal row; near the bottom of the pane it chose "below" and spilled back
  over the typed line.

- **Keystroke buffer.** The obvious design (accumulate `onInput` bytes since the
  last Enter) works in a demo and inserts garbage in real use; the prompt line
  is now read off the grid.
- **One-key answers.** At an inferred prompt, `n` typed at apt's
  `Do you want to continue? [Y/n]` was read as a one-character command line,
  and every remembered command starting with `n` was offered mid-install.
- **Double-believed quiet period.** Pressing Up within the quiet window after a
  command's output took no origin; the shell recalled a command anyway; pausing
  and pressing Up again then passed the quiet test with a full command on
  screen, so the origin landed at the end of that command. The history flicker
  blinked the tail rather than the command, and capture recorded a fragment.
- **`B` marker measured late.** Origin measurement was deferred to the end of the
  write, overshooting by whatever the rest of the chunk drew. readline reprints
  the prompt and the edited line in one write on SIGWINCH, `^L` and after
  job-control messages, so a single resize moved the origin to the end of the
  recalled command.

- **History repeat feedback.** Prompted by twenty-eight presses of Up on one
  `journalctl` line with nothing on screen changing. The first version
  compared only once the far end replied, and treated no reply as a wedged
  session shown in amber. Both halves were wrong, measured against a live
  host: readline diffs the recalled line and may send nothing for a duplicate
  (the one case it existed for was the one it couldn't see), and silence also
  happens mid-`apt`, at a password prompt, or in a program that ignores arrows,
  so it cried wolf. A pending press used to be canceled by the next key, so a
  fast walk produced no feedback until the hand stopped.

- **One machine listed twice in Settings.** When a saved session's credential
  couldn't be used (vault locked, nothing saved), the pane fell back to the
  connect form and connected as plain `ssh`. Keyed by address, that run's
  history split off from the session's own. A plain source now files under the
  profile while it still points where the stored profile does.

- **History repeat feedback.** The first attempt drew a translucent band over
  the input and a solid bar under it. In the running app it was too faint to
  notice and, once strengthened, an obvious piece of chrome on top of the
  terminal. It also drew a fixed-width band on an empty line (the bottom of
  history), which blinking text can't. Blinking the command itself replaced
  it; the earlier versions failed by being subtle, not brief.
- **Held Up key.** The first blink version simply restarted the hide timer, so
  under Windows auto-repeat (~30ms) the text went dark on the first press and
  stayed dark until release, reading as deleted. `GAP_MS` restores it for at
  least one painted frame between flashes.

## SSH

### SSH command layer (src-tauri/src/ssh.rs)

- **Origin.** The module replaced the Phase 0 echo demo, keeping its push
  `Channel` shape.
- **Leaked prompts.** Prompts were first keyed by request id alone; an
  unanswered one (the user closed the pane) leaked its entry and parked the
  connect task on `rx.await` for the life of the process. Entries now record
  their session so `ssh_disconnect` can answer them.
- **Shared id counter.** Session, request and forward ids once shared one
  counter; session ids moved to the registry.
- **Forwards dead after reconnect.** A `ForwardHandle` is bound to the
  `client::Handle` it was opened on. Before auto-reconnect a dropped session was
  torn down with its forwards; afterward the pane came back and the forwards
  didn't: listeners still accepted, the panel still listed them, nothing got
  through. Specs are now kept and forwards are restored on reconnect.
- **Forward list lived in the panel.** The panel held the list in component
  state, so closing it lost track of forwards still running, with no way to
  stop them. The backend now owns the list.
- **Ephemeral ports on restore.** An empty port field produces `bind_port: 0`
  (`Number(bindPort) || 0`); replaying the spec rebound a different port on
  every reconnect, breaking clients while the row looked healthy.
- **Liveness from the handle.** Reading liveness off `handle.is_some()` reported
  forwards as working through an outage, since the handle is deliberately kept.
- **Retry vs. restore race.** Without the `reestablishing` claim, the loser
  recorded "address already in use" on an entry the winner had just brought up.
- **Panel refetched too early.** It refetched on status events, but `Connected`
  is emitted inside `SshConnector::connect` before the session is published and
  forwards restored, so it read the pre-restore list; hence
  `ssh-forwards-changed`.
- **Disconnect cleanup** used to re-acquire the forwards lock once per forward.
- **Wake-on-LAN through a jump.** A magic packet is a local broadcast and can't
  reach a host behind a jump or proxy; waking would fail a connection that
  would otherwise have succeeded. Waking through the jump is a separate,
  unbuilt feature.

- **`transfer_sftp` not reset on disconnect.** Only the browsing cell was reset;
  harmless while a disconnected session was always dropped, but once session ids
  survived their transport (auto-reconnect) the cell handed the dead channel
  back forever.
- **Auth timeout and keyboard-interactive.** A flat timeout around auth assumed
  only host-key verification waits on a human; with keyboard-interactive it
  would fail every 2FA login in the time it takes to read a push notification.
  A bare "prompt open" flag wasn't enough either: answering at second 14 of 15
  left it false by the time it was read, failing the connection after one second
  of real server silence.
- **Keyboard-interactive on Debian/Ubuntu.** These ship
  `KbdInteractiveAuthentication no` with `PasswordAuthentication yes`, so the
  method was refused outright on a large share of hosts; "Prompt me" now falls
  back to asking for a password.
- **Nagle.** russh leaves Nagle on by default; against a peer doing delayed ACK
  that added up to ~40 ms to every keystroke's echo.

- **Known hosts: TOFU in the UI.** Written in-house partly because r-shell's
  `check_server_key` unconditionally returned `Ok(true)`; this store always
  surfaces the accept/reject decision.
- **Known hosts: case.** Keying on the raw host string made `Example.com:22`
  and `example.com:22` two entries, so connecting by a differently-cased name
  reprompted as `Unknown` for an already-trusted host. Ids are lowercased, and
  older files are normalized on read.
- **Known hosts: new key type.** An algorithm with no pinned key used to get
  the routine first-connection prompt, which is exactly what a MITM offering
  an unpinned type hopes for. It's now `NewKeyType`, naming what's on record,
  and `host_key_preference` puts pinned types first so honest servers never
  reach it.
- **Known hosts: stale writers.** Each connector and the management UI load
  their own copy; persisting from a copy loaded before a deletion rewrote the
  file and resurrected the deleted key. `learn` now reloads before writing.

- **Port forwarding unusable.** `ForwardSpec` had `rename_all` but not
  `rename_all_fields`, so variants deserialized correctly while fields were
  still expected in snake_case. The frontend sends `bindHost`, so every
  `ssh_add_forward` was rejected with "missing field `bind_host`" before any
  forwarding code ran. `SshEvent` already had both attributes.
- **Truncated forwarded data.** The stream copy was once two futures racing
  under `tokio::select!`, dropping whichever direction was still running when
  the other finished, so data in flight when one side hit EOF was silently
  lost. Replaced with `copy_bidirectional`.
- **"Prompt me" failing silently.** Against a server with
  `KbdInteractiveAuthentication no`, "Prompt me" failed with "authentication
  failed" before any dialog: the server's list of acceptable methods
  (`password`) was thrown away.

- **Dead forwards drawn as live.** The forward list once lived in component
  state, so a forward whose connection had gone was drawn like a working one:
  a local port that accepts connections and carries nothing. Refetching on
  `connected` alone was also wrong, since that status arrives from inside the
  handshake before forwards are restored; an earlier test's mock already
  returned the dead row at the status change, so it passed against code that
  couldn't show the failure.
- **Mouse reporting untested.** The hand-rolled reporting had no test: suites
  touching the mouse stubbed `mouseTracking` and never looked at the bytes.
- **Paste confirmation.** The confirmation prompt was once based on line
  count, missing a single line carrying the bracket end sequence.
- **Release logging.** Without the log plugin in release builds, frontend
  faults such as an engine that failed to start vanished and the app just
  looked broken.
- **Title report injection.** Registering WRITE_PTY once made the core answer
  title queries, so a host could set a title with OSC 2 and read it back into
  its own input stream; upstream `38e891e6c` made the report opt-in.

## Telnet

- **Leaked sockets on close.** The read task once held `input_tx.clone()`, so
  `disconnect` dropping the session's sender never closed the channel: the
  write task never ended, its `OwnedWriteHalf` was never dropped, and no FIN
  was sent. Each closed telnet tab left an ESTABLISHED connection until the
  process exited. A smoke test caught it when two sockets closed at once on
  quit with only one session open. The read task now holds a `WeakSender`.

## SFTP and the Files panel

### SFTP and remote editing (src-tauri/src/sftp.rs)

- **Elevation captured too early.** The file watcher captures an edit's
  elevation once, when the watch is created. Had elevation been an `Option`
  swapped into the map later, `sftp_elevate_edit` would have elevated an entry
  the watcher couldn't see, and the next Ctrl-S would fail exactly as before
  while reporting success. Hence the always-present shared cell.
- **Self-conflicting saves.** The expected mtime is updated after each save so
  the next save compares against what it just wrote, not a value two saves old.
- **Owner prediction never fired.** The first version compared owner *names*,
  but SFTP v3 (OpenSSH) carries no names and `russh_sftp` decodes them as
  `None`, so the predicate could never fire on any host. It now uses numeric
  ids from `id`.
- **Inert extension list.** `dockerfile` was removed: the file is named
  `Dockerfile` with no dot, so the entry only matched `something.dockerfile`.
  `svg` is excluded because Windows opens it in Edge and SVG can carry
  `<script>` from a `file://` temp path; weaker than `.hta` but still script
  execution from a remote-chosen file.
- **Reserved device names.** `tempdir.join("NUL")` opens the null device: the
  write succeeds, the watcher watches nothing and edits are silently lost.
- **Editor exit grace.** Tearing the watch down immediately on editor exit
  deleted the temp directory under a save still in its 300 ms debounce, losing
  the user's last edit at the moment they believed they were done.
- **Edit downloaded before validation.** The download used to run before the
  filename checks, so a file the panel could never open was downloaded in full
  first. Edit downloads also stream to disk; reading whole held the file twice.

- **Editing a watched path.** Renaming a watched file made the next save
  recreate the old name beside the new one; deleting it made the next save
  bring it back, minutes later and with no error. Both are now refused while a
  watch exists. Retargeting on rename was considered, but delete has no
  equivalent and one rule is easier to rely on.
- **Drag-drop path.** Tauri's native drag-drop was diagnosed as breaking
  tab-to-pane HTML5 dragging on WebView2 and switched off, so dropped files
  have no path and their bytes must cross IPC.
- **Transfer retries.** Added because a server hiccup mid-copy was fatal to,
  e.g., a 500-file job on file 400. Retries restart the file, so its progress
  goes backward, which reflects what is actually being sent.

- **Inconsistent transfer endings.** Each runner used to report its own ending,
  which is how a canceled folder transfer came to report differently from a
  canceled file. `finish_transfer` is now the single place.
- **Disconnect cleanup.** `stop_watching_session` used to collect stale ids
  under one lock, then re-acquire it per id; nothing in the removal is async,
  so it is now one `retain`.

- **Files panel opened at home.** It used to open at the remote home, so you
  could drop a file onto a pane in `/etc/nginx`, open the panel to check, and be
  looking at `/home/tim`; it now opens at the reported working directory.
- **Lost watch markers.** Markers were only what the current panel instance had
  opened, so closing and reopening the panel lost them while the watches kept
  uploading on save; the panel now adopts the backend's list on mount.
- **One transfer at a time.** The backend always supported concurrent transfers,
  but the panel had a single transfer row, so nothing else could start during a
  minutes-long folder copy.
- **Pending transfer rows.** With two transfers started quickly, both rows were
  "the pending one" and a single `transferStarted` stamped its id onto both;
  rows now have their own keys.
- **Failed transfers vanished.** A failure used to be just a toast; for a folder
  that died on file 400 of 500 the only option was to set the whole thing up
  again. Failed rows now stay with a Retry.
- **Rename submitted twice.** The blur after a successful Enter submitted again
  against stale state, reporting "already exists" for a rename that had worked.
- **Root offers.** Root was first offered only after the host refused, because
  the panel knew the user's name but not their groups. With numeric `id`
  output it now predicts definite refusals and goes straight to sudo; when
  elevation fails it offers the ordinary open, which used to be what happened
  anyway (open fine, fail on save).
- **Owner tooltip** was always blank, since SFTP v3 carries no owner names; it
  now falls back to numeric ids.

- **sudo probe allowlist.** Classifying `sudo -v`'s refusal against an allowlist
  of phrasings meant a sudo saying `interactive authentication is required`
  (rather than `a password is required`) was reported as a hard failure, and
  the password dialog that would have satisfied it never opened. The probe now
  treats any unrecognized refusal as "needs a password"; command failures keep
  the allowlist.

- **`verdictForDownload` removed** (src/lib/fileActions.ts). It refused two
  things that later became supported: a folder (now walked and copied file by
  file) and a second concurrent transfer (the backend always allowed it; only
  the panel's single progress row didn't). Since both rules were satisfied
  rather than relaxed, a function that could only answer "yes" was dropped.
  What's still refusable, a tree too large to take on, is decided by the walk.

- **`SftpClient::read` removed.** It returned the whole file as a `Vec<u8>`,
  so every download, including the one behind each remote edit, was held in
  memory, reported no progress and couldn't be stopped, for a file of
  whatever size the host reports. `download` replaced its last caller.
- **Save left stale tails.** `SftpSession::write` opens with `WRITE` alone (no
  `CREATE`, no `TRUNCATE`), so saving a shorter file produced a corrupt hybrid
  with the old tail past the new end, silently. `SftpClient::write` uses
  `create` instead.
- **Local shells' exit notice.** Printing the exit line into the stream
  matches Windows Terminal, WezTerm and kitty; carrying it on
  `ConnectionStatus::Disconnected` would have touched every transport's match
  arms for one case.

- **Write prediction never fired.** The first `canWrite` compared owner names,
  but SFTP v3 (what OpenSSH speaks) carries none and `russh_sftp` decodes them
  as null unconditionally, so it answered "no idea" for every file on every
  host. It now compares numeric uid/gid.

## Saved sessions, imports and transports

### Sessions and reconnect (src-tauri/src/session_registry.rs)

- **Shared registry.** `ssh.rs`, `telnet.rs` and `serial.rs` each defined the
  same session map, id counter, `lookup`, write/resize/disconnect bodies and a
  ~35-line spawn-connect block: about 150 of their ~790 lines, differing only in
  session and event types. They now share a registry generic over
  `Connector`/`Session`. The old copies reached back through
  `app.state::<XxxState>()` to clean up after a failed handshake, a coupling
  that didn't survive being made generic.
- **Handshake under the session mutex.** `connect(&mut self)` used to live on
  the same type as `write` and `resize`, so for SSH the session mutex was held
  across TCP connect, KEX, auth and the host-key prompt (which waits on a
  human). Input and resizes queued behind it and anything else wanting the lock
  could deadlock. Splitting `Connector` from `Session` removed this; `Slot`
  keeps the old (accidental) queue-and-replay behavior deliberately, since
  failing fast would have been a regression, especially for a pane resized
  while its host-key prompt was up.
- **Publish under the map lock.** The map lock used to be held across the
  replay too. Since an SSH `write` into a full window blocks until the remote
  reads, one pane finishing its handshake into a wedged host could stall input
  to every other SSH pane, the file browser and closing any of them. Narrowing
  it opened a race with `disconnect` (queued input, possibly a password, going
  to a host the user just declined), closed by the `Cancelled` mark under the
  slot lock.
- **Reconnects at the wrong size.** A transport opens its PTY at the size the
  connector was built with, so a reconnected pane came back at its original
  size; live slots now remember their last size.
- **Transport loss reporting.** Only reporting restoration was the original
  mistake: between a drop and the reconnect (potentially minutes), port
  forwards looked healthy while carrying nothing.
- **Connector build failures retry.** Treating an unresolvable profile as fatal
  was wrong for serial adapters not yet replugged and for a vault the user
  unlocks during the window.

- **Saved serial sessions.** Serial was once ad hoc only, because a COM
  number stops meaning anything when an adapter moves socket. `SerialProfile`
  now stores the adapter's USB identity and resolves the port at connect time.
- **Wake-on-LAN validated on save.** A bad MAC or wake target used to save
  cleanly and fail a minute into a connection, in a pane, with the form long
  closed.
- **SSH config import: repeated aliases.** Splitting one host's settings across
  two `Host` blocks (legal and not rare) used to produce two profiles of the
  same name.
- **PuTTY import's purpose.** For a tool pitched as a PuTTY replacement, the
  migration path mattered more than any single feature: someone with forty
  saved sessions won't retype them.

### Windows Hello unlock (src-tauri/src/hello.rs)

- **Why a TPM key credential.** The earlier OS-keyring unlock stores its KEK in
  DPAPI-protected Credential Manager, readable by any process running as the
  user with a plain `CredRead` and no prompt (the Hello check in front of it
  was only a consent gate on the app's own code path), and recoverable offline
  from a stolen disk with the account password.
- **Activation test.** A wrong WinRT activation route bit the
  `UserConsentVerifier` work: it compiled and then failed at runtime with
  "Class not registered", hence a test that exercises activation for real.
- **Invisible prompts.** A Hello prompt raised while the process isn't
  foreground opens invisibly behind everything, which is why
  `credential_exists` must never prompt and why test timeouts are read as
  "nobody answered".

- **Connector and Session split.** The transport contract was once one trait
  with `connect(&mut self)` alongside `write`/`resize`, so "not yet connected"
  and "connected" were the same type. Since callers hold sessions behind a
  mutex, the handshake held it throughout (TCP connect, KEX, auth, and the
  host-key prompt waiting on a person), and any input or resize queued
  behind it.
- **Maximize on closing the last tab.** The first fix suppressed only Tauri's
  mousedown maximize; the spacer's own `onDoubleClick` still fired, since
  `dblclick` targets the completing click's element. Each was confirmed to
  maximize on its own in the running app.

- **Recycled import ids.** Imported profile ids were once counted
  (`putty-0`, `putty-1`, ...), taking the first free number, so deleting
  profiles freed numbers for the next import to give to different hosts.
  Since a profile id is also its vault key and a credential can outlive its
  profile, a new profile could silently authenticate to one host with the
  secret saved for another, presenting as a server-side problem. Ids now take
  a random suffix.

## Vault

- **Rebrand.** The keyring service moved from `sh.wrshell.app` to
  `sh.wrustty.app`; without the migration, Windows sign-in unlock silently
  stopped working for anyone who had it enabled. The export format string
  (`wr-shell-export-v1`) and the old settings key also predate the rebrand.
- **Hello activation.** `CoCreateInstance` is classic-COM activation and doesn't
  apply to a WinRT interop factory; that mismatch is what produced "Class not
  registered" in another non-UWP app's attempt. The window-less
  `RequestVerificationAsync` could open its prompt behind the app.
- **v2 vault format.** Pre-v2 vaults with Windows sign-in enabled kept a
  plaintext copy of the data key in Credential Manager, the weakness the format
  change closed. The keyring method now stores a random KEK; a TPM-backed Hello
  provider was added later as the strong option.
- **Unlock method reporting.** With both methods enrolled, an earlier version
  could report one method's protection while unlocking with the other's.
- **Enrollment under the lock.** Enrollment held the vault mutex across the
  Hello prompt, wedging every other vault command (including ones the UI polls)
  and turning impatient clicks into a prompt storm.
- **Export bundle.** Exporting only the vault left users stranded on a new
  machine, since profiles and workspaces reference it by id; the bundle now
  carries all three. Workspaces were added to the format later, defaulted
  rather than version-bumped.
- **Path from the webview.** Export and import used to accept a path string
  from the frontend; anything that could reach `invoke` could write the bundle
  anywhere or import a planted file (which replaces the vault and clears the
  OS-unlock key). The dialog now runs on the Rust side.

- **Hello prompt investigation (win_focus.rs).** Measured against a live prompt,
  the broker's token is `S-1-16-8202` against our `S-1-16-8192`, so UIPI drops
  cross-process messages: `WM_SETICON` was verified inert (`WM_GETICON` still
  read 0), `AttachThreadInput` onto its thread failed with
  `ERROR_ACCESS_DENIED`, and `SetParent`/`GWLP_HWNDPARENT` don't work across
  processes anyway. `CredentialUIBroker.exe` carries no icon, hence the generic
  button. Re-branding via `SHGetPropertyStoreForWindow` was tried:
  `IPropertyStore::SetValue` returns `E_ACCESSDENIED` while `GetValue` succeeds
  and reports the AUMID unset. `ITaskbarList::DeleteTab` was confirmed by
  reading the taskbar over UI Automation: the `Credential Manager UI Host`
  entry is present before and gone after.
- **Foreground.** A plain `SetForegroundWindow` was tried first; denied requests
  silently no-op, so it looked fixed in the code but never took effect. The
  `AllowSetForegroundWindow` grant failed intermittently because it's only
  honored while we hold the foreground, which may have lapsed if an earlier
  prompt was still up. From a non-foreground process, both the bare call and
  the `AttachThreadInput` version were measured failing against an ordinary
  same-integrity window.

- **Why the v2 format.** In v1 the Argon2id output was the file key, so there
  could only be one way in, and "unlock with Windows sign-in" worked around it
  by stashing a plaintext copy of that key in the OS credential store. v2 uses
  a random DEK wrapped once per unlock method. The OS-keyring wrapper was kept
  to preserve that feature through the format change; it's exactly as strong
  as v1's arrangement, and v2 made replacing it with Hello a provider swap
  rather than a rewrite.

- **Editing a saved password session.** Credential fields start blank when a
  secret is vaulted, so pressing Connect after editing any saved password
  session sent a blank password and failed every time. The form now connects
  through the profile in that case.
- **Empty password sent.** Password auth with nothing typed or stored once
  sent an empty password: a guaranteed rejection that spent one of the
  server's `MaxAuthTries`. It now prompts.
- **Vault offered to non-SSH sessions.** Telnet, serial and local sessions
  were offered a vault entry for credentials they never collect.
- **Vault `Drop`.** A hand-written `Drop` existed only while the key was a
  bare `[u8; 32]`; with `ZeroizeOnDrop` key types it became unnecessary.
- **Datalist for TERM.** A datalist filtered to the field's text, so picking
  one value collapsed the list and the control looked broken.

## Wake-on-LAN

- **Validation moved earlier.** MAC and target checks used to happen only at
  connect time, so a garbage MAC saved cleanly and failed a minute later in a
  pane.
- **Unbounded wait.** An imported `waitSeconds: u64::MAX` panicked in
  `Instant + Duration` (a `checked_add().expect(..)`) inside the connect task,
  wedging the session in `Connecting`; it is now clamped to ten minutes.
- **Flaky closed-port test.** `closed_port()` used to bind port 0, note the
  number and drop it; its comment called that "as close to 'definitely
  closed' as a test can get", which is false when the whole machine shares the
  pool. Windows hands out ephemeral ports sequentially (twelve bind/close
  cycles gave 56816..56827), and reuse needs the cursor to wrap the range,
  measured at 15,732 allocations, which is why it reproduced under a browser
  and dev server and never on demand. The note the fix came from blamed the
  six `wake` tests racing each other, four orders of magnitude short. The fix
  takes ports from a band below the ephemeral range. Its first version offset
  by process id alone, so all three callers in one binary picked the same port
  and one test's bind-probe made another's `wake_and_wait` conclude the host
  was awake; a stress loop caught it on the 28th run. A per-call counter fixed
  that.

## Settings

- **Bell setting key.** `bellMarksTab` predates the marker moving from the tab
  to each pane's segment of the tab strip; renaming it would have reset the
  preference for anyone who changed it. `bellSound` was kept separate rather
  than folded into a three-way setting for the same reason.
- **Scrollback setting history.** A row-count setting was offered and broken
  twice (rows depend on width) before it became a memory tier. The stored field
  was renamed from `scrollback` because `{ ...defaults, ...parsed }` would have
  read `scrollback: 10000` as 10,000 MB, silently moving everyone to the largest
  tier. The 16 MB default (~10,100 rows at 80 columns) matches the previous
  10,000-row default.
- **Font stack migrations.** The migration table used to index `FONT_STACKS` by
  position, which silently remapped every migration when an entry was inserted
  above it; it now looks up by label. Cascadia Code was dropped and re-added
  once ligatures were supported.
- **Unfocused fade range** was reduced from 0-60 to 0-10 once the unfocused
  window also took the strip's color.
- **`clampSetting` used `Number()`**, which reads null, '' and [] as zero, so
  such blobs came back clamped to the range minimum instead of the default.
- **Unfocused fade math.** Two earlier versions got one area wrong: scaling
  every layer by the dim faded the tab strip plainly while a connected terminal
  barely moved; solving for the terminal amplified the strip (at 90% opacity a
  5% dim took it from 90% to 63%). Before the padding frame, the padding,
  active tab and blank panes were different stack depths: identical while
  nearly opaque, three grays once faded.

- **Invalid-field border.** Appending an amber border class to a field that
  already carried the white one shipped marking nothing: Tailwind resolves
  conflicting utilities by stylesheet order, not class order.
- **Range track.** `accent-color` used to paint the slider fill; painting the
  track ourselves to theme it gave that up, so the fill is computed in
  `RangeInput`.
- **Settings as a dialog.** Settings was once a dropdown: at a dozen-plus
  controls it was a single ~250px column where every explanation wrapped to
  three lines.

## App shell, dialogs and windowing

- **Cursor off after tab switch.** `refit()` used `setTimeout(0)`, which on
  WebView2 could fire before the newly visible container's layout settled
  (WebKitGTK scheduled differently), leaving the cursor a few columns off until
  the next redraw. It now uses a double `requestAnimationFrame`.
- **Tabs reducer.** `tabs` and `activeTabId` were two separately updated
  `useState` hooks; moving the tree surgery into one reducer fixed a class of
  cross-hook staleness and made every operation testable without React.
- **Refit effect.** A `refit()` call used to be appended by hand to every
  function that changed the layout; it was easy to forget, which is also how
  the eight pane-runtime tables leaked. A layout-keyed effect replaced it.
- **Pane runtime reducer.** Eight separately managed per-pane records became one
  reducer. Its views were unmemoized for a while, rebuilding eight records per
  render and defeating `React.memo` on TabBar, StatusBar and Pane.
- **Modal state.** The palette, close confirmations, restore prompt and
  workspace prompt were five independent pieces of state that could be true at
  once. The restore decision also moved from a post-mount effect to a lazy
  initializer, removing `restoreDecided` as stored state.
- **Restore prompt flicker.** Before profiles loaded, an empty list made every
  pane look vault-bound, briefly showing the password form before switching to
  plain Restore buttons; the prompt now waits for the first load.
- **Window flashed at the wrong size.** window-state restores geometry after
  the window is created, so a visible-by-default window appeared at 800x600
  first. The window now starts hidden and is shown after the first paint.
- **Close button did nothing.** Registering `onCloseRequested` makes the JS API
  close via `destroy()`, which needs `core:window:allow-destroy`; without it
  the close button silently failed.
- **Closed split tabs leaked runtime state** for every pane except the one or
  two that cleaned up after themselves; closing now dispatches per leaf.
- **Reconnect after sleep.** Sleep dropped every link and the vault's idle timer
  locked it; Reconnect on a profile pane then failed on "vault is locked"
  repeatedly with no hint. Reconnect is now vault-gated.
- **Workspaces with a locked vault.** Panes used to mount with their source
  intact, so every tab came up "vault is locked" with no way forward.

- **Unfocused fade invisible under Mica.** Thinning the background only revealed
  what was behind the window; under Mica that is a flat gray about as dark as
  Tokyo Night, so the fade was invisible and the strip, losing its wash, went
  darker. Unfocused surfaces now also take the strip's color.
- **Tab strip hairline.** With rounded tab tops, a line under the active tab cut
  it off from its terminal. It couldn't be erased only under that tab (every
  fill is translucent, and segmenting left 2px breaks), so it was dropped.
- **Strip wash.** A hardcoded `bg-black/20` had nowhere to go on Campbell,
  leaving strip and tabs the same color. And while faded, the translucent
  active tab let the wash through and looked lighter than its terminal; no tab
  opacity can hide added light, so the wash is dropped while faded.
- **Drag handle shrank away.** The drag-region spacer used to shrink to nothing
  as tabs were added; it now has a minimum width.
- **Forwards panel closed immediately.** Its click-away treated the toolbar
  button's click as outside, so it closed on the click that opened it.
- **Connect dialog Backspace setting ignored.** `paneOptions` was dropped, so
  only panes restored from a saved profile honored it.
- **Pane focus broken for connected panes.** Portals bubble events by the React
  tree, so PaneLeafView's focus handlers never fired for clicks in a connected
  terminal; "move to new tab" acted on a stale `activePaneId`.
- **Auto-close disabled auto-reconnect.** Auto-close used to fire on `lost`
  too, which removed the session id and stopped the reconnect run, quietly
  disabling auto-reconnect for everyone (both are on by default). Going through
  the guarded `closePane` also asked for confirmation on a session the user had
  just exited, using stale status that still read "connected".

- **Instruments and harness shipped in installers.** The measurement
  instruments were statically imported, putting ~1,000 lines and a hotkey
  that floods a live pane into every installer's entry chunk. The benchmark
  harness was dynamically imported, which kept it out of the app chunk but
  still emitted it into `dist/`: 564 kB of JS plus 4 kB of CSS with all four
  xterm packages, reachable in release by pressing Ctrl+Alt+B. Both are now
  behind build flags.
- **`useDismissable`.** Popovers had grown inconsistent answers: SettingsDialog
  and ConfirmDialog closed on Escape, the vault and workspace menus closed on
  outside clicks but ignored Escape, and the forwarding and files panels did
  neither (both even carried `stopPropagation` against an outside-click
  handler that was never written).
- **Root save that never prompted.** A confirmation raised by the Files panel
  renders at the app root, so answering it was a click "away" that unmounted
  the panel. When the panel asked whether to save a file as root, the click
  that said yes closed it, the sudo password dialog was set on a component
  that no longer existed, and the operation waited two minutes and gave up.
  Clicks inside `[data-modal]` are now ignored.

- **Dev CSP.** Because the desktop dev build enforced no CSP at all, the
  missing `'wasm-unsafe-eval'` that stopped Ghostty's WASM from compiling was
  invisible until a production build. `vite.config.ts` now mirrors the
  production policy.
- **Tab titles showing profile ids.** `sourceLabel()` for a saved profile
  returns its UUID-like id, so a saved-profile pane's title regressed to that
  id whenever focus, split, pop-out or attach recomputed it. `leafTitle`
  prefers `initial.label`.
- **Stale restored profiles.** Workspaces and the launch snapshot store a copy
  of each profile, possibly months old, so a renamed or re-hosted profile
  came back under its old name (the tab bar was where it showed).

- **Import prompt removed.** Importing once prompted: a banner appeared on the
  connect screen when PuTTY sessions were found, putting an offer about a
  once-ever decision on the most-seen screen. It moved to a button under
  Settings > Import.
- **Window restored off screen.** Geometry saved on a larger display came
  back 1091px tall on a 1032px work area with its top at y=780, so a dialog
  in the middle landed below the screen. `keepWindowOnScreen` shrinks, then
  moves.
- **Fixed 32 KB benchmark feed.** The flood feed used fixed 32 KB writes on
  the belief that 32 KB was the largest buffer the app hands over; it was the
  smallest (the flush threshold at the time).

- **Session menu under the cursor.** The context menu once opened at the click
  point, over the sessions below its own row. A slightly missed click, or one
  meant to dismiss the menu, landed on another session: with the vault
  unlocked that connected to an unasked-for host, and with it locked the
  browser was replaced by that host's unlock prompt. Afterward the cursor
  hovered a highlighted row that wasn't the one being worked on.
- **Window drag strip.** Modal backdrops took the title bar's drag region, so
  a window restored partly off screen put the "Restore sessions?" prompt below
  the display with nothing left that could move the window.

- **`window.confirm` replaced.** Six prompts used `window.confirm`, which in
  WebView2 draws a gray box titled roughly "tauri.localhost says", reading as
  a web page popup beside the custom decorations and mica, worst on the vault
  export disclosure. `ConfirmProvider` replaced all six.
- **App version.** A build-time `define` from `tauri.conf.json` was rejected:
  it needed repeating in `vite.config.ts` and `vitest.config.ts`, an ambient
  declaration, and went missing under tools that load neither config.
- **Backspace translation.** Moved from a string replace to a byte scan when
  the engine's data channel became bytes; the string version was only safe by
  accident.

- **run-wrustty driver.** The driver once hand-rolled the WASM ABI; when the
  binary became a ghostty `main` build with a different ABI, the driver broke
  while the app was fine, having been a second implementation of the thing
  under test. It now loads through `wasmBindings.ts`. An earlier version also
  reported rows with only a foreground color (no style bits) as empty.
- **Workspace name uniqueness.** Files written before the rule existed may hold
  duplicate names; they still load.

## Miscellaneous

- **Close-on-disconnect disabled reconnect.** `closeOnDisconnect` (on by
  default) once fired on `lost`; closing the pane removes the session id,
  which stops the reconnect run, so auto-reconnect was effectively off for
  most users. No test caught it because the two features were only exercised
  apart.
- **Session menu dismissal.** Dismissal was a `window` click listener whose
  click carried on to the session underneath; both outcomes (wrong host, or
  the unlock prompt) were reproduced in the running app. The menu also had no
  keyboard dismissal at first.
- **Cursor preference bugs.** Every bug here landed in wiring that passed all
  unit tests at the time: the preference not reaching a new pane, blink gated
  on a flag nothing set, and the write skipped because the core's default was
  misremembered.
- **Probe ordering.** A single pass once reported long SGR ~10% slower on a new
  core; it was noise from a heap grown by earlier probes. A build could measure
  identically in isolation and 7% slower when another probe ran first.
- **Command history section.** Shipped in the same phase as the history store
  itself rather than after it.
- **Spanning copy while scrolled back.** Reported as coming out broken, while
  the same copy without scrolling came out whole.

- **Hello toggle queued prompts.** Enrollment blocks on a Windows Hello prompt,
  and the checkbox (controlled by state that couldn't update until it
  returned) snapped back and looked broken, inviting repeated clicks that each
  queued a prompt.
- **Vault-only exports.** A plain `.wrv` vault-only export from older builds
  isn't importable; the bundle with sessions and workspaces got its own
  extension. The file dialogs moved Rust-side, since the backend no longer
  accepts a path from the webview.
- **Known hosts were write-only.** The prompt that writes the store always
  existed, so trust could be granted but never withdrawn; a rebuilt host left
  hand-editing `known_hosts` as the only fix, which is when users learn to
  click through the warning.

- **Frozen pane after a 2026 hold.** The frame that drew a synchronized-output
  hold's captured snapshot cleared the pending-redraw flag, so the hold's
  timeout was never checked again: a program that set mode 2026 and died froze
  the pane until something else wrote. The shim tests couldn't see it because
  they ask `is_held` every frame; found in a browser.
- **OSC cancel in the core.** Before upstream `520d8f55a`, the core ran a
  canceled OSC as if it had ended normally, so `ESC ] 2 ; title CAN` still set
  the title.
- **Terminal scrollbar.** The custom scrollbar predates the Ghostty renderer:
  it replaced xterm.js's Monaco-derived scrollbar widget, which hard-disables
  arrow buttons (its source throws if `verticalHasArrows` is set). Its gutter
  was once painted opaque with the theme background because it looked a
  different shade; the real cause was one fewer background layer, and the
  opaque fill left a dark strip at any opacity below 100%.
- **Range slider track.** With `accent-color` set, Chromium kept the unfilled
  track dark regardless of `color-scheme`, leaving a black track in a cream
  dialog.
- **Surface color.** `--surface-rgb`'s default is the literal every surface
  used to hardcode.
- **Title helper collapse.** Characterization tests pinned the title pattern
  duplicated across closePaneNow, popPaneToNewTab, attachTabToPane and
  focusPane in App.tsx before Phase 4 collapsed them into one helper.
