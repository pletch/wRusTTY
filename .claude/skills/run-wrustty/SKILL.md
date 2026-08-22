---
name: run-wrustty
description: Build, run, drive and screenshot wRusTTY — the Tauri terminal app and its Ghostty/WASM engine. Use when asked to run, start, launch, smoke-test, screenshot or visually check the app, a terminal pane, the benchmark harness, or engine/renderer behaviour (colours, attributes, underline styles, cursor shapes, parsing).
---

# Running wRusTTY

A Tauri v2 + React 19 desktop terminal. **Remote only — SSH, telnet, serial; there
is no local shell.** So "launch it and type" needs both Tauri and something to
connect to, which is usually not available. Three surfaces are reachable without
either, in increasing cost:

| Surface | Needs | Use it for |
| --- | --- | --- |
| `driver.mts` | node only | engine + core behaviour. **Start here.** |
| `/visual.html` | vite + a browser | what the renderer actually draws |
| `/#bench` | vite + a browser | A/B benchmark harness, both engines |
| full app | Tauri | window chrome, tab strip, dialogs — see `window.ps1` |
| full app + host | Tauri + a host | end-to-end connection work only |

Paths below are relative to the repo root.

## Prerequisites

Node 24 (verified on v24.18.0, npm 12.0.1). Nothing else for the paths above.

```bash
npm install
```

Rebuilding the WASM core additionally needs WSL and Zig 0.16.0 — see
`src/lib/ghostty/vendor/README.md`. You do **not** need it to run or change
anything in TypeScript; the built core is committed at
`src/lib/ghostty/vendor/ghostty-vt.wasm`.

## Run: the driver (agent path — start here)

Drives the real WASM core headlessly: writes bytes, reads back the grid, the
per-cell attributes and the cursor. No browser, no Tauri, no host, under a second.

```bash
npx vite-node .claude/skills/run-wrustty/driver.mts smoke
```

Run through `vite-node`, not `node`: the driver goes through the app's own
`wasmBindings.ts` rather than reaching into the `.wasm` itself. It used to
hand-roll the ABI and broke the day the binary became a ghostty `main` build,
having been a second implementation of the thing it was meant to test.

Exercises colour, bold, all five underline styles, overline, wide characters,
DECSCUSR and reset, then asserts the core agrees. Exit 1 on any mismatch. Output:

```
 1 | bold                                           bold
 2 | red 256                                        fg#ff5f5f
 3 | truecolour                                     fg#50c878
 6 | ul curly                                       ul:curly
 9 | overline                                       overline
10 | wide 世界 chars

cursor: bar, blinking at 0,11
```

Arbitrary payloads — the fastest way to answer "what does the engine do with
these bytes". `\x1b`, `\e`, `\r`, `\n`, `\t` are unescaped for you:

```bash
npx vite-node .claude/skills/run-wrustty/driver.mts grid 'hi\r\n\x1b[1;31mbold red\x1b[0m\r\n\x1b[4:3mcurly\x1b[0m\r\n\x1b[3 q'
```

```
 0 | hi
 1 | bold red                                       bold fg#cc6666
 2 | curly                                          ul:curly

cursor: underline, blinking at 0,3
```

## Run: the browser surfaces

```bash
npx vite-node .claude/skills/run-wrustty/driver.mts serve
```

Starts vite on <http://localhost:1420> and stays in the foreground. Then:

- **<http://localhost:1420/visual.html>** — a pane showing every underline style,
  overline, and the cursor shapes. **Press 1..6** to reissue each DECSCUSR
  (1 blink block, 2 steady block, 3 blink underline, 4 steady underline,
  5 blink bar, 6 steady bar). This is the only way to check what is *drawn*
  rather than what is set: the test suite asserts the bits per cell and cannot
  tell a curly underline from a straight one.
- **<http://localhost:1420/#bench>** — the benchmark harness, both engines side
  by side. Renders the feature-parity ledger too.

