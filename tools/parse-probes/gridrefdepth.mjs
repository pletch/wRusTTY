/**
 * Is ghostty_terminal_grid_ref O(depth)? terminal.h warns that `screen` and
 * `history` tags "may require traversing the full scrollback page list to
 * resolve the y coordinate, so they can be expensive for large scrollback".
 *
 * The row-walk in search.mjs pays one resolve per row, so if that resolve is
 * linear in y the whole search is quadratic and the 0.83x result would not
 * survive a deeper buffer. Measures resolve-only cost at increasing depth.
 */
import { readFileSync } from 'fs'

const MAIN = process.argv[2]
const COLS = 200, ROWS = 60
const SB = Number(process.argv[3] ?? 40000)
const enc = new TextEncoder()

const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(MAIN)), { env: { log: () => {} } })
const ex = inst.exports, mem = ex.memory
let v = new DataView(mem.buffer)
const dv = () => { if (v.buffer !== mem.buffer) v = new DataView(mem.buffer); return v }

const slot = ex.ghostty_wasm_alloc_opaque()
ex.ghostty_terminal_new(0, slot, COLS, ROWS)
const term = dv().getUint32(slot, true)
const vptr = ex.ghostty_wasm_alloc_usize()
dv().setUint32(vptr, 1024 * 1024 * 1024, true)
ex.ghostty_terminal_set(term, 27, vptr)
dv().setUint32(vptr, SB + ROWS + 1000, true)
ex.ghostty_terminal_set(term, 28, vptr)

let s = '\x1b[H'
for (let r = 0; r < SB; r++) {
  const line = `2026-08-04T14:00:00 INFO worker[${r % 8}] batch ${r} `
  s += line.repeat(Math.ceil(COLS / line.length)).slice(0, COLS) + '\r\n'
}
const b = enc.encode(s)
const p = ex.ghostty_wasm_alloc_u8_array(b.length)
new Uint8Array(mem.buffer).set(b, p)
ex.ghostty_terminal_vt_write(term, p, b.length)

const o = ex.ghostty_wasm_alloc_u8_array(16)
ex.ghostty_terminal_get(term, 15, o)
const sbLen = dv().getUint32(o, true)
console.log(`scrollback rows retained: ${sbLen}\n`)

const ptPtr = ex.ghostty_wasm_alloc_u8_array(16)
const refPtr = ex.ghostty_wasm_alloc_u8_array(16)

function resolveCost(y, iters = 20000) {
  const d = dv()
  d.setUint32(ptPtr, 2, true); d.setUint32(ptPtr + 4, 0, true)
  d.setUint32(ptPtr + 8, 0, true); d.setUint32(ptPtr + 12, y, true)
  for (let i = 0; i < 200; i++) ex.ghostty_terminal_grid_ref(term, ptPtr, refPtr)
  let best = Infinity
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) ex.ghostty_terminal_grid_ref(term, ptPtr, refPtr)
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / iters)
  }
  return best
}

console.log('depth (row y) | ns per grid_ref resolve')
for (const frac of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
  const y = Math.floor((sbLen - 1) * frac)
  console.log(`  ${String(y).padStart(7)}     | ${resolveCost(y).toFixed(1)}`)
}
