/**
 * Drives wRusTTY without a browser and without a remote host.
 *
 * The app is SSH/telnet/serial only and its PTY lives in Rust, so "launch it
 * and type" needs Tauri *and* something to connect to. The engine underneath
 * does not: it is a WASM core plus a JS renderer, and the core will accept
 * bytes and tell you exactly what it did with them. That is the layer almost
 * every change here touches, so that is what this drives.
 *
 *   npx vite-node .claude/skills/run-wrustty/driver.mts smoke
 *       Writes a payload exercising colour, wide characters, the underline
 *       styles, overline and DECSCUSR, then prints the grid and asserts the
 *       core agrees. Exit 1 on any mismatch.
 *
 *   npx vite-node .claude/skills/run-wrustty/driver.mts grid '<text with \x1b escapes>'
 *       Writes arbitrary bytes and dumps the resulting grid. `\x1b`, `\r`,
 *       `\n` and `\t` in the argument are unescaped for you, because passing a
 *       real ESC through a shell is miserable.
 *
 *   npx vite-node .claude/skills/run-wrustty/driver.mts serve
 *       Starts vite and prints the two URLs worth opening. Stays in the
 *       foreground; Ctrl-C to stop.
 *
 * Everything except `serve` is headless and finishes in under a second.
 *
 * It goes through `wasmBindings.ts` — the app's own loader — rather than
 * reaching into the `.wasm` itself, and is run through `vite-node` for that
 * reason. It used to hand-roll the ABI, which was fine until the binary became
 * a ghostty `main` build that speaks a different one: the driver broke while
 * the app was fine, having been a second implementation of the thing under
 * test. Now `instantiateGhosttyModule` picks the ABI, `main/shim.ts` covers the
 * difference, and this sees exactly what a pane sees.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

import {
  instantiateGhosttyWasm,
  createTerminal,
  writeString,
  allocBufferOrThrow,
  freeBuffer,
  parseCell,
  CELL_BYTES,
  CELL_BOLD,
  CELL_ITALIC,
  CELL_UNDERLINE,
  CELL_STRIKETHROUGH,
  CELL_INVERSE,
  CELL2_UNDERLINE_MASK,
  CELL2_OVERLINE,
  type GhosttyWasm,
} from '../../../src/lib/ghostty/wasmBindings'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const WASM = resolve(root, 'src/lib/ghostty/vendor/ghostty-vt.wasm')

const COLS = 80
const ROWS = 24

const UL_NAMES = ['none', 'single', 'double', 'curly', 'dotted', 'dashed']
const CURSOR_SHAPES = ['block', 'bar', 'underline', 'hollow block']

interface Cell {
  cp: number
  fg: [number, number, number]
  flags: number
  width: number
  attrs2: number
}

interface Snapshot {
  rows: Cell[][]
  cursor: { x: number; y: number; shape: string; blink: boolean }
}

async function boot() {
  const wasm: GhosttyWasm = await instantiateGhosttyWasm(
    readFileSync(WASM).buffer as ArrayBuffer,
  )
  const term = createTerminal(wasm, COLS, ROWS, {
    // A BYTE BUDGET, not lines — 0 would mean unlimited.
    scrollbackLimit: 4 * 1024 * 1024,
    fgColor: 0xcccccc,
    bgColor: 0x000000,
    cursorColor: 0,
  })
  if (!term) throw new Error('createTerminal returned 0')

  const write = (s: string) => writeString(wasm, term, s)

  const snapshot = (): Snapshot => {
    const ex = wasm.exports
    ex.ghostty_render_state_update(term)
    const n = COLS * ROWS
    const buf = allocBufferOrThrow(wasm, n * CELL_BYTES)
    new Uint8Array(ex.memory.buffer, buf, n * CELL_BYTES).fill(0)
    ex.ghostty_render_state_get_viewport(term, buf, n)
    const view = new DataView(ex.memory.buffer, buf, n * CELL_BYTES)
    const rows: Cell[][] = []
    for (let y = 0; y < ROWS; y++) {
      const cells: Cell[] = []
      for (let x = 0; x < COLS; x++) {
        const c = parseCell(view, (y * COLS + x) * CELL_BYTES)
        cells.push({
          cp: c.codepoint,
          fg: [c.fgR, c.fgG, c.fgB],
          flags: c.flags,
          width: c.width,
          attrs2: c.attrs2,
        })
      }
      rows.push(cells)
    }
    freeBuffer(wasm, buf, n * CELL_BYTES)
    return {
      rows,
      cursor: {
        x: ex.ghostty_render_state_get_cursor_x(term),
        y: ex.ghostty_render_state_get_cursor_y(term),
        shape: CURSOR_SHAPES[ex.ghostty_render_state_get_cursor_style(term)] ?? '?',
        blink: ex.ghostty_render_state_get_cursor_blinking(term) !== 0,
      },
    }
  }

  return { wasm, term, write, snapshot }
}

const text = (cells: Cell[]) =>
  cells
    .map((c) => (c.width === 0 ? '' : c.cp === 0 ? ' ' : String.fromCodePoint(c.cp)))
    .join('')
    .replace(/\s+$/, '')

const DEFAULT_FG = [0xcc, 0xcc, 0xcc]
const coloured = (c: Cell) => c.fg.some((v, i) => v !== DEFAULT_FG[i])

function describe(cells: Cell[]) {
  // The first interesting run per row: enough to see that attributes landed,
  // short enough to read. Colour counts as interesting — a cell can carry a
  // foreground and no style bits at all, and an earlier version of this
  // reported such a row as empty.
  const c = cells.find((x) => x.flags !== 0 || x.attrs2 !== 0 || coloured(x))
  if (!c) return ''
  const bits: string[] = []
  if (c.flags & CELL_BOLD) bits.push('bold')
  if (c.flags & CELL_ITALIC) bits.push('italic')
  if (c.flags & CELL_STRIKETHROUGH) bits.push('strike')
  if (c.flags & CELL_INVERSE) bits.push('inverse')
  if (c.flags & CELL_UNDERLINE) bits.push(`ul:${UL_NAMES[c.attrs2 & CELL2_UNDERLINE_MASK] ?? '?'}`)
  if (c.attrs2 & CELL2_OVERLINE) bits.push('overline')
  if (coloured(c)) {
    bits.push(`fg#${c.fg.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
  }
  return bits.join(' ')
}

function dump(snap: Snapshot) {
  for (let y = 0; y < snap.rows.length; y++) {
    const line = text(snap.rows[y])
    const attrs = describe(snap.rows[y])
    if (!line && !attrs) continue
    console.log(`${String(y).padStart(2)} | ${line.padEnd(46)} ${attrs}`)
  }
  const { x, y, shape, blink } = snap.cursor
  console.log(`\ncursor: ${shape}${blink ? ', blinking' : ', steady'} at ${x},${y}`)
}

const ESC = '\x1b'

async function smoke() {
  const t = await boot()
  const rows = [
    ['plain', ''],
    ['bold', `${ESC}[1m`],
    ['red 256', `${ESC}[38;5;203m`],
    ['truecolour', `${ESC}[38;2;80;200;120m`],
    ['ul single', `${ESC}[4:1m`],
    ['ul double', `${ESC}[4:2m`],
    ['ul curly', `${ESC}[4:3m`],
    ['ul dotted', `${ESC}[4:4m`],
    ['ul dashed', `${ESC}[4:5m`],
    ['overline', `${ESC}[53m`],
    ['wide 世界 chars', ''],
  ]
  let out = `${ESC}[H${ESC}[2J`
  for (const [label, sgr] of rows) out += `${sgr}${label}${ESC}[0m\r\n`
  out += `${ESC}[5 q` // blinking bar
  t.write(out)

  const snap = t.snapshot()
  dump(snap)

  const fail: string[] = []
  const ulOf = (y: number) =>
    (snap.rows[y].find((c) => c.flags & CELL_UNDERLINE)?.attrs2 ?? 0) & CELL2_UNDERLINE_MASK
  const expect = (what: string, got: unknown, want: unknown) => {
    if (got !== want) fail.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }

  expect('row 1 bold', (snap.rows[1][0].flags & CELL_BOLD) !== 0, true)
  for (const [i, want] of [[4, 1], [5, 2], [6, 3], [7, 4], [8, 5]]) {
    expect(`row ${i} underline style`, ulOf(i), want)
  }
  expect('row 9 overline', (snap.rows[9][0].attrs2 & CELL2_OVERLINE) !== 0, true)
  // A wide glyph occupies two columns; the trailing one is a spacer with no
  // codepoint of its own. Getting this wrong is what made CJK overlap.
  const wide = snap.rows[10].find((c) => c.width === 2)
  expect('wide character present', wide !== undefined, true)
  expect('cursor shape', snap.cursor.shape, 'bar')
  expect('cursor blinking', snap.cursor.blink, true)

  // RIS returns the cursor to the terminal's *default*, and this terminal was
  // made without one, so that is the core's own steady block. A pane passes a
  // cursor style in its config and gets that back instead — which is what
  // replaced the host reapplying DECSCUSR after every reset.
  t.write(`${ESC}c`)
  const afterReset = t.snapshot()
  expect('core after RIS is a steady block', `${afterReset.cursor.shape}/${afterReset.cursor.blink}`, 'block/false')

  if (fail.length) {
    console.log(`\nFAILED:\n  ${fail.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\nOK — colour, attributes, wide characters, cursor shape and reset all as expected.')
}

async function grid(arg: string | undefined) {
  const t = await boot()
  const payload = (arg ?? '')
    .replace(/\\x1b/g, '\x1b')
    .replace(/\\e/g, '\x1b')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
  t.write(payload)
  dump(t.snapshot())
}

function serve() {
  console.log('vite on http://localhost:1420')
  console.log('  /#bench      benchmark harness — both engines, no Tauri, no connection needed')
  console.log('  /visual.html attributes and cursor shapes, for looking at (press 1..6)')
  console.log('the app itself needs `npm run tauri dev` and something to connect to.\n')
  const p = spawn('npm', ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: true })
  p.on('exit', (c) => process.exit(c ?? 0))
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'smoke') await smoke()
else if (cmd === 'grid') await grid(arg)
else if (cmd === 'serve') serve()
else {
  console.log('usage: vite-node driver.mts smoke | grid <payload> | serve')
  process.exit(2)
}
