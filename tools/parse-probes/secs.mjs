import { readFileSync } from 'fs'
const b = readFileSync(process.argv[2])
let o = 8
const NAMES = { 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'elem', 10: 'code', 11: 'data', 12: 'datacount' }
function leb() { let r = 0, s = 0, by; do { by = b[o++]; r |= (by & 0x7f) << s; s += 7 } while (by & 0x80); return r >>> 0 }
while (o < b.length) {
  const id = b[o++]; const size = leb(); const start = o
  let label = NAMES[id] || ('id' + id)
  if (id === 0) { const nl = leb(); label = 'custom:' + b.toString('utf8', o, o + nl) }
  console.log(String(label).padEnd(24), (size / 1024).toFixed(1).padStart(9) + ' KB')
  o = start + size
}
