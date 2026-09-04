/**
 * Establishes the ABI of the `ghostty_search_*` API before any of it is
 * written into `abi.ts`, the way `layout.mjs` and `gridprobe.mjs` did for the
 * render path. Nothing here is guessable from the headers alone: the sized
 * structs carry their own `size` field, wasm32 packs them differently from the
 * C declaration order, and the buffer-valued reads have a two-call capacity
 * protocol that fails silently if you get it wrong.
 *
 * What it checks, each one gating the next:
 *   1. sizeof(GhosttySelection) — brute-forced by writing candidate sizes into
 *      the struct's own `size` field and seeing which one the callee accepts.
 *   2. The GhosttySelectionBuffer capacity query (ptr NULL, cap 0 -> len).
 *   3. That matches come back where the needle was actually written, by
 *      converting each one with `ghostty_terminal_point_from_grid_ref`.
 *   4. That VIEWPORT_MATCHES is page-granular — that it really can hand back
 *      rows outside the viewport, which is what forces the clipping in
 *      `NativeSearchController`.
 *   5. That a write with no feed leaves the counts stale, which is the whole
 *      reason the controller feeds on a schedule.
 *
 * usage: node tools/parse-probes/nativesearch.mjs [main.wasm]
 */
import { readFileSync } from 'fs'
import { withAllocCompat } from './allocCompat.mjs'

const WASM = process.argv[2] ?? 'src/lib/ghostty/vendor/ghostty-vt.wasm'
const enc = new TextEncoder()

const COLS = 80
const ROWS = 24
const SB = 300
const NEEDLE = 'needle'

// search.h
const OPT_NEEDLE = 0
const OPT_SELECT_NEXT = 1
const DATA_STATUS = 0
const DATA_TOTAL = 2
const DATA_SELECTED_INDEX = 3
const DATA_SELECTED_MATCH = 4
const DATA_MATCHES = 5
const DATA_VIEWPORT_MATCHES = 6
const STATUS = ['RUNNING', 'FEED_REQUIRED', 'COMPLETE']
// point.h
const TAG_VIEWPORT = 1
const TAG_SCREEN = 2

const mod = new WebAssembly.Module(readFileSync(WASM))
const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
const ex = withAllocCompat(inst.exports)
const mem = ex.memory
let view = new DataView(mem.buffer)
const dv = () => {
  if (view.buffer !== mem.buffer) view = new DataView(mem.buffer)
  return view
}
const ok = (r, w) => {
  if (r !== 0) throw new Error(`${w} -> ${r}`)
}
const make = (fn, w) => {
  const s = ex.ghostty_wasm_alloc_opaque()
  ok(fn(s), w)
  return dv().getUint32(s, true)
}

if (typeof ex.ghostty_search_new !== 'function') {
  console.log('this binary has no ghostty_search_* in it — wrong pin?')
  process.exit(1)
}

const term = make((s) => ex.ghostty_terminal_new(0, s, COLS, ROWS), 'terminal_new')
const vptr = ex.ghostty_wasm_alloc_usize()
dv().setUint32(vptr, 64 * 1024 * 1024, true)
ok(ex.ghostty_terminal_set(term, 27, vptr), 'scrollback bytes')
dv().setUint32(vptr, SB + ROWS + 100, true)
ok(ex.ghostty_terminal_set(term, 28, vptr), 'scrollback lines')

const write = (s) => {
  const b = enc.encode(s)
  const p = ex.ghostty_wasm_alloc_u8_array(b.length)
  new Uint8Array(mem.buffer).set(b, p)
  ex.ghostty_terminal_vt_write(term, p, b.length)
  ex.ghostty_wasm_free_u8_array(p, b.length)
}

// Every tenth line carries the needle, at a column that varies, so a wrong x
// would be obvious rather than coincidentally right.
const want = []
for (let r = 0; r < SB + ROWS; r++) {
  if (r % 10 === 3) {
    const pad = ' '.repeat(r % 7)
    want.push({ row: r, x: 5 + pad.length })
    write(`line ${pad}${NEEDLE} tail\r\n`)
  } else {
    write(`line ${r} nothing here\r\n`)
  }
}

