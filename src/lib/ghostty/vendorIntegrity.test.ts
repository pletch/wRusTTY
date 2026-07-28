import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Pins the vendored WASM to the exact artifact `vendor/README.md` documents.
 *
 * The binary parses untrusted bytes from every host you connect to, which makes
 * it the highest-value swap target in the tree, and it is an opaque 742 kB blob
 * that reviewing a diff cannot tell you anything about. A recorded hash is the
 * only check available.
 *
 * This lives in a test rather than in `tools/strip-wasm-debug.mjs`, which is
 * where it might look like it belongs: that script runs during *vendoring*, not
 * at build time (see its header), so an assertion there would only fire when
 * someone rebuilds the binary — precisely the moment the hash is supposed to
 * change. Here it runs on every `npm test` and every CI run, against a file
 * that is checked in and static, so it can only fail when something actually
 * moved.
 *
 * **A legitimate rebuild is supposed to fail this.** Update the constant and
 * `vendor/README.md` in the same commit as the new binary so the two can't
 * drift. A Zig rebuild isn't reproducible byte-for-byte across toolchains, so a
 * different hash after a real rebuild is expected — what this catches is the
 * binary moving when nobody rebuilt it.
 */

const EXPECTED_SHA256 = 'be419bfc5b6de37eb1768585aa4225039b9dacde56d429db1f53904af7775b0b'
const EXPECTED_BYTES = 742_403

const here = dirname(fileURLToPath(import.meta.url))
const WASM_PATH = join(here, 'vendor/ghostty-vt.wasm')

describe('the vendored ghostty-vt.wasm', () => {
  it('is the artifact vendor/README.md documents', () => {
    const bytes = readFileSync(WASM_PATH)
    const actual = createHash('sha256').update(bytes).digest('hex')
    expect(
      actual,
      'The vendored WASM does not match its recorded hash. If you rebuilt it ' +
        'deliberately, update EXPECTED_SHA256 here and the block in ' +
        'vendor/README.md in the same commit. If you did not, do not update ' +
        'either — find out why the file changed.',
    ).toBe(EXPECTED_SHA256)
  })

  /** Cheap, and it makes an accidental truncation say so in one line rather
   *  than as an unreadable hash mismatch. */
  it('is the documented size', () => {
    expect(readFileSync(WASM_PATH).byteLength).toBe(EXPECTED_BYTES)
  })

  /** The strip keeps the name section, and `tools/parse-probes/names.mjs`
   *  depends on it. A rebuild that dropped it would still hash-mismatch, but
   *  this says which property was lost. */
  it('still carries its name section after the DWARF strip', () => {
    const bytes = readFileSync(WASM_PATH)
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    expect(bytes.includes(Buffer.from('name', 'utf8'))).toBe(true)
    expect(
      bytes.includes(Buffer.from('.debug_', 'utf8')),
      'DWARF sections are present — was tools/strip-wasm-debug.mjs run?',
    ).toBe(false)
  })
})
