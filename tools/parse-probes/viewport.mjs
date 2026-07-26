/**
 * Costs the two ways of getting a frame's cells out of the core.
 *
 * Today (ghostty-web's 1.2 shim) the whole viewport comes back in ONE call:
 *
 *   ghostty_render_state_update(term)
 *   ghostty_render_state_get_viewport(term, ptr, cellCount)   // packed, 16 B/cell
 *   -> read straight out of linear memory as a typed array
 *
 * Ghostty main's libghostty-vt render API has no packed-buffer equivalent. It
 * exposes a row iterator and a per-cell cursor, and cell data is fetched with
 * ghostty_render_state_row_cells_get(cells, key, outPtr) — one C call per cell
 * per attribute. include/ghostty/vt/render.h says so itself, noting that span
 * queries can avoid "one C API call per cell" for *selection state* only.
 *
 * The upgrade therefore hinges on what a JS->WASM call costs, because that is
 * the floor of the iterator model no matter how fast the Zig behind it is.
 * That floor is measurable with the binary we already ship — no 1.3 build
 * needed to find it — using two exports whose shapes match the ones the
 * iterator model would use:
 *
 *   get_cols(term)                   ~ row_cells_next(cells)      1 arg
 *   get_mode(term, mode, outPtr)     ~ row_cells_get(c, key, out) 3 args + out
 *
 * Run: node tools/parse-probes/viewport.mjs [wasmPath]
 */
import { readFileSync } from 'fs'

const WASM = process.argv[2] ?? 'src/lib/ghostty/vendor/ghostty-vt.wasm'
const CELL_BYTES = 16
const enc = new TextEncoder()

const mod = new WebAssembly.Module(readFileSync(WASM))
const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
const ex = inst.exports
const mem = ex.memory

function newTerminal(cols, rows) {
  const cfg = ex.ghostty_wasm_alloc_u8_array(80)
  try {
    const dv = new DataView(mem.buffer)
    dv.setUint32(cfg, 1000, true)
    for (let i = 4; i < 80; i += 4) dv.setUint32(cfg + i, 0, true)
    const h = ex.ghostty_terminal_new_with_config(cols, rows, cfg)
    if (!h) throw new Error('terminal_new failed')
    return h
  } finally {
    ex.ghostty_wasm_free_u8_array(cfg, 80)
  }
}

function write(term, s) {
  const b = enc.encode(s)
  const p = ex.ghostty_wasm_alloc_u8_array(b.length)
  new Uint8Array(mem.buffer).set(b, p)
  ex.ghostty_terminal_write(term, p, b.length)
  ex.ghostty_wasm_free_u8_array(p, b.length)
}

/** A screenful of styled text, so cells carry real styles rather than blanks. */
function fill(term, cols, rows) {
  let s = '\x1b[H'
  for (let r = 0; r < rows; r++) {
    s += `\x1b[38;5;${(r % 200) + 16}m`
    s += ('sample text ' + String(r).padStart(3, '0') + ' ').repeat(Math.ceil(cols / 16)).slice(0, cols)
    if (r < rows - 1) s += '\r\n'
  }
  write(term, s + '\x1b[0m')
}

function bench(label, fn, iters) {
  for (let i = 0; i < Math.min(iters, 1000); i++) fn()
  let best = Infinity
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0))
  }
  return { label, ns: best / iters }
}

// ---- per-call boundary cost -------------------------------------------------
const t80 = newTerminal(80, 24)
fill(t80, 80, 24)
ex.ghostty_render_state_update(t80)

const outPtr = ex.ghostty_wasm_alloc_u8_array(8)

// Shape vs work. get_mode costs the same with an out pointer (16.16 ns) as with
// a null one (16.30), so the out parameter is free and its expense is its own
// mode-table lookup, not the call. Simple exports that only read a field land
// near 4.2 ns, and that is the real boundary cost. Measuring only get_mode
// would overstate the iterator model by ~4x.
const calls = [
  bench('get_cursor_x(term)      1 arg', () => ex.ghostty_render_state_get_cursor_x(t80), 2_000_000),
  bench('is_row_dirty(term,row)  2 arg', () => ex.ghostty_render_state_is_row_dirty(t80, 3), 2_000_000),
  bench('is_row_wrapped(term,row) 2 arg', () => ex.ghostty_terminal_is_row_wrapped(t80, 3), 2_000_000),
  bench('get_mode(term,mode,out) 3+out', () => ex.ghostty_terminal_get_mode(t80, 2004, outPtr), 2_000_000),
]