Click into the pane before judging the cursor: an unfocused pane deliberately
draws a hollow outline instead of the real shape.

## Run: the full app

```bash
npm run tauri dev
```

Opens the desktop window. A *terminal* needs a host, so connection and PTY work
still needs one — but the window itself does not, and the tab strip, the title
bar, Settings and the other dialogs are all reachable with nothing connected.
Everything below the chrome is faster through the driver.

The first build is cold Rust and takes minutes; background it and wait on the
window rather than on the log, which npm buffers and which can stay empty the
whole time.

### Driving it (agent path)

`window.ps1` does mouse input and screenshots against the real window. Run it
from the repo root; `-X`/`-Y` are **window-relative**, so they match what you
measure off a screenshot it just took.

```powershell
$w = '.claude/skills/run-wrustty/window.ps1'
& $w -Action wait                     # block until the window has painted
& $w -Action focus
& $w -Action shot -Out shot.png       # then Read shot.png to see it
& $w -Action click -X 1005 -Y 21      # the Settings gear, at the default size
& $w -Action dblclick -X 335 -Y 21    # a real double-click, not a DOM event
& $w -Action rect                     # JSON: bounds, and Maximized
& $w -Action restore                  # un-maximize between trials
```

**Use it rather than dispatching DOM events when the behaviour under test is
Tauri's.** Tauri injects its own listeners — the drag-region script maximizes
the window from a raw `mousedown` with `e.detail === 2` — and `detail` is a
platform click counter. A `new MouseEvent('mousedown', {detail: 2})` carries
whatever you put in the init dict and proves nothing about what Windows counts
as a double-click.

`rect`'s `Maximized` is the cheapest assertion available for window-state work:
snapshot it before the gesture and after.

## Test and check

```bash
npx vitest run     # 923 tests
npx tsc -b
npm run lint
npm run build      # emits dist/index.html only; visual.html is dev-only
```

`src/bench/gridSnapshot.test.ts` is the real gate — it feeds identical bytes
through Ghostty and xterm.js headlessly and compares glyphs, colours, attributes
and cursor per cell.

## Gotchas

- **Never benchmark with DevTools open.** An attached debugger drops V8's WASM to
  Liftoff — measured ~2.75x slower. An entire investigation was wasted on this.
- **`#bench` bypasses `<App />` entirely.** `main.tsx` branches on the URL hash
  before rendering, so the harness runs with no Tauri. The app proper imports
  `@tauri-apps/api/window` and will not boot in a plain browser.
- **The harness resets its panes between trials** (RIS). A payload written to be
  looked at is gone by the time a run settles — that is what `/visual.html` is
  for. Don't add a "visual" workload to the harness; it was tried and removed.
- **Don't trust HMR when verifying a fix in the window.** A change to a hook or
  a document-level listener can hot-apply as a no-op and leave the old listener
  installed, so the bug still reproduces and the fix looks wrong. This cost a
  wrong conclusion once: kill the app and relaunch before believing a negative
  result. HMR is fine for iterating, not for the verdict.
- **A passing DOM-level test does not mean the window behaves.** The
  drag-region double-click fix passed a jsdom suite and still maximized the
  real window, because a second listener — React's `onDoubleClick`, on the
  `dblclick` the two presses compose rather than on the presses — was never
  modelled. When a gesture has more than one listener, prove which one fires by
  disabling them one at a time in the running app (see
  `src/hooks/useDragRegionDoubleClickGuard.ts`).
- **Port 1420 fails silently.** If something already holds it, vite dies with
  `EADDRINUSE` while `curl` still returns 200 *from the other server*. Check
  `Get-NetTCPConnection -LocalPort 1420 -State Listen` before believing a launch.
- **Shell heredocs mangle `\x1b`.** Writing files containing escape sequences via
  `python - <<'PY'` or similar silently produces raw ESC control bytes instead of
  the four-character escape. They work but are invisible in source and do not
  survive copy-paste. Use the Write/Edit tools, or build the escape from
  `chr(92)`. This has bitten three separate files here.
