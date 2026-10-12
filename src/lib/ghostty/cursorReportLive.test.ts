import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createTerminal, instantiateGhosttyWasm, readResponse, writeString } from './wasmBindings'

/**
 * The shipped core answers a cursor position report, reached the way the
 * engine reaches it (`main/effects.test.ts` covers the raw ABI).
 *
 * ConPTY opens with `ESC [ 6 n` and emits nothing until answered, so without
 * a reply a local pane's shell never starts. The core generates it,
 * `GhosttyEngine.drainResponses` drains it, and it goes out with keystrokes.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, 'vendor/ghostty-vt.wasm')

const COLS = 80
const ROWS = 24

async function boot() {
  const bytes = readFileSync(WASM)
  const wasm = await instantiateGhosttyWasm(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  const term = createTerminal(wasm, COLS, ROWS, {
    // A byte budget, not a line count.
    scrollbackLimit: 4 * 1024 * 1024,
    fgColor: 0xcccccc,
    bgColor: 0x000000,
    cursorColor: 0,
  })
  if (!term) throw new Error('createTerminal returned 0')
  return { wasm, term }
}

function drain(wasm: Awaited<ReturnType<typeof boot>>['wasm'], term: number): string {
  let out = ''
  for (;;) {
    const chunk = readResponse(wasm, term)
    if (!chunk) return out
    out += new TextDecoder().decode(chunk)
  }
}

describe('cursor position report from the shipped core', () => {
  it('answers ESC[6n, which is what lets a local shell start', async () => {
    const { wasm, term } = await boot()
    writeString(wasm, term, '\x1b[6n')

    // Something must come back, or every local pane opens blank. Taken apart
    // rather than regex-matched, since the linter rejects an ESC in a pattern.
    const reply = drain(wasm, term)
    expect(reply.startsWith('\x1b[')).toBe(true)
    expect(reply.endsWith('R')).toBe(true)
    expect(reply.slice(2, -1)).toMatch(/^\d+;\d+$/)
  })

  it('reports where the cursor actually is, not a fixed position', async () => {
    const { wasm, term } = await boot()
    // Somewhere unambiguous, so a hardcoded `1;1R` fails. CPR is 1-based.
    writeString(wasm, term, '\x1b[5;9H\x1b[6n')

    expect(drain(wasm, term)).toBe('\x1b[5;9R')
  })

  it('answers every query in a burst rather than only the first', async () => {
    const { wasm, term } = await boot()
    // ConPTY may ask more than once; every query needs an answer.
    writeString(wasm, term, '\x1b[6n\x1b[6n')

    expect(drain(wasm, term)).toBe('\x1b[1;1R\x1b[1;1R')
  })
})
