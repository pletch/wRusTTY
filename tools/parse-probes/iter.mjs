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
 * It also prices the RAW path, which is the only thing in the newer API that
 * could plausibly close the gap: ROW_CELLS_DATA_RAW returns `page.Cell.C` —
 * the whole cell packed into one u64 (`cell.cval()`) — so a renderer can take
 * one call per cell and unpack in JS, the way it already unpacks the 16-byte
 * cells of the batched viewport. RAW is per *cell*, not per row: GhosttyCell is
 * a u64 value, not a pointer to the row's cell array, so it cannot amortise the
 * boundary crossing. What it can do is take four gets per cell down to one.
 *
 * And it prices the one thing that beats a batched read outright: skipping
 * clean rows. `render_state_update` consumes the core's dirty bits and rebuilds
 * only dirty rows, so a one-row edit can be read back as one row. The batched
 * `get_viewport` has no way to ask for less than the whole viewport.
 *
 * ## Methodology, learned the hard way
 *
 * **One mode per process.** A single `frame(mode)` with a branch per mode goes
 * megamorphic and its numbers move by 2x between runs depending on which modes
 * ran. Each mode is therefore measured in a freshly spawned child, and the
 * parent only formats the table. This is the same lesson probe.mjs records
 * about probes sharing a heap, in a different costume.
 *
 * **The baseline is measured, not remembered.** `today` comes from the vendored
 * 1.3.1 binary in a child of its own, so a machine or Node change moves both
 * sides together.
 *
 * Build the wasm with Zig 0.16.0:
 *   zig build -Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
 *
 * Run: node tools/parse-probes/iter.mjs <main-ghostty-vt.wasm> [vendored.wasm]
 */
import { readFileSync } from 'fs'
import { withAllocCompat } from './allocCompat.mjs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const WASM = process.argv[2]
if (!WASM) throw new Error('usage: iter.mjs <ghostty-vt.wasm from ghostty main> [vendored.wasm]')
// The v1.3.1 build, which is what "today" means here — these probes exist to
// compare main's iterator against the batched `get_viewport` that only the
// v1.3.1 ABI has. This defaulted to `vendor/ghostty-vt.wasm` until the port
// landed and put a *main* binary at that path, at which point both probes died
// on `ghostty_terminal_new_with_config is not a function` — the v1.3.1 ABI
// asked of a main binary. That read as "the probes are broken"; they were not.
const VENDORED = process.argv[3] ?? 'src/lib/ghostty/vendor-131/ghostty-vt.wasm'
/** Set by the parent when it spawns a child to measure exactly one mode. */
const ONLY = process.argv[4] ?? null

// GhosttyRenderStateData
const DATA_ROW_ITERATOR = 4
// GhosttyRenderStateRowData / GhosttyRenderStateRowOption
const ROW_DATA_DIRTY = 1
const ROW_DATA_CELLS = 3
/**
 * `GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW`, new in the 6b22215c pin.
 *
 * Writes a `GhosttyCellsView { const GhosttyCell *ptr; size_t len; }` — on
 * wasm32 two u32s — giving a borrowed, contiguous run of `len` packed u64 cells
 * for the current row. So a whole row costs **one** call instead of one per
 * cell, and the unpack becomes plain JS over linear memory. Borrowed: it is
 * invalidated by the next `render_state_update`.
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
// The same information taken through RAW: one packed cell plus the two resolved
// colors. Colors arrive pre-resolved in the vendored ABI, so a fair comparison
// has to fetch them here too rather than stopping at the style id inside RAW.
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
 * A screenful of text. Styled by default, so cells carry real styles rather
 * than blanks. WORKLOAD=plain leaves every cell on the default style, which is
 * what most of a real screen looks like and is the case the styled-only color
 * fetch exists for.
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
    // One frame, end to end: update, one batched read, then the JS walk the
    // renderer does over the packed buffer.
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
   * One DataView, refreshed only when linear memory grows and detaches it.
   * Allocating a view per cell costs more than the WASM call it is there to
   * read — it made RAW measure 2x *slower* than four separate gets, which is
   * arithmetically impossible and was the tell.
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
   * alloc_opaque gives a slot; the constructor writes the handle into it.
   *
   * Both are kept, because the API needs each in different places: iterator and
   * cells handles are advanced and freed by handle, but `get(state,
   * ROW_ITERATOR, out)` wants the *slot* — render.zig does `const it = out.*
   * orelse ...` and populates the object the slot points at. Passing the handle
   * there returns GHOSTTY_INVALID_VALUE (-2).
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
     * Note the shape change since this probe was first written: tip takes cols
     * and rows as plain arguments — `new(allocator, result, cols, rows)` —
     * where the older build passed a GhosttyTerminalOptions struct by pointer.
     * Scrollback is no longer a constructor argument at all; it is a
     * `terminal_set` option. The default is left alone: the probe renders the
     * viewport and never scrolls, so scrollback cannot enter the measurement.
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
     * Per-cell work, one function per mode so no call site sees more than one
     * shape. `acc` is returned rather than discarded, so the JS-side unpack
     * cannot be optimised away and credited to RAW as a saving.
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
        // style_id is bits 26-41 of the packed cell: six bits at the top of the
        // low word, ten at the bottom of the high one. Zero is the default
        // style, and a default-styled cell needs no color fetch at all.
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
      // After the calls that can allocate, before the read loop that cannot:
      // a grown memory detaches the cached view, and the getters below would
      // throw on it. The row loop only reads, so once per frame is enough.
      dv()
      let acc = 0
      let n = 0
      while (ex.ghostty_render_state_row_iterator_next(iter.h)) {
        if (dirtyOnly) {
          ok(ex.ghostty_render_state_row_get(iter.h, ROW_DATA_DIRTY, cellOut), 'row_get DIRTY')
          if (!view.getUint8(cellOut)) continue
          // The per-row dirty flag lives in the render state and is cleared by
          // its consumer, not by the next update. Without this every row reads
          // dirty from the second frame on and the mode measures nothing.
          ok(ex.ghostty_render_state_row_set(iter.h, ROW_OPTION_DIRTY, falsePtr), 'row_set DIRTY')
        }
        if (bulkRow) {
          // One call for the whole row, then a pure-JS walk. No cells iterator
          // is involved at all — that is the entire point of the mode.
          ok(ex.ghostty_render_state_row_get(iter.h, ROW_DATA_CELLS_RAW, cellOut), 'row_get CELLS_RAW')
          const ptr = view.getUint32(cellOut + CELLS_VIEW_OFF_PTR, true)
          const len = view.getUint32(cellOut + CELLS_VIEW_OFF_LEN, true)
          for (let i = 0; i < len; i++) {
            n++
            // Low word only, matching `raw`: the codepoint lives in bits 2-22
            // and never crosses the word boundary, so this stays off BigInt.
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

// The styled workload puts a style on every cell, which is the worst case for
// fetching colors only where they differ from the default. Most of a real
// screen is unstyled, so the same three modes are re-run on plain text to give
// the other end of the range.
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

// Steady state is its own comparison: both sides pay the same one-row write, so
// the difference between them is the read.
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
