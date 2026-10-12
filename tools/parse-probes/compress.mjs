/**
 * Costs out `ghostty_terminal_compress`, which our build exports but never
 * calls. Reclaiming memory needs `terminal_mem.canReclaim` (64-bit Linux,
 * Darwin and, since 60b43068, Windows), and freestanding wasm may get
 * UNSUPPORTED, so the result code is measured first.
 *
 * Two arms, identical writes:
 *   A. what we ship -- write, never compress.
 *   B. compress incrementally on an idle cadence.
 *
 * Compared on rows surviving the byte budget, peak wasm heap (it only
 * grows), and call cost; then a needle written first must still be findable.
 *
 * usage: node tools/parse-probes/compress.mjs [main.wasm]
 */
import { readFileSync } from 'fs'
import { withAllocCompat } from './allocCompat.mjs'

const WASM = process.argv[2] ?? 'src/lib/ghostty/vendor/ghostty-vt.wasm'
const enc = new TextEncoder()

// terminal.h
const OPT_SCROLLBACK_MAX_BYTES = 27
const OPT_SCROLLBACK_MAX_LINES = 28
const DATA_SCROLLBACK_ROWS = 15
const COMPRESS_INCREMENTAL = 0
// The other half of the same enum. Kept so the pair reads as the ABI it was
// transcribed from rather than as a lone magic zero, and underscored because
// this probe only ever exercises the incremental mode — a full compression is
// a different question from the one it was written to cost out.
const _COMPRESS_FULL = 1
const CRESULT = ['UNSUPPORTED', 'PENDING', 'COMPLETE']
// search.h
const OPT_NEEDLE = 0
const DATA_STATUS = 0
const DATA_TOTAL = 2
const NEEDLE = 'zzmarker'

const bytes = readFileSync(WASM)
const mod = new WebAssembly.Module(bytes)

function build({ budgetBytes, cols, rows, lines, compressEvery }) {
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
  const opaque = (fn, w) => {
    const s = ex.ghostty_wasm_alloc_opaque()
    ok(fn(s), w)
    return dv().getUint32(s, true)
  }

  const term = opaque((s) => ex.ghostty_terminal_new(0, s, cols, rows), 'terminal_new')
  const slot = ex.ghostty_wasm_alloc_usize()
  dv().setUint32(slot, budgetBytes, true)
  ok(ex.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_BYTES, slot), 'max bytes')
  // Deliberately far above anything the byte budget will allow, so the byte
  // budget is the only thing doing any pruning.
  dv().setUint32(slot, 10_000_000, true)
  ok(ex.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_LINES, slot), 'max lines')

  const write = (s) => {
    const b = enc.encode(s)
    const p = ex.ghostty_wasm_alloc_u8_array(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    ex.ghostty_terminal_vt_write(term, p, b.length)
    ex.ghostty_wasm_free_u8_array(p, b.length)
  }

  const resultSlot = ex.ghostty_wasm_alloc_u8_array(4)
  let compressMs = 0
  let steps = 0
  let lastResult = null
  /** One idle window: step until the core says it has nothing pending. */
  const idle = () => {
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) {
      steps++
      ok(ex.ghostty_terminal_compress(term, COMPRESS_INCREMENTAL, resultSlot), 'compress')
      lastResult = dv().getUint32(resultSlot, true)
      if (lastResult !== 1) break
    }
    compressMs += performance.now() - t0
  }

  // A marker at the very bottom of history, to prove it survives.
  write(`${NEEDLE} the oldest line\r\n`)
  // Text with the shape real output has: repeated words compress, so this is
  // neither incompressible noise nor an unrealistically uniform block.
  for (let i = 1; i < lines; i++) {
    write(`[2026-09-10 10:00:00] INFO  request id=${i} path=/api/v1/items status=200 dur=${i % 97}ms\r\n`)
    if (compressEvery && i % compressEvery === 0) idle()
  }
  if (compressEvery) idle()

  ok(ex.ghostty_terminal_get(term, DATA_SCROLLBACK_ROWS, slot), 'scrollback rows')
  const scrollbackRows = dv().getUint32(slot, true)

  // Correctness: the core's own search has to still find what is down there.
  const search = opaque((s) => ex.ghostty_search_new(0, s, term), 'search_new')
  const nb = enc.encode(NEEDLE)
  const nbuf = ex.ghostty_wasm_alloc_u8_array(nb.length)
  new Uint8Array(mem.buffer).set(nb, nbuf)
  const strPtr = ex.ghostty_wasm_alloc_u8_array(8)
  dv().setUint32(strPtr, nbuf, true)
  dv().setUint32(strPtr + 4, nb.length, true)
  ok(ex.ghostty_search_set(search, OPT_NEEDLE, strPtr), 'set needle')
  const t0 = performance.now()
  ok(ex.ghostty_search_run(search), 'run')
  const searchMs = performance.now() - t0
  ok(ex.ghostty_search_get(search, DATA_TOTAL, slot), 'total')
  const found = dv().getUint32(slot, true)
  ok(ex.ghostty_search_get(search, DATA_STATUS, slot), 'status')
  const status = dv().getUint32(slot, true)

  return {
    scrollbackRows,
    heapMB: mem.buffer.byteLength / 1024 / 1024,
    compressMs,
    steps,
    lastResult,
    found,
    status,
    searchMs,
  }
}

const CASES = [
  { name: '8MB tier  @ 80 cols', budgetBytes: 2.5 * 1024 * 1024, cols: 80, rows: 24, lines: 20000 },
  { name: '32MB tier @ 80 cols', budgetBytes: 12 * 1024 * 1024, cols: 80, rows: 24, lines: 40000 },
  { name: '32MB tier @ 200 cols', budgetBytes: 12 * 1024 * 1024, cols: 200, rows: 50, lines: 40000 },
]

console.log(`wasm: ${WASM} (${bytes.length.toLocaleString()} bytes)\n`)
for (const c of CASES) {
  const a = build({ ...c, compressEvery: 0 })
  const b = build({ ...c, compressEvery: 500 })
  console.log(`## ${c.name} -- ${c.lines.toLocaleString()} lines written`)
  console.log(`   compress result: ${CRESULT[b.lastResult] ?? b.lastResult} (${b.steps} steps, ${b.compressMs.toFixed(1)} ms total)`)
  console.log(`   rows kept:  ${a.scrollbackRows.toLocaleString()} -> ${b.scrollbackRows.toLocaleString()}  (${(((b.scrollbackRows - a.scrollbackRows) / a.scrollbackRows) * 100).toFixed(1)}%)`)
  console.log(`   wasm heap:  ${a.heapMB.toFixed(1)} MB -> ${b.heapMB.toFixed(1)} MB`)
  console.log(`   marker found: ${a.found} -> ${b.found}   full search: ${a.searchMs.toFixed(1)} ms -> ${b.searchMs.toFixed(1)} ms`)
  console.log()
}
