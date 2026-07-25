# Benchmark baselines

This directory holds recorded runs of the in-app benchmark harness
(`src/bench/BenchmarkHarness.tsx`). Its purpose is narrow and worth stating
plainly: **without a committed baseline, no renderer change in this repo is
falsifiable.** "It feels faster" and "p50 moved 3%" are the same statement on a
laptop.

A file here is a measurement, not a claim. It records what the machine did on
one day under stated conditions. Two files are only comparable if the protocol
below was followed for both.

## Protocol

Follow this exactly, or the diff is not a diff.

### 1. Fix the machine and the conditions

- Same machine, on mains power.
- Windows power plan on **High Performance** (`powercfg /setactive
  SCHEME_MIN`, or the Balanced/High Performance toggle in Settings).
- No other GPU load: no video playing, no other WebView2 or browser window
  doing work, no background build.
- Do not touch the window while a run is in progress. The harness says so for a
  reason — a mouse move over the WebView is enough to move p99.

Record the `gpuProbe` line the harness prints in its banner. It is included in
the exported Markdown automatically. **A result from a different adapter is a
different experiment**, not a regression or an improvement.

### 2. Pin the grid

Use the harness's **Grid** selector, not "Fit window", for anything you intend
to commit. A `fit` run depends on the window size and is not reproducible.

Take every baseline at **both** `80×24` and `200×60`. The two exist for
different reasons:

- `80×24` is the common case and the one latency claims should rest on.
- `200×60` is ~6× the cells. The per-cell work in `WebGLRenderer.
  updateStaticGrid` and the per-frame viewport buffer scale with cell count and
  nothing else, so an optimisation to either is invisible at `80×24` — you
  would be measuring a cost that isn't there yet and concluding it doesn't
  exist.

### 3. Run the matrix

For each pinned grid:

- All four workloads (`typing`, `streaming`, `tui`, `flood`) — the **Run all
  workloads** button.
- `largeFlood` at 10 / 50 / 100 MB, in the default (32 KB coalescer feed) mode.
  The monolithic-write toggle measures a case the coalescer never allows; it is
  useful for reasoning about the raw parser, but it is not the number a user
  experiences, so do not baseline against it.

Five rounds each. The harness's own `THROUGHPUT_ROUNDS` / `BLOCK_ROUNDS` are
per-invocation; run the list five times and keep all five exports rather than
averaging by hand — the spread between runs *is* the noise floor you need in
order to read the next section.

### 4. Commit it

Export with **Copy Markdown** and save as `baseline-<YYYY-MM-DD>-<grid>.md`,
e.g. `baseline-2026-07-25-200x60.md`. Commit it. The point of the file is that
it exists in history at a known commit.

### 5. Re-run identically after each change

Same protocol, same grid, same rounds. Name the file after what changed:
`b2-viewport-cache-2026-07-26-200x60.md`.

## Noise gate

**Treat a change as real only if p50 moves more than 5% *and* p99 moves in the
same direction.**

Single-run improvements under 5% are measurement noise on a laptop. Acting on
them sends you optimising things that don't matter, and — worse — makes the
next person believe a number that won't reproduce. A change that clears the
gate on one workload and not others is a real result about that workload, not a
general win; say which.

If p50 improves and p99 worsens, you have moved work rather than removed it.
That is usually an allocation being deferred rather than avoided, and it is not
an improvement.

## What is not measured here

- **Pixels.** The harness times presentation and parses; it does not compare
  what was drawn. Grid-state correctness is `src/bench/gridSnapshot.test.ts`'s
  job, and pixel output is deliberately untested (see `WebGLRenderer`'s
  header).
- **Multi-pane contention.** Every number here is one engine on one grid. Four
  panes sharing a WebGL context budget is a different question.
- **Real network latency.** The `typing` workload models local echo. Nothing
  here says anything about SSH round-trip time.
