/**
 * What a frame's cells cost through ghostty main's row/cell iterator API,
 * measured against a real build (viewport.mjs only bounded it from call
 * shapes):
 *
 *   render_state_update(state, term)
 *   get(state, ROW_ITERATOR, iter)
 *   per row:   row_iterator_next(iter); row_get(iter, ROW_DATA_CELLS, cells)
 *   per cell:  row_cells_next(cells); row_cells_get(cells, key, out) x N
 *              or a single row_cells_get_multi(cells, n, keys, values, written)
 *
 * Also prices the RAW paths (one packed u64 per cell via ROW_CELLS_DATA_RAW,
 * or a whole row via ROW_DATA_CELLS_RAW, unpacked in JS), and skipping clean
 * rows: `render_state_update` rebuilds only dirty rows, while the batched
 * `get_viewport` always reads the whole viewport.
 *
 * ## Methodology
 *
 * **One mode per process.** A shared `frame(mode)` goes megamorphic and moves
 * 2x between runs, so each mode runs in a fresh child and the parent formats
 * the table (as with probe.mjs).
 *
 * **The baseline is measured.** `today` runs the vendored 1.3.1 binary in its
 * own child, so machine or Node changes move both sides.
 *
 * Build the wasm with Zig 0.17.0:
 *   zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=fast
 *
 * Run: node tools/parse-probes/iter.mjs <main-ghostty-vt.wasm> [vendored.wasm]
 */
import { readFileSync } from 'fs'
import { withAllocCompat } from './allocCompat.mjs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const WASM = process.argv[2]
if (!WASM) throw new Error('usage: iter.mjs <ghostty-vt.wasm from ghostty main> [vendored.wasm]')
// The v1.3.1 build: "today" is the batched `get_viewport` only its ABI has.
// A missing-export error means the wrong binary, not a broken probe.
const VENDORED = process.argv[3] ?? 'src/lib/ghostty/vendor-131/ghostty-vt.wasm'
/** Set by the parent when it spawns a child to measure exactly one mode. */
const ONLY = process.argv[4] ?? null

// GhosttyRenderStateData
const DATA_ROW_ITERATOR = 4
// GhosttyRenderStateRowData / GhosttyRenderStateRowOption
const ROW_DATA_DIRTY = 1
const ROW_DATA_CELLS = 3
/**
 * `GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW`: writes a
 * `GhosttyCellsView { const GhosttyCell *ptr; size_t len; }` (two u32s on
 * wasm32), a borrowed run of the row's packed u64 cells. One call per row;
 * invalid after the next `render_state_update`.
 */
const ROW_DATA_CELLS_RAW = 5
const CELLS_VIEW_OFF_PTR = 0
const CELLS_VIEW_OFF_LEN = 4
const ROW_OPTION_DIRTY = 0
// GhosttyRenderStateRowCellsData
const CELL_RAW = 1
const CELL_STYLE = 2
const CELL_BG = 5
const CELL_FG = 6
const CELL_HAS_STYLING = 8
// What a renderer needs per cell to draw it, the way the old probe asked for it.
const KEYS = [CELL_STYLE, CELL_FG, CELL_BG, CELL_HAS_STYLING]
// The same through RAW: one packed cell plus the two resolved colors, which
// the vendored ABI also resolves, for a fair comparison.
const RAW_KEYS = [CELL_RAW, CELL_FG, CELL_BG]

const CELL_BYTES = 16 // vendored packed cell, matching wasmBindings.ts
const enc = new TextEncoder()

const GRIDS = [
  [80, 24],
  [200, 60],
]

