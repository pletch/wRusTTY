# Moving find-in-scrollback onto the native `ghostty_search_*` API

Written 2026-09-03 as a cost-out; **built on 2026-09-04**, and this file is now
the record of what it cost rather than an estimate of it. The pin is
`492300ca`; the code is `src/lib/ghostty/NativeSearchController.ts`, its ABI is
in `main/abi.ts`, and `nativeSearch.test.ts` is the differential suite.

All six steps below are done. Two things came out differently from the estimate
and both are marked **[revised]** where they belong: the size cost of the
feature, and the performance argument, which did not survive being measured.

The shape that shipped is the hybrid this file recommended: plain
case-insensitive queries go to the core, and the regex and case-sensitive
toggles keep the JS `SearchController`. Nothing above `GhosttyEngine.search`
changed.

## What upstream shipped

`4b51f521` (#14097, 2026-08-31) extracted whole-terminal search out of
ghostty's search *thread* into a `terminal.search.TerminalSearch` struct and
put a C API on it — `src/terminal/c/search.zig` (1,009 lines) plus
`src/terminal/search/terminal.zig` (655), with `include/ghostty/vt/search.h`
(501 lines) as the contract. `06178eea` (2026-09-02) followed: a search that
had already exhausted a `PageList` now picks up history prepended afterwards by
incremental snapshot restore.

Seven exports:

    ghostty_search_new(alloc, *out, terminal)
    ghostty_search_free(search)
    ghostty_search_tick(search, ...)    bounded progress, never touches the terminal
    ghostty_search_feed(search)         reads the terminal; the only way it sees changes
    ghostty_search_run(search)          blocking feed+tick until caught up
    ghostty_search_set(search, opt, value)
    ghostty_search_get(search, data, *out) / ghostty_search_get_multi(...)

Options are `NEEDLE`, `SELECT_NEXT`, `SELECT_PREV`, `SELECT_SCROLL`. Reads are
`STATUS`, `NEEDLE`, `TOTAL_MATCHES`, `SELECTED_INDEX`, `SELECTED_MATCH`,
`MATCHES`, `VIEWPORT_MATCHES`, `SELECT_SCROLL`.

It arrives behind a new `-Dvt-features` gate named `search`, default on. Our
build passes no `-Dvt-features`, so a re-pin gets it whether or not we use it —
the same argument the 71 kB kitty clipboard batch already made, and one more
reason to settle the feature-trim question in the same pass.

## Why it is worth the work

Three separate wins, in the order they matter:

1. **Correctness we do not have.** Upstream keeps results in sync with the live
   screens: they survive a primary/alternate switch (entering and leaving `vim`
   does not restart a scrollback search), resize, reflow, reset, and scrollback
   pruning. `SearchController` has none of that — it invalidates on `bufferGen`
   and re-reads from scratch, so on a busy pane it is re-reading more or less
   constantly, and after a resize the match list is simply wrong until the next
   keystroke.

2. **The cost of the read. [revised — this was wrong]** The estimate here was
   that moving the walk into the core would make searching cheaper. Measured,
   it does not: `search.mjs` gained a `native` mode and a `gridref-match` mode
   (the JS read *plus* the JS matching, so the comparison is search against
   search), and at 200x60 with ~10,000 rows of scrollback a cold full-buffer
   search is **42.7 ms native against 21.3 ms in JS** — the core is about
   twice as slow at the one-shot pass, and 4.2x at 80x24.

   What is decisively better is every update after the first, which is what a
   live pane actually spends its time on. The JS path's answer to "the buffer
   changed" is to read and match the whole scrollback again — 21.3 ms, on
   every generation bump while the find bar is open. The core's is a feed:
   **0.69 ms at 10,000 rows, and 0.72 ms at 2,000**, so it is flat in
   scrollback depth rather than linear in it (`search.mjs`, `native-feed`).
   Thirty times cheaper, and it does not get worse as the pane fills up.

   The cold pass is also *sliced*: `NativeSearchController` ticks with a
   millisecond budget and gives the frame back, so 42 ms of work costs no
   dropped frame, where the JS path's 21 ms is one synchronous stall on the
   keystroke that caused it. So the honest summary is: not faster, but paid in
   instalments and then nearly free — and `VIEWPORT_MATCHES` means the
   highlight list is computed by the core during those feeds rather than
   rebuilt here.

3. **Less of ours to own.** `SearchController.ts` is 216 lines and leans on
   `logicalLines.ts` and `rowText.ts` to reassemble wrapped lines, because a
   match straddling a wrap is one hit and several highlights. Upstream returns
   each match as a `GhosttySelection` and that problem stops being ours.

## The blocker: we would lose regex and case-sensitive

This was the whole of the difficulty, and it is what decided the shape of what
shipped.

`search.h` is explicit: *"Matching is byte-exact except ASCII letters, which
compare case-insensitively."* There is no regex, and no way to ask for a
case-*sensitive* match.

Our find bar has both as live toggles. `Terminal.tsx:686` passes
`caseSensitive` and `regex` on every call, from `searchCaseSensitive` and
`searchRegex` state, and `SearchController.search` honours them
(`SearchController.ts:93-94`): non-regex queries are escaped and fed to the
same `RegExp`, flags `g` plus `i` unless case-sensitive.

So a straight swap is a user-facing regression on two features that are already
shipped and discoverable.

### Recommended shape: hybrid, native by default

Route by query kind, at the `GhosttyEngine.search` boundary:

- **plain query, case-insensitive** — the default, and almost all real use —
  goes to `ghostty_search_*`.
- **regex on, or case-sensitive on** — stays on `SearchController`.

`SearchOptions` already carries both flags, so the routing predicate is
`!options?.regex && !options?.caseSensitive` and nothing above the engine
changes. `SearchResult` (`{ index, count }`) is what the find bar renders and
both paths can produce it: `SELECTED_INDEX` + `TOTAL_MATCHES` map to it
directly — noting that upstream orders matches **newest to oldest** while ours
orders oldest-first, so either the index is flipped for display or that
ordering is accepted as the new one.

The cost is two search implementations. That is real, but the JS one is not
deletable anyway while `instantiateGhosttyModule` can still land on a raw
v1.3.1 binary with no `ghostty_search_*` in it — the fallback has to exist, so
it may as well be the regex path too. If upstream later grows a regex or
case-sensitivity option, the JS path goes away in one commit.

The alternative — native only, and drop both toggles from the find bar — is
much less code and is a defensible product call, but it *is* a product call,
not a refactor. Do not make it silently as part of the port.

## What the API demands that the current code never had to think about

- **Matches are `GhosttySelection` snapshots** and *"only valid until the next
  operation that modifies the terminal, including `ghostty_terminal_vt_write()`,
  resize, reset, and free."* We write on every packet. So the read order is
  fixed: feed, read, use before the next write. Caching a match list across
  writes — exactly what `SearchController` does, keyed on `bufferGen` — is not
  available. The header's own advice is to re-read `SELECTED_MATCH` after each
  feed; the selected match is the one thing the core keeps accurate across
  terminal changes.
- **Feeding is not optional.** *"Feeding is the only way the search learns that
  the terminal changed."* A search left un-fed silently reports stale counts
  while output keeps arriving. Where the feed goes — per write, per frame,
  debounced — is a design decision with a measurable answer.
- **We are single-threaded.** The tick/feed split exists so ghostty can tick on
  a background thread and take the terminal lock only to feed. We get no
  benefit from the split except the ability to bound work per frame: tick in
  slices from the render loop rather than calling `ghostty_search_run`, which
  blocks until caught up and on a full scrollback is exactly the stall the
  split is designed to avoid. Use `run` only in tests and probes.
- **Highlights do *not* come from `VIEWPORT_MATCHES`. [revised — this shipped
  broken]** That field is relative to the **core's** viewport, and the core's
  viewport never moves here: the offset the renderer draws from is ours, and
  the search runs with `SEARCH_SCROLL_NONE` so that selecting a match does not
  fight it. So the list describes the bottom of the buffer however far the pane
  is scrolled back — which is exactly where a search leaves you, so in practice
  it highlighted nothing whenever it mattered. Caught by looking at the running
  app, not by the suite, which only ever searched with the viewport at the
  bottom.

  What works is `MATCHES`, the whole list, ordered newest to oldest and
  therefore sorted descending by row: binary-search it for the visible window
  and convert only the handful inside, since the conversion
  (`point_from_grid_ref` per endpoint) is the cost. `nativeSearch.test.ts` now
  scrolls 1,500 rows back and asserts the highlights follow.
- **New ABI surface.** `abi.ts` declares `grid_ref` but no selection APIs at
  all: `GhosttySelection`, `GhosttySelectionBuffer`,
  `ghostty_terminal_point_from_grid_ref` and the search structs are all new to
  us. None of their layouts are guessable — the same lesson `search.mjs`
  records for `GhosttyPoint`, `GhosttyGridRef` and the packed cell. Probe them
  with a `layout.mjs`-style script before writing a line of `shim.ts`.

## Work, in order — what each step turned out to be

1. **Re-pin.** Done: `492300ca`, which carries `4b51f521`, `06178eea` and
   `c2906398`. **[revised]** The size question the step asked has an answer:
   the same commit built with `-Dvt-features=-search` strips to 1,082,478
   bytes against 1,127,956 with it, so the whole feature is **45,478 bytes,
   4.0% of the binary** — small enough that trimming it was never the
   argument either way.
2. **Probe the layouts.** Done, as `tools/parse-probes/nativesearch.mjs`, and
   it turned up something the plan did not expect: the binary can simply be
   asked. `ghostty_type_json` describes `GhosttySelection` (32 bytes, start@4,
   end@16, rectangle@28), `GhosttySelectionBuffer`, `GhosttyString` and
   `GhosttyPointCoordinate` exactly, so `abi.manifest.test.ts` now asserts all
   four rather than the offsets being probed and hoped for. The probe still
   earns its place as the end-to-end check: it writes a needle at a known
   column on every tenth row of a 324-row buffer and gets all 33 back at the
   right coordinates, which is what proved the reads before any of it went
   into the engine.
3. **Extend `abi.ts`.** Done, and the plan's "and `shim.ts`" was wrong: there
   is nothing to shim these to on a v1.3.1 build, so they are declared on
   `GhosttyMainExports` and reached directly, exactly as `KeyEncoder` does.
   `NativeSearchController.create` returns null when they are absent.
4. **A `NativeSearchController`.** Done. It is not behind the `SearchHost`
   seam, which turned out to be the wrong shape — that interface is mostly
   row-reading, which is the part the core takes over. It has a host of its
   own (highlights, reveal, emit, viewport, generation, geometry) and
   `GhosttyEngine.search` routes on `!options?.regex && !options?.caseSensitive`.
5. **Re-measure with `search.mjs`.** Done, and see §2 above: the performance
   claim is retracted for the cold pass and replaced with a measured one about
   the steady state. `gridref-match`, `native` and `native-feed` are the new
   modes.
6. **Differential tests.** Done, in `nativeSearch.test.ts`: output arriving
   after the search, a resize that reflows every match onto a different row,
   scrollback eviction, and an alternate-screen round trip — each asserted on
   the native path and then asserted *wrong* on the JS one, which the regex
   toggle is used to select. Plus the pair that guards the port itself: a
   20,000-row search sliced across frames converging on exactly the count the
   JS matcher reads row by row, and the routing test that proves a
   case-sensitive query is not being silently case-folded.

## What is deliberately different from the JS path

One behaviour changed, and it is visible: **a fresh query lands on the newest
match** — the one nearest the prompt — where `SearchController` lands on the
first match at or after the top of the viewport. The core exposes only
next/prev stepping from nothing, and reproducing the old rule would mean
stepping through every match below the viewport to find it, which on a deep
scrollback is exactly the walk this port exists to avoid. So the counter opens
at n/n and Next wraps to 1/n, which is what `less` and ghostty itself do.

Direction is unchanged and worth stating because the two APIs disagree about
it: the find bar's Next is a chevron *down*, toward newer content, which is the
core's `SELECT_PREV`. `SELECT_NEXT` moves toward older content and is our Back.
