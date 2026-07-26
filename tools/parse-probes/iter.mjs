/**
 * Closes the band left open by viewport.mjs: what a frame's cells actually cost
 * through ghostty main's row/cell iterator API, measured against a real build.
 *
 * viewport.mjs could bound the model from call-shape costs alone (3.0x-11.3x
 * today's single batched read) but not price row_cells_get itself. This drives
 * the real thing:
 *
 *   render_state_update(state, term)
 *   get(state, ROW_ITERATOR, iter)
 *   per row:   row_iterator_next(iter); row_get(iter, ROW_DATA_CELLS, cells)
 *   per cell:  row_cells_next(cells); row_cells_get(cells, key, out) x N
 *              or a single row_cells_get_multi(cells, n, keys, values, written)
 *
 * Build the wasm with Zig 0.16.0:
 *   zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
 *
 * Run: node tools/parse-probes/iter.mjs <path-to-main-ghostty-vt.wasm>
 */
import { readFileSync } from 'fs'

const WASM = process.argv[2]
if (!WASM) throw new Error('usage: iter.mjs <ghostty-vt.wasm from ghostty main>')

// GhosttyRenderStateData
const DATA_ROW_ITERATOR = 4
// GhosttyRenderStateRowData
const ROW_DATA_CELLS = 3
// GhosttyRenderStateRowCellsData
const CELL_STYLE = 2
const CELL_BG = 5
const CELL_FG = 6
const CELL_HAS_STYLING = 8
// What a renderer needs per cell to draw it.
const KEYS = [CELL_STYLE, CELL_FG, CELL_BG, CELL_HAS_STYLING]

const mod = new WebAssembly.Module(readFileSync(WASM))
const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
const ex = inst.exports
const mem = ex.memory
const enc = new TextEncoder()
const dv = () => new DataView(mem.buffer)
const ok = (r, what) => { if (r !== 0) throw new Error(`${what} failed: result ${r}`) }

/**
 * alloc_opaque gives a slot; the constructor writes the handle into it.
 *
 * Both are kept, because the API needs each in different places: iterator and
 * cells handles are advanced and freed by handle, but `get(state, ROW_ITERATOR,
 * out)` wants the *slot* — render.zig does `const it = out.* orelse ...` and
 * populates the object the slot points at. Passing the handle there returns
 * GHOSTTY_INVALID_VALUE (-2).
 */
function make(fn, what) {
  const slot = ex.ghostty_wasm_alloc_opaque()
  ok(fn(slot), what)
  return { slot, h: dv().getUint32(slot, true) }
}

function newTerminal(cols, rows, scrollback) {
  // GhosttyTerminalOptions { u16 cols; u16 rows; size_t max_scrollback; } = 8 B
  const opt = ex.ghostty_wasm_alloc_u8_array(8)
  const d = dv()
  d.setUint16(opt, cols, true)
  d.setUint16(opt + 2, rows, true)
  d.setUint32(opt + 4, scrollback, true)
  return make((slot) => ex.ghostty_terminal_new(0, slot, opt), 'terminal_new').h
}

function write(term, s) {
  const b = enc.encode(s)
  const p = ex.ghostty_wasm_alloc_u8_array(b.length)
  new Uint8Array(mem.buffer).set(b, p)
  ex.ghostty_terminal_vt_write(term, p, b.length)
  ex.ghostty_wasm_free_u8_array(p, b.length)
}

function fill(term, cols, rows) {
  let s = '\x1b[H'
  for (let r = 0; r < rows; r++) {
    s += `\x1b[38;5;${(r % 200) + 16}m`
    s += ('sample text ' + String(r).padStart(3, '0') + ' ').repeat(Math.ceil(cols / 16)).slice(0, cols)
    if (r < rows - 1) s += '\r\n'
  }
  write(term, s + '\x1b[0m')
}

function bench(fn, iters) {
  for (let i = 0; i < Math.max(3, Math.min(iters, 50)); i++) fn()
  let best = Infinity
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / iters)
  }
  return best
}