console.log(`wasm: ${WASM}\n`)
console.log('--- JS->WASM call cost by shape (overhead + that export\'s own work) ---')
for (const c of calls) console.log(`${c.label.padEnd(32)} ${c.ns.toFixed(2).padStart(7)} ns/call`)
const CALL_LO = 4.2 // field read: close to pure boundary overhead
const CALL_MID = 8.0 // a lookup with modest work, cf. is_row_wrapped
const CALL_HI = 16.0 // as heavy as get_mode

// ---- current batched model --------------------------------------------------
console.log('\n--- current: one call for the whole viewport ---')
console.log(`${'grid'.padEnd(10)} ${'cells'.padStart(6)} ${'update'.padStart(9)} ${'get_viewport'.padStart(13)} ${'+read'.padStart(8)} ${'total'.padStart(9)}`)

const GRIDS = [[80, 24], [200, 60]]
const totals = {}
for (const [cols, rows] of GRIDS) {
  const term = newTerminal(cols, rows)
  fill(term, cols, rows)
  const cells = cols * rows
  const buf = ex.ghostty_wasm_alloc_u8_array(cells * CELL_BYTES)

  const up = bench('u', () => ex.ghostty_render_state_update(term), 20_000)
  const gv = bench('g', () => ex.ghostty_render_state_get_viewport(term, buf, cells), 20_000)
  // What WebGLRenderer then does: walk the packed buffer in linear memory.
  const rd = bench('r', () => {
    const v = new DataView(mem.buffer, buf, cells * CELL_BYTES)
    let acc = 0
    for (let i = 0; i < cells; i++) acc += v.getUint32(i * CELL_BYTES, true)
    return acc
  }, 2_000)

  const total = up.ns + gv.ns + rd.ns
  totals[`${cols}x${rows}`] = { cells, total }
  console.log(
    `${`${cols}x${rows}`.padEnd(10)} ${String(cells).padStart(6)} ${(up.ns / 1000).toFixed(1).padStart(8)}u ${(gv.ns / 1000).toFixed(1).padStart(12)}u ${(rd.ns / 1000).toFixed(1).padStart(7)}u ${(total / 1000).toFixed(1).padStart(8)}u`,
  )
  ex.ghostty_wasm_free_u8_array(buf, cells * CELL_BYTES)
  ex.ghostty_terminal_free(term)
}
console.log('(u = microseconds)')

// ---- projected iterator model ----------------------------------------------
// Per cell: one _next, plus one _get per attribute the renderer needs.
// Our WebGLRenderer needs at minimum codepoint, fg, bg and styling flags.
// The real cost of row_cells_get is unknown without a 1.3 build, so this is a
// band rather than a figure: what the model costs if each per-cell call is a
// bare field read, a modest lookup, or as heavy as get_mode.
console.log('\n--- projected: row/cell iterator (ghostty main) ---')
console.log(`${'grid'.padEnd(9)} ${'calls/frame'.padStart(11)} ${'@4.2ns'.padStart(9)} ${'@8ns'.padStart(9)} ${'@16ns'.padStart(9)}   vs today   worst as % of 8.33ms`)
const GETS_PER_CELL = 4
for (const [cols, rows] of GRIDS) {
  const key = `${cols}x${rows}`
  const { cells, total } = totals[key]
  const nCalls = cells * (1 + GETS_PER_CELL) + rows * 2
  const at = (c) => nCalls * c
  console.log(
    `${key.padEnd(9)} ${String(nCalls).padStart(11)} ${(at(CALL_LO) / 1000).toFixed(1).padStart(8)}u ${(at(CALL_MID) / 1000).toFixed(1).padStart(8)}u ${(at(CALL_HI) / 1000).toFixed(1).padStart(8)}u   ${(at(CALL_LO) / total).toFixed(1)}x-${(at(CALL_HI) / total).toFixed(1)}x   ${((at(CALL_HI) / 8_330_000) * 100).toFixed(1)}%`,
  )
}
console.log(`\nassumes ${GETS_PER_CELL} _get per cell (codepoint, fg, bg, styling) + 1 _next`)
console.log('full-redraw worst case; DIRTY_PARTIAL means steady-state typing touches only changed rows')
