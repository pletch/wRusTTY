/**
 * Second differential round: decompose the 71 ns of ESC[0m into
 * per-byte state-machine cost, per-sequence dispatch, and parameter machinery,
 * and check whether escapes damage the printable bulk path around them.
 */
import { readFileSync } from 'fs'
import { withAllocCompat } from './allocCompat.mjs'

const WASM = process.argv[2]
const ITERS = Number(process.argv[3] ?? 30)
const PROBE_BYTES = 2 * 1024 * 1024
const enc = new TextEncoder()

function repeatUnit(unit, targetBytes) {
  const bytes = enc.encode(unit)
  const count = Math.max(1, Math.floor(targetBytes / bytes.length))
  const out = new Uint8Array(bytes.length * count)
  for (let i = 0; i < count; i++) out.set(bytes, i * bytes.length)
  return { buf: out, unitLen: bytes.length, actions: count }
}

const P = (group, label, unit, note = '') => ({ group, label, unit, note, ...repeatUnit(unit, PROBE_BYTES) })

const X = (n) => 'x'.repeat(n)

const PROBES = [
  P('floor', 'C0  CR', '\r', '1 byte, trivial'),
  P('floor', 'C0  BS', '\x08', '1 byte, trivial'),
  P('floor', 'ESC 7 (save cursor)', '\x1b7', '2 bytes, no CSI'),
  P('floor', 'CSI  ESC[H', '\x1b[H', '3 bytes, no params'),
  P('floor', 'CSI  ESC[0m', '\x1b[0m', '4 bytes, 1 param'),

  P('param', 'CHA no param  ESC[G', '\x1b[G', 'implicit'),
  P('param', 'CHA 1 param   ESC[0G', '\x1b[0G', 'explicit'),
  P('param', 'CHA 2 params  ESC[0;0G', '\x1b[0;0G'),
  P('param', 'SGR no param  ESC[m', '\x1b[m', 'implicit'),
  P('param', 'SGR 1 param   ESC[0m', '\x1b[0m', 'explicit'),

  P('mix', 'printable only (80+crlf)', X(80) + '\r\n', 'bulk path'),
  P('mix', 'escape every 80 cells', '\x1b[0m' + X(80) + '\r\n'),
  P('mix', 'escape every 8 cells', '\x1b[0m' + X(8), 'TUI-ish density'),
  P('mix', 'escape every 1 cell', '\x1b[0m' + X(1), 'worst case'),
  P('mix', 'printable only (8/unit)', X(8), 'bulk control'),
]

const mod = new WebAssembly.Module(readFileSync(WASM))
const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
const ex = withAllocCompat(inst.exports)
const mem = ex.memory

function newTerminal(cols, rows, scrollbackLines) {
  const cfg = ex.ghostty_wasm_alloc_u8_array(80)
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

function measure(p, iters) {
  const term = newTerminal(80, 24, 1000)
  const ptr = ex.ghostty_wasm_alloc_u8_array(p.buf.length)
  const write = () => {
    new Uint8Array(mem.buffer).set(p.buf, ptr)
    ex.ghostty_terminal_write(term, ptr, p.buf.length)
  }
  for (let i = 0; i < 3; i++) write()
  let best = Infinity
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) write()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / 1e9)
  }
  ex.ghostty_wasm_free_u8_array(ptr, p.buf.length)
  ex.ghostty_terminal_free(term)
  const nsTotal = best * 1e9
  return {
    mbs: (p.buf.length * iters) / (1024 * 1024) / best,
    nsAction: nsTotal / (iters * p.actions),
    nsByte: nsTotal / (iters * p.buf.length),
  }
}

let group = null
for (const p of PROBES) {
  if (p.group !== group) {
    group = p.group
    console.log(`\n--- ${group} ---`)
    console.log(`${'payload'.padEnd(26)} ${'bytes'.padStart(5)} ${'MB/s'.padStart(7)} ${'ns/unit'.padStart(8)} ${'ns/byte'.padStart(8)}   note`)
  }
  const r = measure(p, ITERS)
  console.log(
    `${p.label.padEnd(26)} ${String(p.unitLen).padStart(5)} ${r.mbs.toFixed(1).padStart(7)} ${r.nsAction.toFixed(1).padStart(8)} ${r.nsByte.toFixed(2).padStart(8)}   ${p.note}`,
  )
}