const bench = (fn, iters) => {
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

/**
 * A screenful of text, styled by default. WORKLOAD=plain leaves cells on the
 * default style, like most of a real screen.
 */
const PLAIN = process.env.WORKLOAD === 'plain'
function screenful(cols, rows) {
  let s = '\x1b[H'
  for (let r = 0; r < rows; r++) {
    if (!PLAIN) s += `\x1b[38;5;${(r % 200) + 16}m`
    s += ('sample text ' + String(r).padStart(3, '0') + ' ').repeat(Math.ceil(cols / 16)).slice(0, cols)
    if (r < rows - 1) s += '\r\n'
  }
  return s + '\x1b[0m'
}

const editRow = (rows) => `\x1b[${(rows >> 1) + 1};1Hchanged line, redraw me`

// ---- the vendored build: one batched call -----------------------------------

/** modes: `today` (full frame) and `today-steady` (one row edited, full re-read) */
function measureVendored(mode) {
  const mod = new WebAssembly.Module(readFileSync(VENDORED))
  const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
  const ex = withAllocCompat(inst.exports)
  const mem = ex.memory

  const write = (term, s) => {
    const b = enc.encode(s)
    const p = ex.ghostty_wasm_alloc_u8_array(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    ex.ghostty_terminal_write(term, p, b.length)
    ex.ghostty_wasm_free_u8_array(p, b.length)
  }

  const out = {}
  for (const [cols, rows] of GRIDS) {
    const cfg = ex.ghostty_wasm_alloc_u8_array(80)
    const d = new DataView(mem.buffer)
    d.setUint32(cfg, 1000, true)
    for (let i = 4; i < 80; i += 4) d.setUint32(cfg + i, 0, true)
    const term = ex.ghostty_terminal_new_with_config(cols, rows, cfg)
    ex.ghostty_wasm_free_u8_array(cfg, 80)
    write(term, screenful(cols, rows))

    const cells = cols * rows
    const buf = ex.ghostty_wasm_alloc_u8_array(cells * CELL_BYTES)
    // One frame: update, one batched read, then the renderer's JS walk.
    const full = () => {
      ex.ghostty_render_state_update(term)
      ex.ghostty_render_state_get_viewport(term, buf, cells)
      const v = new DataView(mem.buffer, buf, cells * CELL_BYTES)
      let acc = 0
      for (let i = 0; i < cells; i++) acc += v.getUint32(i * CELL_BYTES, true)
      return acc
    }
    const steady = () => {
      write(term, editRow(rows))
      return full()
    }
    const fn = mode === 'today-steady' ? steady : full
    out[`${cols}x${rows}`] = { us: bench(fn, 2000) / 1000, cells }
    ex.ghostty_wasm_free_u8_array(buf, cells * CELL_BYTES)
    ex.ghostty_terminal_free(term)
  }
  return out
}

// ---- ghostty main: the iterator API -----------------------------------------

function measureMain(mode) {
  const mod = new WebAssembly.Module(readFileSync(WASM))
  const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
  const ex = withAllocCompat(inst.exports)
  const mem = ex.memory
  /**
   * One DataView, refreshed only when memory growth detaches it; a view per
   * cell costs more than the call it reads.
   */
  let view = new DataView(mem.buffer)
  const dv = () => {
    if (view.buffer !== mem.buffer) view = new DataView(mem.buffer)
    return view
  }
  const ok = (r, what) => {
    if (r !== 0) throw new Error(`${what} failed: result ${r}`)
  }

  /**
   * alloc_opaque gives a slot; the constructor writes the handle into it. Both
   * are kept: iterators are advanced and freed by handle, but
   * `get(state, ROW_ITERATOR, out)` wants the slot (passing the handle returns
   * GHOSTTY_INVALID_VALUE).
   */
  const make = (fn, what) => {
    const slot = ex.ghostty_wasm_alloc_opaque()
    ok(fn(slot), what)
    return { slot, h: dv().getUint32(slot, true) }
  }

  const write = (term, s) => {
    const b = enc.encode(s)
    const p = ex.ghostty_wasm_alloc_u8_array(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    ex.ghostty_terminal_vt_write(term, p, b.length)
    ex.ghostty_wasm_free_u8_array(p, b.length)
  }

  const out = {}
  for (const [cols, rows] of GRIDS) {
    /**
     * Cols and rows are plain arguments; scrollback is a `terminal_set` option,
     * left at default since the probe never scrolls.
     */
    const term = make((slot) => ex.ghostty_terminal_new(0, slot, cols, rows), 'terminal_new').h
    write(term, screenful(cols, rows))
    const state = make((slot) => ex.ghostty_render_state_new(0, slot), 'render_state_new').h
    const iter = make((slot) => ex.ghostty_render_state_row_iterator_new(0, slot), 'row_iterator_new')
    const cells = make((slot) => ex.ghostty_render_state_row_cells_new(0, slot), 'row_cells_new')

    const cellOut = ex.ghostty_wasm_alloc_u8_array(64)
    // get_multi takes parallel arrays of keys and output pointers, allocated once.
    const arrays = (keys) => {
      const keysPtr = ex.ghostty_wasm_alloc_u8_array(keys.length * 4)
      const valsPtr = ex.ghostty_wasm_alloc_u8_array(keys.length * 4)
      const d = dv()
      for (let i = 0; i < keys.length; i++) {
        d.setUint32(keysPtr + i * 4, keys[i], true)
        d.setUint32(valsPtr + i * 4, cellOut + i * 8, true)
      }
      return { keysPtr, valsPtr, n: keys.length }
    }
    const four = arrays(KEYS)
    const raw3 = arrays(RAW_KEYS)
    const fgbg = arrays([CELL_FG, CELL_BG])
    const writtenPtr = ex.ghostty_wasm_alloc_usize()
    const falsePtr = ex.ghostty_wasm_alloc_u8_array(4)
    dv().setUint32(falsePtr, 0, true)

    let touched = 0
    /**
     * Per-cell work, one function per mode so no call site is polymorphic. `acc`
     * is returned so the JS unpack can't be optimized away.
     */
    const cellFns = {
      iterate: () => 0,
      get4: () => {
        for (const k of KEYS) ex.ghostty_render_state_row_cells_get(cells.h, k, cellOut)
        return 0
      },
      multi4: () => {
        ex.ghostty_render_state_row_cells_get_multi(cells.h, four.n, four.keysPtr, four.valsPtr, writtenPtr)
        return 0
      },
      raw: () => {
        ex.ghostty_render_state_row_cells_get(cells.h, CELL_RAW, cellOut)
        return view.getUint32(cellOut, true)
      },
      raw3: () => {
        ex.ghostty_render_state_row_cells_get_multi(cells.h, raw3.n, raw3.keysPtr, raw3.valsPtr, writtenPtr)
        return view.getUint32(cellOut, true)
      },
      rawStyled: () => {
        ex.ghostty_render_state_row_cells_get(cells.h, CELL_RAW, cellOut)
        const lo = view.getUint32(cellOut, true)
        const hi = view.getUint32(cellOut + 4, true)
        // style_id is bits 26-41: the top six of the low word and bottom ten of the
        // high. Zero is the default style, which needs no color fetch.
        if (lo >>> 26 !== 0 || (hi & 0x3ff) !== 0) {
          ex.ghostty_render_state_row_cells_get_multi(cells.h, fgbg.n, fgbg.keysPtr, fgbg.valsPtr, writtenPtr)
        }
        return lo
      },
    }
    const bulkRow = mode === 'rowRaw'
    const perCell = bulkRow ? () => 0 : cellFns[mode === 'steady' ? 'raw' : mode]
    if (!perCell) throw new Error(`unknown mode ${mode}`)
    const dirtyOnly = mode === 'steady'

    const frame = () => {
      if (dirtyOnly) write(term, editRow(rows))
      ok(ex.ghostty_render_state_update(state, term), 'update')
      ok(ex.ghostty_render_state_get(state, DATA_ROW_ITERATOR, iter.slot), 'get ROW_ITERATOR')
      // After calls that can allocate, before the read-only row loop: growth
      // detaches the cached view.
      dv()
      let acc = 0
      let n = 0
      while (ex.ghostty_render_state_row_iterator_next(iter.h)) {
        if (dirtyOnly) {
          ok(ex.ghostty_render_state_row_get(iter.h, ROW_DATA_DIRTY, cellOut), 'row_get DIRTY')
          if (!view.getUint8(cellOut)) continue
          // The consumer clears the per-row dirty flag; otherwise every row reads
          // dirty from the second frame on.
          ok(ex.ghostty_render_state_row_set(iter.h, ROW_OPTION_DIRTY, falsePtr), 'row_set DIRTY')
        }
        if (bulkRow) {
          // One call for the whole row, then a pure-JS walk with no cells iterator.
          ok(ex.ghostty_render_state_row_get(iter.h, ROW_DATA_CELLS_RAW, cellOut), 'row_get CELLS_RAW')
          const ptr = view.getUint32(cellOut + CELLS_VIEW_OFF_PTR, true)
          const len = view.getUint32(cellOut + CELLS_VIEW_OFF_LEN, true)
          for (let i = 0; i < len; i++) {
            n++
            // Low word only: the codepoint (bits 2-22) never crosses it, so no BigInt.
            acc += view.getUint32(ptr + i * 8, true)
          }
          continue
        }
        ok(ex.ghostty_render_state_row_get(iter.h, ROW_DATA_CELLS, cells.slot), 'row_get CELLS')
        while (ex.ghostty_render_state_row_cells_next(cells.h)) {
          n++
          acc += perCell()
        }
      }
      touched = n
      return acc
    }

    frame()
    const iters = cols * rows > 5000 ? 200 : 600
    out[`${cols}x${rows}`] = { us: bench(frame, iters) / 1000, cells: touched }

    ex.ghostty_render_state_row_cells_free(cells.h)
    ex.ghostty_render_state_row_iterator_free(iter.h)
    ex.ghostty_render_state_free(state)
    ex.ghostty_terminal_free(term)
  }
  return out
}

// ---- child: measure one mode, print JSON ------------------------------------

const VENDORED_MODES = new Set(['today', 'today-steady'])

if (ONLY) {
  const result = VENDORED_MODES.has(ONLY) ? measureVendored(ONLY) : measureMain(ONLY)
  console.log(JSON.stringify(result))
  process.exit(0)
}

// ---- parent: one child per mode, then the table -----------------------------

const self = fileURLToPath(import.meta.url)
const run = (mode, workload) =>
  JSON.parse(
    execFileSync(process.execPath, [self, WASM, VENDORED, mode], {
      encoding: 'utf8',
      env: { ...process.env, WORKLOAD: workload ?? 'styled' },
    }).trim(),
  )

console.log(`main:     ${WASM}`)
console.log(`vendored: ${VENDORED}`)
console.log(`exports:  ${WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(WASM))).length}\n`)

const MODES = [
  ['today', 'today: one batched get_viewport + JS walk'],
  ['iterate', 'iterate only, no cell data'],
  ['get4', '4 separate gets (style, fg, bg, has_styling)'],
  ['multi4', 'one get_multi, same 4 keys'],
  ['raw', 'one RAW get, unpacked in JS'],
  ['raw3', 'one get_multi {RAW, fg, bg}'],
  ['rawStyled', 'RAW, fg/bg only when the cell is styled'],
  ['rowRaw', 'one CELLS_RAW get per ROW, unpacked in JS'],
]
const results = Object.fromEntries(MODES.map(([m]) => [m, run(m)]))

console.log(`${'mode'.padEnd(11)} ${'80x24'.padStart(9)} ${'vs today'.padStart(9)} ${'200x60'.padStart(9)} ${'vs today'.padStart(9)}   what it fetches`)
for (const [mode, what] of MODES) {
  const cols = GRIDS.map(([c, r]) => {
    const key = `${c}x${r}`
    const us = results[mode][key].us
    const ratio = us / results.today[key].us
    return [`${us.toFixed(1).padStart(8)}u`, `${(mode === 'today' ? 1 : ratio).toFixed(1).padStart(8)}x`]
  }).flat()
  console.log(`${mode.padEnd(11)} ${cols.join(' ')}   ${what}`)
}

// Styled is the worst case for fetching colors only where they differ; plain
// text gives the other end of the range.
const PLAIN_MODES = ['today', 'raw', 'rawStyled']
const plain = Object.fromEntries(PLAIN_MODES.map((m) => [m, run(m, 'plain')]))
console.log('\n--- plain text: no styles, so styled-only color fetches never fire ---')
console.log(`${'mode'.padEnd(11)} ${'80x24'.padStart(9)} ${'vs today'.padStart(9)} ${'200x60'.padStart(9)} ${'vs today'.padStart(9)}`)
for (const mode of PLAIN_MODES) {
  const cols = GRIDS.map(([c, r]) => {
    const key = `${c}x${r}`
    const us = plain[mode][key].us
    return [`${us.toFixed(1).padStart(8)}u`, `${(mode === 'today' ? 1 : us / plain.today[key].us).toFixed(1).padStart(8)}x`]
  }).flat()
  console.log(`${mode.padEnd(11)} ${cols.join(' ')}`)
}

// Steady state: both pay the same one-row write, so the difference is the
// read.
const steady = { main: run('steady'), today: run('today-steady') }
console.log(`\n--- steady state: one row edited, then redrawn ---`)
console.log(`${'grid'.padEnd(9)} ${'cells read'.padStart(11)} ${'iterator+RAW'.padStart(13)} ${'today'.padStart(9)}   vs today`)
for (const [c, r] of GRIDS) {
  const key = `${c}x${r}`
  const m = steady.main[key]
  const t = steady.today[key]
  console.log(
    `${key.padEnd(9)} ${`${m.cells}/${t.cells}`.padStart(11)} ${m.us.toFixed(1).padStart(12)}u ${t.us.toFixed(1).padStart(8)}u   ${(m.us / t.us).toFixed(2)}x`,
  )
}

console.log('\n(u = microseconds per frame, best of five; each mode measured in its own process)')
console.log('"today" = the vendored 1.3.1 build: update + one batched get_viewport + the JS walk')
console.log('RAW is per cell — GhosttyCell is a u64 value, not a pointer into the row.')
console.log('rowRaw is the 6b22215c CELLS_RAW view: one call per row over a borrowed run of those')
console.log('u64s, so the per-cell call boundary disappears entirely. Codepoints only — a consumer')
console.log('that also needs styles or resolved colors still pays for those separately.')
console.log('rawStyled: the workload styles every row, so it is that mode\'s worst case, not its best')
