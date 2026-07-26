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
| `driver.mjs` | node only | engine + core behaviour. **Start here.** |
| `/visual.html` | vite + a browser | what the renderer actually draws |
| `/#bench` | vite + a browser | A/B benchmark harness, both engines |
| full app | Tauri + a host | end-to-end connection work only |

Paths below are relative to the repo root.

## Prerequisites

Node 24 (verified on v24.18.0, npm 12.0.1). Nothing else for the paths above.

```bash
npm install
```

Rebuilding the WASM core additionally needs WSL and Zig 0.15.2 — see
`patches/README.md`. You do **not** need it to run or change anything in TypeScript;
the built core is committed at `src/lib/ghostty/vendor/ghostty-vt.wasm`.

## Run: the driver (agent path — start here)

Drives the real WASM core headlessly: writes bytes, reads back the grid, the
per-cell attributes and the cursor. No browser, no Tauri, no host, under a second.

```bash
node .claude/skills/run-wrustty/driver.mjs smoke
```

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
node .claude/skills/run-wrustty/driver.mjs grid 'hi\r\n\x1b[1;31mbold red\x1b[0m\r\n\x1b[4:3mcurly\x1b[0m\r\n\x1b[3 q'
```

```
 0 | hi
 1 | bold red                                       bold fg#cc6666
 2 | curly                                          ul:curly

cursor: underline, blinking at 0,3
```

## Run: the browser surfaces

```bash
node .claude/skills/run-wrustty/driver.mjs serve
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

## Run: the full app (human path)

```bash
npm run tauri dev
```

Opens the desktop window. Needs a host to connect to before a terminal exists,
so it is only worth it for connection, PTY or window work. Everything else is
faster through the driver.

## Test and check

```bash
npx vitest run     # 427 tests
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
- **Port 1420 fails silently.** If something already holds it, vite dies with
  `EADDRINUSE` while `curl` still returns 200 *from the other server*. Check
  `Get-NetTCPConnection -LocalPort 1420 -State Listen` before believing a launch.
- **Shell heredocs mangle `\x1b`.** Writing files containing escape sequences via
  `python - <<'PY'` or similar silently produces raw ESC control bytes instead of
  the four-character escape. They work but are invisible in source and do not
  survive copy-paste. Use the Write/Edit tools, or build the escape from
  `chr(92)`. This has bitten three separate files here.
- **`scrollbackLimit` is a line count, not bytes.** Passing a byte-shaped value
  overflows 32-bit `usize` in the core and silently means *unlimited*: a 100 MB
  flood then retained ~1.15M rows and grew the heap to ~2 GB.
- **A wide glyph occupies two cells**; the trailing one is a spacer with
  `width === 0` and no codepoint. Treating it as a blank is what made CJK overlap.
- **Writes before the core loads are buffered**, so `engine.write()` is safe
  immediately — but the core's state is not readable until `termPtr` is set.

## Rebuilding the WASM core

Only if you are changing the Zig shim. Full recipe and the rebase notes are in
`patches/README.md`. In WSL:

```bash
git clone --depth 1 --branch v1.3.1 https://github.com/ghostty-org/ghostty.git
cd ghostty
git apply ../patches/ghostty-131-wasm-api.patch
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/ghostty-vt.wasm ../src/lib/ghostty/vendor/ghostty-vt.wasm
```

Traps, all hit for real: this WSL image has no `xz`, `python3` or `zstd`, so the
Zig tarball has to be unpacked from the Windows side — and files written over the
9p bridge lose the exec bit, so `chmod +x zig` afterwards. Building natively on
Windows hits a Zig `ftruncate`/`FileTooBig` bug in the unicode table generator.
The v1.3.1 tag wants Zig **0.15.2**; ghostty `main` wants 0.16.0 — they are not
interchangeable.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `curl` says 200 but your vite died | Something else owns 1420. Kill it (see Gotchas) and relaunch. |
| Harness stuck on "Booting engines… warming up…" | A run is in progress and the renderer is busy; screenshots time out. Wait ~10 s and retry. |
| Cursor draws as a hollow box, not a bar | The pane is unfocused. Click into it. |
| Blinking cursor shape looks absent in a screenshot | You caught the off phase. Use the steady variant (2, 4, 6). |
| `driver.mjs` throws `terminal_new_with_config returned 0` | The vendored `.wasm` is missing or truncated — check `src/lib/ghostty/vendor/`. |
| Zig build: `error: no field named 'prompt_start'` | You are building against the wrong Ghostty version. The patch targets v1.3.1. |
