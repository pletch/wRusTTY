/**
 * Localises the long-SGR regression between two builds.
 *
 * Short SGR (1 param) is at parity while 10-param SGR is ~10% slower, so the
 * cost is per-parameter rather than fixed. These probes separate the three
 * things that scale with parameter count:
 *
 *   separators   more ';' at the same digit count
 *   digits       more digits at the same parameter count
 *   parameters   both together, the shape the workload actually uses
 *
 * plus a non-SGR parameterised CSI (CUP) to tell a change in the generic CSI
 * parameter machinery from one in the SGR handler specifically.
 *
 * Run: node tools/parse-probes/sgrdiff.mjs <a.wasm> <b.wasm>
 */
import { readFileSync } from 'fs'

const PROBE_BYTES = 2 * 1024 * 1024
const enc = new TextEncoder()

function repeatUnit(unit, targetBytes) {
  const bytes = enc.encode(unit)
  const count = Math.max(1, Math.floor(targetBytes / bytes.length))
  const out = new Uint8Array(bytes.length * count)
  for (let i = 0; i < count; i++) out.set(bytes, i * bytes.length)
  return { buf: out, unitLen: bytes.length, actions: count }
}

const P = (group, label, unit) => ({ group, label, unit, ...repeatUnit(unit, PROBE_BYTES) })

const semis = (n) => `\x1b[${Array(n).fill('0').join(';')}m`

const PROBES = [
  P('params', 'SGR  0 params  ESC[m', '\x1b[m'),
  P('params', 'SGR  1 param', semis(1)),
  P('params', 'SGR  2 params', semis(2)),
  P('params', 'SGR  5 params', semis(5)),
  P('params', 'SGR 10 params', semis(10)),
  P('params', 'SGR 20 params', semis(20)),

  // Same single parameter, more digits: isolates accumulation from separators.
  P('digits', 'SGR 1 param,  1 digit', '\x1b[0m'),
  P('digits', 'SGR 1 param,  4 digits', '\x1b[0000m'),
  P('digits', 'SGR 1 param, 10 digits', '\x1b[0000000000m'),

  // Colon separators take a different branch (params_sep) from semicolons.
  P('sep', 'SGR 5 params, semicolons', semis(5)),
  P('sep', 'SGR 5 params, colons', `\x1b[${Array(5).fill('0').join(':')}m`),

  // Non-SGR parameterised CSI: generic param machinery vs the SGR handler.
  P('non-sgr', 'CUP 0 params  ESC[H', '\x1b[H'),
  P('non-sgr', 'CUP 2 params  ESC[1;1H', '\x1b[1;1H'),
  P('non-sgr', 'CHA 1 param   ESC[0G', '\x1b[0G'),
]

function load(path) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {
    env: { log: () => { logs++ } },
  })
  return inst.exports
}

let logs = 0

function measure(ex, p, iters) {
  const mem = ex.memory
  const cfg = ex.ghostty_wasm_alloc_u8_array(80)
  new Uint8Array(mem.buffer).fill(0, cfg, cfg + 80)
  new DataView(mem.buffer).setUint32(cfg, 1000, true)
  const term = ex.ghostty_terminal_new_with_config(80, 24, cfg)
  ex.ghostty_wasm_free_u8_array(cfg, 80)

  const ptr = ex.ghostty_wasm_alloc_u8_array(p.buf.length)
  const write = () => {
    new Uint8Array(mem.buffer).set(p.buf, ptr)
    ex.ghostty_terminal_write(term, ptr, p.buf.length)
  }
  logs = 0
  write()
  const logsPerWrite = logs
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
  return { ns: (best * 1e9) / (iters * p.actions), logsPerWrite }
}

const [pathA, pathB] = process.argv.slice(2)
const A = load(pathA)
const B = load(pathB)
const nameA = pathA.split(/[\\/]/).pop()
const nameB = pathB.split(/[\\/]/).pop()

console.log(`A = ${nameA}`)
console.log(`B = ${nameB}\n`)

let group = null
for (const p of PROBES) {
  if (p.group !== group) {
    group = p.group
    console.log(`\n--- ${group} ---`)
    console.log(`${'payload'.padEnd(26)} ${'A ns'.padStart(8)} ${'B ns'.padStart(8)} ${'delta'.padStart(8)}   log`)
  }
  const a = measure(A, p, 25)
  const b = measure(B, p, 25)
  const flag = a.logsPerWrite || b.logsPerWrite ? ' INVALID' : ''
  console.log(
    `${p.label.padEnd(26)} ${a.ns.toFixed(1).padStart(8)} ${b.ns.toFixed(1).padStart(8)} ${(((b.ns - a.ns) / a.ns) * 100).toFixed(1).padStart(7)}%${flag}`,
  )
}
