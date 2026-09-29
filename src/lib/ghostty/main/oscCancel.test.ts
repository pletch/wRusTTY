import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'

/**
 * CAN (0x18) and SUB (0x1A) cancel an OSC in progress: the command is dropped,
 * and what follows is ordinary output. Upstream `520d8f55a`; before it the core
 * ran the command as though the OSC had ended normally, so
 * `ESC ] 2 ; title CAN` still set the title. xterm discards it, and the DEC
 * parser says CAN and SUB cancel any control string in progress.
 *
 * `oscScanner.test.ts` holds our own scanner to the same rule, since the app
 * acts on several OSCs from the scanner rather than from the core.
 *
 * Against the shipped binary, so it runs on CI. `GHOSTTY_VT_WASM` points it at
 * another build.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = process.env.GHOSTTY_VT_WASM ?? join(here, '../vendor/ghostty-vt.wasm')

function boot() {
  const mod = new WebAssembly.Module(Uint8Array.from(readFileSync(WASM)))
  const ex = new WebAssembly.Instance(mod, { env: { log: () => {} } }).exports as unknown as abi.GhosttyMainExports
  const slot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_terminal_new(0, slot, 40, 4), 'terminal_new')
  const term = new DataView(ex.memory.buffer).getUint32(slot, true)
  const out = ex.ghostty_wasm_alloc(16)
  const write = (s: string) => {
    const b = new TextEncoder().encode(s)
    const p = ex.ghostty_wasm_alloc(b.length)
    new Uint8Array(ex.memory.buffer).set(b, p)
    ex.ghostty_terminal_vt_write(term, p, b.length)
    ex.ghostty_wasm_free(p, b.length)
  }
  /** `GhosttyString` is `{ ptr, len }`, two words on wasm32. */
  const title = () => {
    if (ex.ghostty_terminal_get(term, abi.T_DATA_TITLE, out) !== abi.GHOSTTY_SUCCESS) return ''
    const dv = new DataView(ex.memory.buffer)
    const ptr = dv.getUint32(out, true)
    const len = dv.getUint32(out + 4, true)
    return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len))
  }
  return { write, title }
}

describe('CAN and SUB cancel an OSC in the core', () => {
  it('drops a title cancelled with CAN', () => {
    const t = boot()
    t.write('\x1b]2;kept\x07')
    t.write('\x1b]2;cancelled\x18')
    expect(t.title()).toBe('kept')
  })

  it('drops a title cancelled with SUB', () => {
    const t = boot()
    t.write('\x1b]2;kept\x07')
    t.write('\x1b]2;cancelled\x1a')
    expect(t.title()).toBe('kept')
  })

  it('still runs one that ends normally, including after a cancelled one', () => {
    const t = boot()
    t.write('\x1b]2;cancelled\x18\x1b]2;real\x07')
    expect(t.title()).toBe('real')
  })
})
