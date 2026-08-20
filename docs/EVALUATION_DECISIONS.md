# Evaluation decisions — post-refactor review

Outcomes for the review items in `EVALUATION_PLAN.md` (Tracks A, B and C;
Track D — features — was explicitly out of scope for this pass).

The `why` matters more than the outcome. An item evaluated and rejected is a
finished item, and this is what stops it being re-litigated.

| ID | Evidence | Decision | Why |
|---|---|---|---|
| A1 | 8 fresh `Record`s per App render; reducer already returns identity-stable state on no-op actions | **Done** (option 1) | `useMemo` on `[paneRuntime]`, 8 lines. Not on the throughput path — terminal output bypasses React — but it is the precondition for `React.memo` on TabBar/StatusBar/Pane ever being measurable. Option 2 (pass `paneRuntime` whole, delete the eight `*Of()`) deliberately **not** taken: it touches 4 components to remove a shim that now costs nothing per render. Revisit only alongside actually adding `React.memo`. |
| A2 | Mutation-tested three ways: wrong palette index → 7 failures, dropped `inverse` → 1, perturbed default colour → 11 | **Done** — extended, not narrowed | Per C1: you cannot delete the user-facing engine on the strength of an oracle that only compares text. `GridSnapshot` now carries per-cell `fg`/`bg`/`flags`. **It passed first time** — contrary to the plan's expectation — so the mutation testing above is what establishes the assertions aren't vacuous. Both engines are pinned to one palette (`gridPalette.ts`) because neither side's native colour representation is convertible to the other's after the fact. |
| A3 | Union was declared inside App's component body, unreachable from any test file | **Done** | Type, dispatcher and the one real decision (`profileConnectionSource`) moved to `state/vaultGate.ts`; effects injected as `VaultGateEffects`, so App keeps the reducer/modal calls. 7 tests now cover the routing, including the vault-query-rejects case. Phase 5's "a fourth gated action is a new union member" is now a checkable claim. |
| A4 | `allLeaves(t.root)` re-walked inside a `.find` callback | **Done** (bundled with A5) | Bounded by `MAX_PANES_PER_TAB = 8`, so invisible in practice — fixed only because A5 put us in adjacent code, exactly as the plan directed. Pre-split ids now walked once into a `Set`. Legibility more than speed. |
| A5 | Prune `useEffect` had no dep array | **Done** — `[liveLeafIds.join(',')]` | The plan flagged this as defensibly "leave alone" given the risk of pruning a container from under a live pane. Taken because the risk is one-directional: the effect only ever *removes* containers whose pane is no longer live, so running too often does nothing and running too rarely defers a cleanup. The dangerous case is a *stale* live set, which a value dep cannot produce. A reference dep would have changed nothing — the caller rebuilds the array every render. |
| B0 | No recorded numbers existed to regress against | **Harness prepared, measurement not run — and no longer a blocker; see postscript** | Added a **pinned grid selector** (fit / 80×24 / 200×60) to the harness and recorded the grid mode in the Markdown export, plus `docs/bench/README.md` with the full protocol and the 5%/p99 noise gate. The plan's 200×60 requirement needed more than a workload variant: workloads are built at the engine's own `cols`/`rows`, so the engines themselves had to be resizable, or a "200×60" run would still have rendered at whatever the window fit. **The measurement runs themselves are yours** — they need your machine, your GPU, mains power and an untouched window. |
| B1 | Not profiled — see B0 | **B1a done; B1b rejected, now permanently — see postscript** | `parseCellInto(view, offset, out)` with one renderer-owned scratch cell, plus the same in `GhosttyEngine.readRows` (a scrollback-wide search walks hundreds of thousands of cells). Shipped without the profile the plan asks for because B1a is strictly fewer allocations with no readability cost and no behaviour change — there is no version of the evidence that argues against it. **B1b (inline typed-array reads) is rejected until B1a is measured and lands short of target**, per the plan's own rule; it trades real legibility for an unmeasured gain. |
| B2 | The asymmetry with `lineBuffer`/`graphemeBuffer` beside it — both already cache and realloc only on size change | **Done** | Now `viewportBuffer(wasm, cells)`, mirroring `lineBuffer`'s shape exactly; freed in `dispose`. Was a malloc + zero-fill + free of 30 KB (80×24) to 192 KB (200×60) every frame, per pane. **The `.fill(0)` was kept, and the plan's own reasoning is why**: PR #142 zero-initialises WASM *page* buffers, and a cached buffer is reused — precisely the case #142 does not cover. A memset is far cheaper than the malloc it replaces. |
| B3 | **`ghostty_render_state_is_row_dirty(term, y)` is already in the vendored ABI** (`wasmBindings.ts:71`) and is never called | **Deferred at the time; closed as rejected since — see postscript** | The plan expected this to be the item's killer ("if there is no per-row damage query, this item is dead"). It isn't: precondition (a) is satisfied with no new WASM build. Precondition (b) — that B1+B2 left you short of target — is unevaluated because B0 hasn't been run. So this is deferred on *missing evidence*, not on missing capability, which is a materially better position than the plan assumed. Still the most invasive change on the list and the most likely to produce a machine-specific visual artefact. |
| B4 | Not measured — needs the 3×2 matrix (`FLUSH_INTERVAL` 8/16/24 ms × typing/flood) | **Deferred, unchanged at 8 ms** | This is a tradeoff, not a bug, and the plan is explicit that it is what the `latency` and `throughput` workloads exist to settle. Changing the constant on reasoning alone would trade a known-good echo latency for an unmeasured throughput gain. `FLUSH_INTERVAL` is `src-tauri/src/coalesce.rs:26`; the matrix is a one-line edit and a rebuild per cell. |
| C1 | Bundle measured at HEAD vs after: app chunk **928.88 kB → 429.06 kB** (gzip 259.13 → 128.45 kB); app CSS 28.90 → 24.66 kB | **Option 2 — oracle only** | Engine picker, `paneEngineSet` reducer action, `PaneLeaf.engine`, and Terminal.tsx's branch all gone; `xtermEngine.ts` relocated to `src/bench/`. xterm.js now loads only in the lazily-split benchmark chunk (27.41 → 527.69 kB), which is where the ~500 kB came from — a payoff the plan didn't anticipate and the strongest single argument for the decision. **What it cost:** the WebGL-context-loss fallback. Judged acceptable because context loss is recoverable in-engine and a dead WASM core is not something a second renderer fixes; if that turns out to be wrong, the fix is an automatic fallback on failure, not restoring the picker. Rationale written into `parity.ts`'s header as the plan requires. Option 3 (full removal) not taken — the parity test would become a self-snapshot. |
| D1–D9 | — | **Out of scope** | Features were excluded from this pass by request. |

