#!/usr/bin/env node
// Removes the DWARF custom sections from a .wasm, keeping the `name` section.
//
// The vendored `ghostty-vt.wasm` is built with full debug info, and 77.5% of it
// is `.debug_*` — 2.56 MB of the 3.30 MB file, against 538 kB of actual code.
// None of it is read by anything in this repo: `tools/parse-probes/names.mjs`
// walks the section table until it finds `name`, parses subsection 1, and never
// touches a `.debug_*` section. V8's tick attribution for WASM reads the name
// section too, so the profiling workflow the debug build exists for survives
// this intact. DWARF only buys source-level stepping through DevTools' C/C++
// debugging extension, which is a dev-machine concern and not worth 2.5 MB in
// every installer.
//
// This is a script rather than `llvm-objcopy --remove-section='.debug_*'`
// because the repo has no LLVM or wabt dependency and this needs to be
// repeatable by whoever next bumps the vendored binary. A WASM section table is
// a flat list of (id, size, payload) — custom sections are id 0 with a leading
// name — so dropping some of them is a copy with holes, not a rewrite.
//
//   node tools/strip-wasm-debug.mjs in.wasm out.wasm
//
// Run it as part of the vendoring step in `patches/README.md`, not at build
// time: the checked-in binary is the stripped one.

import fs from 'node:fs'

/** LEB128, the only variable-width thing between us and the next section. */
function readVarUint32(buf, offset) {
  let result = 0
  let shift = 0
  let byte
  do {
    byte = buf[offset++]
    result |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  return { value: result >>> 0, offset }
}

export function stripDebugSections(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('not a wasm module (bad magic)')
  }

  // The 8-byte header (magic + version) is always kept.
  const kept = [buf.subarray(0, 8)]
  const removed = []
  let offset = 8

  while (offset < buf.length) {
    const sectionStart = offset
    const id = buf[offset++]
    const { value: payloadSize, offset: afterSize } = readVarUint32(buf, offset)
    const payloadStart = afterSize
    const sectionEnd = payloadStart + payloadSize

    let name = null
    if (id === 0) {
      const { value: nameLen, offset: afterNameLen } = readVarUint32(buf, payloadStart)
      name = buf.toString('utf8', afterNameLen, afterNameLen + nameLen)
    }

    // Only `.debug_*` goes. `name`, `producers` and `target_features` are all
    // custom sections too, and all three are either used or harmless.
    if (name !== null && name.startsWith('.debug_')) {
      removed.push({ name, bytes: sectionEnd - sectionStart })
    } else {
      kept.push(buf.subarray(sectionStart, sectionEnd))
    }

    offset = sectionEnd
  }

  return { output: Buffer.concat(kept), removed }
}

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('usage: node tools/strip-wasm-debug.mjs <in.wasm> <out.wasm>')
  process.exit(1)
}

const source = fs.readFileSync(input)
const { output: stripped, removed } = stripDebugSections(source)

for (const section of removed) {
  console.log(`  removed ${section.name.padEnd(18)} ${section.bytes.toLocaleString()} bytes`)
}
const saved = source.length - stripped.length
console.log(
  `${input}: ${source.length.toLocaleString()} -> ${stripped.length.toLocaleString()} bytes ` +
    `(-${saved.toLocaleString()}, ${((100 * saved) / source.length).toFixed(1)}%)`,
)

fs.writeFileSync(output, stripped)