const search = make((s) => ex.ghostty_search_new(0, s, term), 'search_new')

// --- 1. the needle is a GhosttyString { const uint8_t *ptr; size_t len; } ----
const nb = enc.encode(NEEDLE)
const nbuf = ex.ghostty_wasm_alloc_u8_array(nb.length)
new Uint8Array(mem.buffer).set(nb, nbuf)
const strPtr = ex.ghostty_wasm_alloc_u8_array(8)
dv().setUint32(strPtr, nbuf, true)
dv().setUint32(strPtr + 4, nb.length, true)
ok(ex.ghostty_search_set(search, OPT_NEEDLE, strPtr), 'set needle')

const statusPtr = ex.ghostty_wasm_alloc_u8_array(4)
const usizePtr = ex.ghostty_wasm_alloc_u8_array(4)
const readStatus = () => {
  ok(ex.ghostty_search_get(search, DATA_STATUS, statusPtr), 'get status')
  return dv().getUint32(statusPtr, true)
}
const readTotal = () => {
  ok(ex.ghostty_search_get(search, DATA_TOTAL, usizePtr), 'get total')
  return dv().getUint32(usizePtr, true)
}
console.log('status after the needle is set, before any feed:', STATUS[readStatus()])

ok(ex.ghostty_search_run(search), 'run')
console.log('status after run:', STATUS[readStatus()])
console.log(`total matches: ${readTotal()} (wrote ${want.length})`)

// --- 2. sizeof(GhosttySelection) --------------------------------------------
// GhosttyGridRef is 12 bytes on wasm32 (abi.ts), so { size_t; GridRef; GridRef;
// bool } predicts 4 + 12 + 12 + 1 -> 32 with tail padding. Ask rather than
// assume: a wrong size is accepted silently by some of these APIs.
const selPtr = ex.ghostty_wasm_alloc_u8_array(64)
ok(ex.ghostty_search_set(search, OPT_SELECT_NEXT, 0), 'select next')
for (const size of [24, 28, 29, 32, 36, 40]) {
  new Uint8Array(mem.buffer, selPtr, 64).fill(0)
  dv().setUint32(selPtr, size, true)
  const r = ex.ghostty_search_get(search, DATA_SELECTED_MATCH, selPtr)
  console.log(`  selection size=${size} -> ${r === 0 ? 'SUCCESS' : `result ${r}`}`)
}

ok(ex.ghostty_search_get(search, DATA_SELECTED_INDEX, usizePtr), 'get selected index')
console.log('selected index (0 is the newest match):', dv().getUint32(usizePtr, true))

const SEL_SIZE = 32
const dumpSel = (base) => {
  const d = dv()
  const ref = (o) => ({
    size: d.getUint32(base + o, true),
    node: d.getUint32(base + o + 4, true),
    x: d.getUint16(base + o + 8, true),
    y: d.getUint16(base + o + 10, true),
  })
  return { size: d.getUint32(base, true), start: ref(4), end: ref(16), rectangle: d.getUint8(base + 28) }
}
new Uint8Array(mem.buffer, selPtr, 64).fill(0)
dv().setUint32(selPtr, SEL_SIZE, true)
ok(ex.ghostty_search_get(search, DATA_SELECTED_MATCH, selPtr), 'get selected match')
console.log('selected match, raw:', JSON.stringify(dumpSel(selPtr)))

// --- 3. grid ref -> coordinates ---------------------------------------------
const coordPtr = ex.ghostty_wasm_alloc_u8_array(8)
const toPoint = (refBase, tag) => {
  const r = ex.ghostty_terminal_point_from_grid_ref(term, refBase, tag, coordPtr)
  if (r !== 0) return null
  const d = dv()
  return { x: d.getUint16(coordPtr, true), y: d.getUint32(coordPtr + 4, true) }
}
console.log(
  'selected match: screen start',
  JSON.stringify(toPoint(selPtr + 4, TAG_SCREEN)),
  'screen end',
  JSON.stringify(toPoint(selPtr + 16, TAG_SCREEN)),
  'viewport start',
  JSON.stringify(toPoint(selPtr + 4, TAG_VIEWPORT)),
)