## Verification

`tsc -b` clean, `oxlint` clean, `vite build` clean, 278 tests passing across 16
files (up from 257/15 — the vault-gate, palette and colour/attribute parity
tests are new; the `paneEngineSet` reducer test is gone with the feature).

## Postscript (2026-08-07): the ghostty `main` port answered most of Track B

Track B was written as "measure first, then decide", with B0 as the gate. The
measurement arrived anyway — from a different project, aimed at a different
question. `tools/parse-probes/iter.mjs`, run to justify the ghostty `main` port,
recorded **a worst-case full redraw of 0.21 ms against an 8.3 ms frame**. The
port's own notes draw the conclusion in one line: *"None of the above was ever
the bottleneck; this is not a perf project."*

That number lands squarely on the viewport read path, which is where B1a, B1b,
B2 and B3 all live. So three items that were parked pending evidence now have
some, and it points the other way:

- **B3 is rejected, not deferred.** Its stated precondition was that B1a and B2
  left us short of target. There is no target being missed — the read path is
  running at ~2.5% of frame budget. B3 remains the most invasive change on the
  list and the most likely to produce a machine-specific visual artefact, and
  it would now be bought with a fraction of 0.21 ms. Note this is a *reversal*
  of the original row's optimism: the point that survives is that main can skip
  clean rows at 0.05x-0.14x of a full read, which is a real capability and
  still the obvious thing to reach for **if a bottleneck ever appears here**.
  Nothing suggests one has.
- **B1b stays rejected, and permanently rather than pending.** It traded real
  legibility for an unmeasured gain; the gain is now measured as irrelevant.
- **B1a and B2 keep their structural justification and need no number.** Both
  are strictly fewer allocations with no behaviour change and no readability
  cost. A benchmark could only have confirmed something already true by
  construction.

**What the probes do not cover**, and where the harness is still the only
instrument: they measure the wasm-side read, not `WebGLRenderer.
updateStaticGrid` or GPU presentation. The harness's p50/p99 include both. So a
baseline is not redundant — it is simply not what decides B1/B2/B3.

**B0 is therefore optional, and its remaining purpose is regression detection
rather than optimisation.** The argument for still running it got *stronger*
recently, for a reason nothing in Track B anticipated: the entire VT core was
swapped underneath (v1.3.1 → `main` at a pin, 742,403 → 1,308,136 bytes) with no
frame-level measurement on either side of it. If a baseline is ever taken, now
is the cheapest time — the core is freshly swapped and the next change has not
landed on top of it.

## What is still owed

**One open question, not four.**

1. **B4 — `FLUSH_INTERVAL`, the 3×2 matrix** (8/16/24 ms × typing/flood).
   Unchanged at 8 ms and still undecided, because it is the one Track B item a
   baseline cannot resolve: it is a latency-versus-throughput *tradeoff*, not an
   optimisation, so there is no direction that is simply better. Measurement is
   the only way to know what the trade costs. `src-tauri/src/coalesce.rs:26`;
   a one-line edit and a rebuild per cell.

**Optional, and no longer gating anything:**

2. **B0 — the committed baseline**, for regression detection only, per the
   postscript above. `docs/bench/README.md` has the protocol; it needs your
   machine, mains power and roughly an untouched hour.

**Closed:** B1a and B2 (done, justified structurally), B1b and B3 (rejected).

**Footnote on B3 (2026-08-20):** the per-row dirty machinery underneath it was
fixed in `2e62b73` — `mark_clean` now clears the per-row layer as well as the
global flag, and `rowDirty` jumps with `next_dirty` rather than walking. That
does **not** reopen B3. It was done because the shim implements the query and a
wrong answer there is the shape of bug that hides itself, not because anything
is about to consume it; the renderer still redraws the whole viewport and the
0.21 ms number is unchanged. The effect on B3 is only that whoever ever does
find a bottleneck here starts from a correct query.
