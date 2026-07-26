/**
 * Third round. Two corrections to chase:
 *
 *  - env.log is a real wasm->JS call. Any probe that trips it is measuring a
 *    boundary crossing, not parsing. Counted per probe here; a non-zero count
 *    invalidates that row.
 *  - "the 2nd parameter costs 48 ns" came from ESC[0;0G, and CHA takes one
 *    parameter. Feeding it two may be hitting an unhandled path rather than
 *    parameter machinery. Compared against commands that legitimately take
 *    two.
 */
import { readFileSync } from 'fs'

const WASM = process.argv[2]
const ITERS = Number(process.argv[3] ?? 25)
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

const PROBES = [
  // CUP genuinely takes two parameters; SGR takes many. If the 2nd-param cost
  // is parameter machinery it shows up here too, if it was an unhandled-path
  // artifact it does not.
  P('2nd param', 'CUP  ESC[H     (0 params)', '\x1b[H'),
  P('2nd param', 'CUP  ESC[1H    (1 param)', '\x1b[1H'),
  P('2nd param', 'CUP  ESC[1;1H  (2 params)', '\x1b[1;1H'),
  P('2nd param', 'SGR  ESC[m     (0 params)', '\x1b[m'),
  P('2nd param', 'SGR  ESC[0m    (1 param)', '\x1b[0m'),
  P('2nd param', 'SGR  ESC[0;0m  (2 params)', '\x1b[0;0m'),
  P('2nd param', 'CHA  ESC[0G    (1 param)', '\x1b[0G'),
  P('2nd param', 'CHA  ESC[0;0G  (2 params)', '\x1b[0;0G', 'CHA takes 1'),

  P('esc entry', 'C0   CR', '\r'),
  P('esc entry', 'ESC7 save cursor', '\x1b7'),
  P('esc entry', 'ESC8 restore cursor', '\x1b8'),
  P('esc entry', 'ESC D index', '\x1bD'),
]

const mod = new WebAssembly.Module(readFileSync(WASM))
let logCalls = 0
const inst = new WebAssembly.Instance(mod, { env: { log: () => { logCalls++ } } })
const ex = inst.exports
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
  write()
  const logsPerWrite = logCalls
  logCalls = 0
  for (let i = 0; i < 2; i++) write()
  let best = Infinity
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) write()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / 1e9)
  }
  ex.ghostty_wasm_free_u8_array(ptr, p.buf.length)
  ex.ghostty_terminal_free(term)
  return { mbs: (p.buf.length * iters) / (1024 * 1024) / best, nsAction: (best * 1e9) / (iters * p.actions), logsPerWrite }
}

let group = null
for (const p of PROBES) {
  if (p.group !== group) {
    group = p.group
    console.log(`\n--- ${group} ---`)
    console.log(`${'payload'.padEnd(28)} ${'MB/s'.padStart(7)} ${'ns/unit'.padStart(8)} ${'env.log'.padStart(8)}   note`)
  }
  const r = measure(p, ITERS)
  const flag = r.logsPerWrite > 0 ? ` <-- INVALID` : ''
  console.log(
    `${p.label.padEnd(28)} ${r.mbs.toFixed(1).padStart(7)} ${r.nsAction.toFixed(1).padStart(8)} ${String(r.logsPerWrite).padStart(8)}   ${p.note}${flag}`,
  )
}
