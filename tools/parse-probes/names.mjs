import { readFileSync } from 'fs'
const b = readFileSync(process.argv[2])
const filter = (process.argv[3] ?? '').toLowerCase()
let o = 8
function leb() { let r = 0, s = 0, by; do { by = b[o++]; r |= (by & 0x7f) << s; s += 7 } while (by & 0x80); return r >>> 0 }
let names = null
while (o < b.length) {
  const id = b[o++]; const size = leb(); const start = o
  if (id === 0) {
    const nl = leb(); const nm = b.toString('utf8', o, o + nl); o += nl
    if (nm === 'name') names = { end: start + size }
    else o = start + size
    if (names && names.end) break
  } else o = start + size
}
if (!names) { console.log('no name section'); process.exit(1) }
const out = []
while (o < names.end) {
  const sub = b[o++]; const ssize = leb(); const sstart = o
  if (sub === 1) { // function names
    const count = leb()
    for (let i = 0; i < count; i++) { const idx = leb(); const nl = leb(); out.push([idx, b.toString('utf8', o, o + nl)]); o += nl }
  }
  o = sstart + ssize
}
const hits = out.filter(([, n]) => n.toLowerCase().includes(filter))
console.log(`${hits.length} / ${out.length} functions`)
for (const [i, n] of hits) console.log(String(i).padStart(5), n)
