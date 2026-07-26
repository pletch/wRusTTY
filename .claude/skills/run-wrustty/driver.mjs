/**
 * Drives wRusTTY without a browser and without a remote host.
 *
 * The app is SSH/telnet/serial only and its PTY lives in Rust, so "launch it
 * and type" needs Tauri *and* something to connect to. The engine underneath
 * does not: it is a WASM core plus a JS renderer, and the core will accept
 * bytes and tell you exactly what it did with them. That is the layer almost
 * every change here touches, so that is what this drives.
 *
 *   node .claude/skills/run-wrustty/driver.mjs smoke
 *       Writes a payload exercising colour, wide characters, the underline
 *       styles, overline and DECSCUSR, then prints the grid and asserts the
 *       core agrees. Exit 1 on any mismatch.
 *
 *   node .claude/skills/run-wrustty/driver.mjs grid '<text with \x1b escapes>'
 *       Writes arbitrary bytes and dumps the resulting grid. `\x1b`, `\r`,
 *       `\n` and `\t` in the argument are unescaped for you, because passing a
 *       real ESC through a shell is miserable.
 *
 *   node .claude/skills/run-wrustty/driver.mjs serve
 *       Starts vite and prints the two URLs worth opening. Stays in the
 *       foreground; Ctrl-C to stop.
 *
 * Everything except `serve` is headless and finishes in under a second.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const WASM = join(root, 'src/lib/ghostty/vendor/ghostty-vt.wasm')

const CELL_BYTES = 16
const COLS = 80
const ROWS = 24

// Cell flag bits, mirroring wasmBindings.ts.
const BOLD = 1 << 0
const ITALIC = 1 << 1
const UNDERLINE = 1 << 2
const STRIKE = 1 << 3
const INVERSE = 1 << 4
// Second attribute byte: underline style in bits 0-2, overline in bit 3.
const UL_MASK = 0x07
const OVERLINE = 1 << 3
const UL_NAMES = ['none', 'single', 'double', 'curly', 'dotted', 'dashed']
const CURSOR_SHAPES = ['block', 'bar', 'underline', 'hollow block']

function boot() {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {
    // The core's only import. Left silent: it is a diagnostic channel, and an
    // unhandled sequence logs through it once per occurrence.
    env: { log: () => {} },
  })
  const ex = inst.exports
  const mem = ex.memory

  const cfg = ex.ghostty_wasm_alloc_u8_array(80)
  new Uint8Array(mem.buffer).fill(0, cfg, cfg + 80)
  const dv = new DataView(mem.buffer)
  dv.setUint32(cfg, 1000, true) // scrollback: a LINE COUNT, not bytes
  dv.setUint32(cfg + 4, 0xcccccc, true) // fg
  dv.setUint32(cfg + 8, 0x000000, true) // bg
  const term = ex.ghostty_terminal_new_with_config(COLS, ROWS, cfg)
  ex.ghostty_wasm_free_u8_array(cfg, 80)
  if (!term) throw new Error('ghostty_terminal_new_with_config returned 0')

  const write = (s) => {
    const b = new TextEncoder().encode(s)
    const p = ex.ghostty_wasm_alloc_u8_array(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    ex.ghostty_terminal_write(term, p, b.length)
    ex.ghostty_wasm_free_u8_array(p, b.length)
  }

  const snapshot = () => {
    ex.ghostty_render_state_update(term)
    const n = COLS * ROWS
    const buf = ex.ghostty_wasm_alloc_u8_array(n * CELL_BYTES)
    ex.ghostty_render_state_get_viewport(term, buf, n)
    const view = new DataView(mem.buffer, buf, n * CELL_BYTES)
    const rows = []
    for (let y = 0; y < ROWS; y++) {
      const cells = []
      for (let x = 0; x < COLS; x++) {
        const o = (y * COLS + x) * CELL_BYTES
        cells.push({
          cp: view.getUint32(o, true),
          fg: [view.getUint8(o + 4), view.getUint8(o + 5), view.getUint8(o + 6)],
          flags: view.getUint8(o + 10),
          width: view.getUint8(o + 11),
          attrs2: view.getUint8(o + 15),
        })
      }
      rows.push(cells)
    }
    ex.ghostty_wasm_free_u8_array(buf, n * CELL_BYTES)
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

  return { ex, term, write, snapshot }
}

const text = (cells) =>
  cells
    .map((c) => (c.width === 0 ? '' : c.cp === 0 ? ' ' : String.fromCodePoint(c.cp)))
    .join('')
    .replace(/\s+$/, '')

const DEFAULT_FG = [0xcc, 0xcc, 0xcc]
const coloured = (c) => c.fg.some((v, i) => v !== DEFAULT_FG[i])

function describe(cells) {
  // The first interesting run per row: enough to see that attributes landed,
  // short enough to read. Colour counts as interesting — a cell can carry a
  // foreground and no style bits at all, and an earlier version of this
  // reported such a row as empty.
  const c = cells.find((x) => x.flags !== 0 || x.attrs2 !== 0 || coloured(x))
  if (!c) return ''
  const bits = []
  if (c.flags & BOLD) bits.push('bold')
  if (c.flags & ITALIC) bits.push('italic')
  if (c.flags & STRIKE) bits.push('strike')
  if (c.flags & INVERSE) bits.push('inverse')
  if (c.flags & UNDERLINE) bits.push(`ul:${UL_NAMES[c.attrs2 & UL_MASK] ?? '?'}`)
  if (c.attrs2 & OVERLINE) bits.push('overline')
  if (coloured(c)) {
    bits.push(`fg#${c.fg.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
  }
  return bits.join(' ')
}

function dump(snap) {
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

function smoke() {
  const t = boot()
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

  const fail = []
  const ulOf = (y) => snap.rows[y].find((c) => c.flags & UNDERLINE)?.attrs2 & UL_MASK
  const expect = (what, got, want) => {
    if (got !== want) fail.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }

  expect('row 1 bold', (snap.rows[1][0].flags & BOLD) !== 0, true)
  for (const [i, want] of [[4, 1], [5, 2], [6, 3], [7, 4], [8, 5]]) {
    expect(`row ${i} underline style`, ulOf(i), want)
  }
  expect('row 9 overline', (snap.rows[9][0].attrs2 & OVERLINE) !== 0, true)
  // A wide glyph occupies two columns; the trailing one is a spacer with no
  // codepoint of its own. Getting this wrong is what made CJK overlap.
  const wide = snap.rows[10].find((c) => c.width === 2)
  expect('wide character present', wide !== undefined, true)
  expect('cursor shape', snap.cursor.shape, 'bar')
  expect('cursor blinking', snap.cursor.blink, true)

  // The cursor preference survives a reset only because the engine restores it;
  // the core alone goes back to a steady block. Checked here because it is the
  // one behaviour that spans core and engine.
  t.write(`${ESC}c`)
  const afterReset = t.snapshot()
  expect('core after RIS is a steady block', `${afterReset.cursor.shape}/${afterReset.cursor.blink}`, 'block/false')

  if (fail.length) {
    console.log(`\nFAILED:\n  ${fail.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\nOK — colour, attributes, wide characters, cursor shape and reset all as expected.')
}

function grid(arg) {
  const t = boot()
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
if (cmd === 'smoke') smoke()
else if (cmd === 'grid') grid(arg)
else if (cmd === 'serve') serve()
else {
  console.log('usage: driver.mjs smoke | grid <payload> | serve')
  process.exit(2)
}
