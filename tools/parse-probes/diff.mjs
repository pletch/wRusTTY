/**
 * Differential parse probes against the shipping ghostty-vt.wasm.
 *
 * The whole SGR path inlines into one function, so a sampling profiler reports
 * a single symbol and tells us nothing about the inside. These payloads vary
 * exactly one property at a time instead, so the cost of that property falls
 * out of the difference in ns/action:
 *
 *   envelope   ESC [ m  with 0..10 params      -> per-param vs per-action cost
 *   handler    ESC[0m vs ESC[0G vs ESC[0d      -> SGR handler vs a trivial one
 *   style      reset / bold / alternating      -> style-table + pen-write cost
 *
 * ns/action is the number that matters; MB/s is included only because the
 * findings are written in those units.
 */
import { readFileSync } from 'fs'
import { withAllocCompat } from './allocCompat.mjs'

const WASM = process.argv[2]
const ITERS = Number(process.argv[3] ?? 40)
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
  P('envelope', 'CSI SGR, no param', '\x1b[m', 'implicit 0'),
  P('envelope', 'CSI SGR, 1 param', '\x1b[0m', 'baseline'),
  P('envelope', 'CSI SGR, 2 params', '\x1b[0;0m'),
  P('envelope', 'CSI SGR, 5 params', `\x1b[${'0;'.repeat(4)}0m`),
  P('envelope', 'CSI SGR, 10 params', `\x1b[${'0;'.repeat(9)}0m`),
  P('envelope', 'CSI SGR, 3-digit param', '\x1b[000m', 'same 1 param, wider'),

  P('handler', 'SGR reset  ESC[0m', '\x1b[0m', 'style path'),
  P('handler', 'CHA        ESC[0G', '\x1b[0G', 'cursor col, trivial'),
  P('handler', 'VPA        ESC[0d', '\x1b[0d', 'cursor row, trivial'),
  P('handler', 'CUP        ESC[H', '\x1b[H', 'no param at all'),

  P('style', 'reset, repeated', '\x1b[0m', 'pen already default'),
  P('style', 'bold, repeated', '\x1b[1m', 'pen already bold'),
  P('style', 'bold/reset alternating', '\x1b[1m\x1b[0m', 'style changes every action'),
  P('style', '256-colour fg', '\x1b[38;5;196m', 'palette + 3 params'),
  P('style', 'truecolor fg', '\x1b[38;2;12;34;56m', 'rgb + 5 params'),
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
  // Best of three: this is a ratio measurement, so a scheduler hiccup in one
  // payload and not another would read as a real difference between them.
  let best = Infinity
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) write()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / 1e9)
  }
  ex.ghostty_wasm_free_u8_array(ptr, p.buf.length)
  ex.ghostty_terminal_free(term)
  return { mbs: (p.buf.length * iters) / (1024 * 1024) / best, ns: (best * 1e9) / (iters * p.actions) }
}

let group = null
for (const p of PROBES) {
  if (p.group !== group) {
    group = p.group
    console.log(`\n--- ${group} ---`)
    console.log(`${'payload'.padEnd(26)} ${'bytes'.padStart(5)} ${'MB/s'.padStart(7)} ${'ns/action'.padStart(10)}   note`)
  }
  const r = measure(p, ITERS)
  console.log(
    `${p.label.padEnd(26)} ${String(p.unitLen).padStart(5)} ${r.mbs.toFixed(1).padStart(7)} ${r.ns.toFixed(1).padStart(10)}   ${p.note}`,
  )
}
