/**
 * Benchmarks scanOsc directly, in ms/MB, per content shape.
 *
 * The scanner is the second-largest cost in a Ghostty write and is paid only
 * because the app registers OSC and bell handlers. Its cost is extremely
 * sensitive to content shape — the byte it hunts for determines whether a
 * buffer costs one memchr pass or one call per escape — so a single "typical"
 * payload would hide the thing being optimised.
 *
 * `brackets` and `brackets+sgr` are regression guards, not targets: any scheme
 * that searches for ']' rather than ESC gets fast on escape-dense input by
 * making bracket-dense input slower, and that trade has to be visible.
 *
 * Run: node tools/parse-probes/scan.mjs [mbPerShape]
 */
import { scanOsc } from '../../src/lib/ghostty/oscScanner.ts'

const MB = Number(process.argv[2] ?? 8)
const CHUNK = 256 * 1024 // what the coalescer delivers
const enc = new TextEncoder()

function repeatTo(unit, bytes) {
  const u = enc.encode(unit)
  const n = Math.max(1, Math.floor(bytes / u.length))
  const out = new Uint8Array(u.length * n)
  for (let i = 0; i < n; i++) out.set(u, i * u.length)
  return out
}

const X = (n) => 'x'.repeat(n)

const SHAPES = {
  plain: X(80) + '\r\n',
  'sgr-dense': '\x1b[0m' + X(8),
  'sgr-typical': '\x1b[1;32m' + X(12) + '\x1b[0m ' + X(20) + '\r\n',
  'osc-titles': '\x1b]0;a title\x07' + X(200) + '\r\n',
  brackets: '["' + X(20) + '","' + X(20) + '"],' + X(10) + '\r\n',
  'brackets+sgr': '\x1b[1;32m["' + X(20) + '"]\x1b[0m,' + X(10) + '\r\n',
}

console.log(`scanOsc — ${MB} MB per shape, ${CHUNK / 1024} KB chunks\n`)
console.log(`${'shape'.padEnd(14)} ${'ms/MB'.padStart(8)} ${'events'.padStart(9)}   unit`)

for (const [name, unit] of Object.entries(SHAPES)) {
  const buf = repeatTo(unit, MB * 1024 * 1024)
  const dec = new TextDecoder()

  const once = () => {
    let pending = null
    let events = 0
    for (let off = 0; off < buf.length; off += CHUNK) {
      const r = scanOsc(buf.subarray(off, Math.min(off + CHUNK, buf.length)), pending, dec)
      pending = r.pending
      events += r.events.length
    }
    return events
  }

  once() // warm up
  let best = Infinity
  let events = 0
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint()
    events = once()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / 1e6)
  }
  const mb = buf.length / 1024 / 1024
  console.log(
    `${name.padEnd(14)} ${(best / mb).toFixed(3).padStart(8)} ${String(events).padStart(9)}   ${JSON.stringify(unit.slice(0, 24))}`,
  )
}