console.log(`wasm: ${WASM}`)
console.log(`exports: ${WebAssembly.Module.exports(mod).length}\n`)

const GRIDS = [[80, 24], [200, 60]]
const TODAY = { '80x24': 13.3, '200x60': 85.4 } // us/frame, measured by viewport.mjs

console.log(`${'grid'.padEnd(9)} ${'cells'.padStart(6)} ${'update'.padStart(8)} ${'iterate'.padStart(9)} ${'+4x get'.padStart(9)} ${'+get_multi'.padStart(11)} ${'today'.padStart(8)}  vs today`)

for (const [cols, rows] of GRIDS) {
  const term = newTerminal(cols, rows, 1000)
  fill(term, cols, rows)
  const state = make((slot) => ex.ghostty_render_state_new(0, slot), 'render_state_new').h
  const iter = make((slot) => ex.ghostty_render_state_row_iterator_new(0, slot), 'row_iterator_new')
  const cells = make((slot) => ex.ghostty_render_state_row_cells_new(0, slot), 'row_cells_new')

  const out = ex.ghostty_wasm_alloc_u8_array(64)
  // get_multi takes parallel arrays of keys and output pointers, allocated once.
  const keysPtr = ex.ghostty_wasm_alloc_u8_array(KEYS.length * 4)
  const valsPtr = ex.ghostty_wasm_alloc_u8_array(KEYS.length * 4)
  const writtenPtr = ex.ghostty_wasm_alloc_usize()
  {
    const d = dv()
    for (let i = 0; i < KEYS.length; i++) {
      d.setUint32(keysPtr + i * 4, KEYS[i], true)
      d.setUint32(valsPtr + i * 4, out + i * 8, true)
    }
  }

  const update = () => ok(ex.ghostty_render_state_update(state, term), 'update')

  /** mode: 0 = iterate only, 1 = 4 separate gets, 2 = one get_multi */
  const frame = (mode) => {
    update()
    ok(ex.ghostty_render_state_get(state, DATA_ROW_ITERATOR, iter.slot), 'get ROW_ITERATOR')
    let n = 0
    while (ex.ghostty_render_state_row_iterator_next(iter.h)) {
      ok(ex.ghostty_render_state_row_get(iter.h, ROW_DATA_CELLS, cells.slot), 'row_get CELLS')
      while (ex.ghostty_render_state_row_cells_next(cells.h)) {
        n++
        if (mode === 1) {
          for (const k of KEYS) ex.ghostty_render_state_row_cells_get(cells.h, k, out)
        } else if (mode === 2) {
          ex.ghostty_render_state_row_cells_get_multi(cells.h, KEYS.length, keysPtr, valsPtr, writtenPtr)
        }
      }
    }
    return n
  }

  const seen = frame(1)
  const iters = cols * rows > 5000 ? 200 : 600
  const tUpd = bench(update, 2000) / 1000
  const tIter = bench(() => frame(0), iters) / 1000
  const tGet = bench(() => frame(1), iters) / 1000
  const tMulti = bench(() => frame(2), iters) / 1000
  const key = `${cols}x${rows}`
  const today = TODAY[key]

  console.log(
    `${key.padEnd(9)} ${String(seen).padStart(6)} ${tUpd.toFixed(1).padStart(7)}u ${tIter.toFixed(1).padStart(8)}u ${tGet.toFixed(1).padStart(8)}u ${tMulti.toFixed(1).padStart(10)}u ${today.toFixed(1).padStart(7)}u  ${(tGet / today).toFixed(1)}x / ${(tMulti / today).toFixed(1)}x`,
  )

  ex.ghostty_render_state_row_cells_free(cells.h)
  ex.ghostty_render_state_row_iterator_free(iter.h)
  ex.ghostty_render_state_free(state)
  ex.ghostty_terminal_free(term)
}

console.log('\n(u = microseconds per frame; "today" = one batched get_viewport, from viewport.mjs)')
console.log(`per-cell keys fetched: ${KEYS.length} (style, fg, bg, has_styling)`)
console.log('vs today = 4x-separate-get / single-get_multi')