// --- 4. the buffer-valued reads ---------------------------------------------
const bufPtr = ex.ghostty_wasm_alloc_u8_array(12)
const query = (key) => {
  const d = dv()
  d.setUint32(bufPtr, 0, true)
  d.setUint32(bufPtr + 4, 0, true)
  d.setUint32(bufPtr + 8, 0, true)
  const r = ex.ghostty_search_get(search, key, bufPtr)
  return { result: r, len: dv().getUint32(bufPtr + 8, true) }
}
const q = query(DATA_MATCHES)
console.log(`MATCHES capacity query -> result ${q.result}, len ${q.len}`)
const qv = query(DATA_VIEWPORT_MATCHES)
console.log(`VIEWPORT_MATCHES capacity query -> result ${qv.result}, len ${qv.len}`)

const fill = (key, cap) => {
  const arr = ex.ghostty_wasm_alloc_u8_array(cap * SEL_SIZE)
  new Uint8Array(mem.buffer, arr, cap * SEL_SIZE).fill(0)
  for (let i = 0; i < cap; i++) dv().setUint32(arr + i * SEL_SIZE, SEL_SIZE, true)
  const d = dv()
  d.setUint32(bufPtr, arr, true)
  d.setUint32(bufPtr + 4, cap, true)
  d.setUint32(bufPtr + 8, 0, true)
  const r = ex.ghostty_search_get(search, key, bufPtr)
  return { result: r, len: dv().getUint32(bufPtr + 8, true), base: (i) => arr + i * SEL_SIZE }
}

const all = fill(DATA_MATCHES, q.len)
console.log(`MATCHES filled -> result ${all.result}, len ${all.len}`)
const got = []
for (let i = 0; i < all.len; i++) {
  const s = toPoint(all.base(i) + 4, TAG_SCREEN)
  const e = toPoint(all.base(i) + 16, TAG_SCREEN)
  got.push({ y: s?.y, x: s?.x, ey: e?.y, ex: e?.x })
}
console.log('first three (newest first):', JSON.stringify(got.slice(0, 3)))
console.log('last three:', JSON.stringify(got.slice(-3)))
const wantSet = new Set(want.map((w) => `${w.row}:${w.x}`))
const gotSet = new Set(got.map((g) => `${g.y}:${g.x}`))
const missing = [...wantSet].filter((k) => !gotSet.has(k))
const extra = [...gotSet].filter((k) => !wantSet.has(k))
console.log(`positions: ${wantSet.size} written, ${gotSet.size} found, ${missing.length} missing, ${extra.length} unexpected`)
if (missing.length) console.log('  missing sample:', missing.slice(0, 5))
if (extra.length) console.log('  unexpected sample:', extra.slice(0, 5))

const vp = fill(DATA_VIEWPORT_MATCHES, Math.max(1, qv.len))
const vpRows = []
for (let i = 0; i < vp.len; i++) {
  vpRows.push({
    screen: toPoint(vp.base(i) + 4, TAG_SCREEN)?.y ?? null,
    viewport: toPoint(vp.base(i) + 4, TAG_VIEWPORT)?.y ?? null,
  })
}
console.log(`VIEWPORT_MATCHES filled -> len ${vp.len}; rows:`, JSON.stringify(vpRows))
console.log(`  ${vpRows.filter((r) => r.viewport === null).length} of those do not convert to viewport coordinates`)

// --- 5. what a write does to the counts -------------------------------------
write(`a new ${NEEDLE} arrives\r\n`)
console.log('after a write with no feed: total', readTotal(), 'status', STATUS[readStatus()])
ok(ex.ghostty_search_feed(search), 'feed')
console.log('after a feed:            total', readTotal(), 'status', STATUS[readStatus()])

ex.ghostty_search_free(search)
ex.ghostty_terminal_free(term)
