/**
 * Headless driver for the three parse probes, against the exact vendored
 * ghostty-vt.wasm the app ships.
 *
 * Purpose is profiling, not benchmarking: run it under `node --prof` and the
 * ticks land on Zig symbols via the binary's name section. The MB/s it prints
 * are only there to confirm the harness reproduces the browser's numbers — if
 * they diverge badly, the profile is of something other than what the app does.
 *
 * The call sequence is copied from ghostty-web's own Terminal.write:
 *   alloc_u8_array -> set into linear memory -> ghostty_terminal_write -> free
 * except the buffer is allocated once and refilled, so allocator churn does not
 * dominate a profile that is supposed to be about the parser.
 */
import { readFileSync } from 'fs'

const WASM = process.argv[2] ?? 'src/lib/ghostty/vendor/ghostty-vt.wasm'
const ONLY = process.argv[3] ?? 'all'
const ITERS = Number(process.argv[4] ?? 40)

const PROBE_BYTES = 2 * 1024 * 1024
const enc = new TextEncoder()

/** Same as workloads.ts repeatUnit: whole units only, never ends mid-sequence. */
function repeatUnit(unit, targetBytes) {
  const bytes = enc.encode(unit)
  const count = Math.max(1, Math.floor(targetBytes / bytes.length))
  const out = new Uint8Array(bytes.length * count)
  for (let i = 0; i < count; i++) out.set(bytes, i * bytes.length)
  return out
}

const PROBES = {
  cells: { label: 'printable (1 cell/byte)', buf: repeatUnit('x'.repeat(80) + '\r\n', PROBE_BYTES) },
  short: { label: 'short SGR (0 cells)', buf: repeatUnit('\x1b[0m', PROBE_BYTES) },
  long: { label: 'long SGR (0 cells)', buf: repeatUnit(`\x1b[${'0;'.repeat(9)}0m`, PROBE_BYTES) },
}

const mod = new WebAssembly.Module(readFileSync(WASM))
const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
const ex = inst.exports
const mem = ex.memory

/** 80-byte config: scrollbackLimit, fg, bg, cursor, then 16 palette entries. */
function newTerminal(cols, rows, scrollbackLines) {
  const cfg = ex.ghostty_wasm_alloc_u8_array(80)
  if (cfg === 0) throw new Error('config alloc failed')
  try {
    const dv = new DataView(mem.buffer)
    dv.setUint32(cfg, scrollbackLines, true)
    for (let i = 4; i < 80; i += 4) dv.setUint32(cfg + i, 0, true)
    const h = ex.ghostty_terminal_new_with_config(cols, rows, cfg)
    if (!h) throw new Error('terminal_new failed')
    return h
  } finally {
    ex.ghostty_wasm_free_u8_array(cfg, 80)
  }
}

function run(key, iters) {
  const { label, buf } = PROBES[key]
  // Fresh terminal per probe so one probe's scrollback does not bias the next.
  const term = newTerminal(80, 24, 1000)
  const ptr = ex.ghostty_wasm_alloc_u8_array(buf.length)
  if (ptr === 0) throw new Error('payload alloc failed')

  const write = () => {
    // Re-view every time: a page grow detaches the old ArrayBuffer.
    new Uint8Array(mem.buffer).set(buf, ptr)
    ex.ghostty_terminal_write(term, ptr, buf.length)
  }

  for (let i = 0; i < 3; i++) write() // warm up TurboFan
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) write()
  const t1 = process.hrtime.bigint()

  const secs = Number(t1 - t0) / 1e9
  const mb = (buf.length * iters) / (1024 * 1024)
  const perAction = key === 'cells' ? null : (secs * 1e9) / (iters * Math.floor(buf.length / (key === 'short' ? 4 : 21)))
  console.log(
    `${label.padEnd(26)} ${(mb / secs).toFixed(1).padStart(7)} MB/s` +
      (perAction === null ? '' : `   ${perAction.toFixed(1)} ns/action`),
  )

  ex.ghostty_wasm_free_u8_array(ptr, buf.length)
  ex.ghostty_terminal_free(term)
}

console.log(`wasm: ${WASM}`)
console.log(`iters: ${ITERS} x 2 MB\n`)
for (const k of ONLY === 'all' ? Object.keys(PROBES) : [ONLY]) run(k, ITERS)
console.log(`\nlinear memory: ${(mem.buffer.byteLength / 1024 / 1024).toFixed(1)} MB`)