- **`scrollbackLimit` is a byte budget, not a line count.** It reaches upstream
  `PageList` as `max_size`. A row-shaped value sits under the core's ~530 KB
  minimum page, so every setting collapses to the same ~1100-row floor at 80
  columns and the scrollback setting silently does nothing. **Zero means
  unlimited.** Always go through `scrollbackBudgetBytesFor`, which maps the
  user-facing memory tier (8/16/32/64 MB of *total pane footprint*) to a
  measured budget. Depth in rows is derived for display only.
- **A wide glyph occupies two cells**; the trailing one is a spacer with
  `width === 0` and no codepoint. Treating it as a blank is what made CJK overlap.
- **Writes before the core loads are buffered**, so `engine.write()` is safe
  immediately — but the core's state is not readable until `termPtr` is set.

## Rebuilding the WASM core

Only if you are moving to a different ghostty commit. The engine runs on ghostty
`main` at the pin in `docs/PORT_GHOSTTY_MAIN.md`, plus one carried fix; the
recipe, the DWARF strip and the things that must be re-measured afterwards are
in `src/lib/ghostty/vendor/README.md`. In WSL, under `~` rather than `/mnt/c`:

```bash
mkdir ghostty-pin && cd ghostty-pin && git init -q .
git config core.autocrlf false          # or the patch will not apply
git remote add origin https://github.com/ghostty-org/ghostty.git
git fetch -q --depth 1 origin 5851d98615187d85052e41042bcf66e0ccec11d4
git checkout -q FETCH_HEAD
git apply ../patches/ghostty-main-esc-k.patch
zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
```

Traps, all hit for real: this WSL image has no `xz`, `python3` or `zstd`, so the
Zig tarball has to be unpacked from the Windows side — and files written over the
9p bridge lose the exec bit, so `chmod +x zig` afterwards. Building natively on
Windows hits a Zig `ftruncate`/`FileTooBig` bug in the unicode table generator.
`main` wants Zig **0.16.0**; the old v1.3.1 build wanted 0.15.2 — they are not
interchangeable. `src/lib/ghostty/vendor-131/` still holds that older build,
which is the comparison oracle the port's parity suites read and is not shipped.

**A rebuild is supposed to fail `vendorIntegrity.test.ts`** — update
`GHOSTTY_PIN` in `src/lib/ghostty/vendorPin.ts` and the block in
`vendor/README.md` in the same commit as the binary. The pin is one constant
because Settings' About section displays it too; the test asserts the binary,
the pin and the README all still agree.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `curl` says 200 but your vite died | Something else owns 1420. Kill it (see Gotchas) and relaunch. |
| Harness stuck on "Booting engines… warming up…" | A run is in progress and the renderer is busy; screenshots time out. Wait ~10 s and retry. |
| Cursor draws as a hollow box, not a bar | The pane is unfocused. Click into it. |
| Blinking cursor shape looks absent in a screenshot | You caught the off phase. Use the steady variant (2, 4, 6). |
| `window.ps1` says the window is not found | The app isn't up yet (`-Action wait` first), or it crashed. Note it keys off the *process*, not the window title, which changes with the active tab. |
| A gesture through `window.ps1` does nothing | The window wasn't focused — `-Action focus` first. Co-ordinates are window-relative, and they move when the window is maximized, so re-`shot` after any state change. |
| `driver.mts` throws `createTerminal returned 0` | The vendored `.wasm` is missing or truncated — check `src/lib/ghostty/vendor/`. |
| `ex.ghostty_… is not a function` anywhere | Something is talking to the binary directly instead of through `wasmBindings.ts`. The shipped build speaks ghostty `main`'s ABI; `main/shim.ts` is what makes it look like ours. |
| Zig build: `error: no field named 'prompt_start'` | You are building against the wrong Ghostty version. The patch targets v1.3.1. |
