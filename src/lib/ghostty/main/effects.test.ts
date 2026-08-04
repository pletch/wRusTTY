import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'
import { MainEffects } from './effects'
import { instantiateGhosttyWasm, readResponse, writeString, createTerminal } from '../wasmBindings'

/**
 * Query responses through `OPT_WRITE_PTY`, checked against what the vendored
 * queue answers for the same query.
 *
 * The first test is the one that matters most, and it asserts a *negative*:
 * without the callback installed, `vt_write` answers nothing. That is `main`'s
 * documented default and the reason this step is the dangerous one — a port
 * that skips it produces a screen that is correct in every visible respect
 * while every program that asks the terminal a question waits out its timeout.
 */

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_WASM = process.env.GHOSTTY_MAIN_WASM ?? join(here, 'vendor-main/ghostty-vt.wasm')
const VENDORED = join(here, '../vendor/ghostty-vt.wasm')

const COLS = 80
const ROWS = 24

const run = existsSync(MAIN_WASM) ? describe : describe.skip

run('query responses via OPT_WRITE_PTY', () => {
  let mainMod: WebAssembly.Module | null = null
  const loadMain = () => (mainMod ??= new WebAssembly.Module(Uint8Array.from(readFileSync(MAIN_WASM))))

  function boot() {
    const inst = new WebAssembly.Instance(loadMain(), { env: { log: () => {} } })
    const ex = inst.exports as unknown as abi.GhosttyMainExports & {
      __indirect_function_table: WebAssembly.Table
    }
    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_terminal_new(0, slot, COLS, ROWS), 'terminal_new')
    const term = new DataView(ex.memory.buffer).getUint32(slot, true)
    const write = (s: string) => {
      const b = new TextEncoder().encode(s)
      const p = ex.ghostty_wasm_alloc_u8_array(b.length)
      new Uint8Array(ex.memory.buffer).set(b, p)
      ex.ghostty_terminal_vt_write(term, p, b.length)
      ex.ghostty_wasm_free_u8_array(p, b.length)
    }
    return { ex, term, write }
  }

  const decode = (chunks: Uint8Array[]) =>
    chunks.map((c) => new TextDecoder().decode(c))

  it('answers nothing until the callback is installed — the silent default', () => {
    const { ex, term, write } = boot()
    // No MainEffects here. If a future ghostty starts answering by default this
    // fails, which is the right way to find that out.
    write('\x1b[6n\x1b[c\x1b[5n')
    const effects = new MainEffects({ ex, term })
    expect(effects.takeResponses()).toEqual([])
    effects.dispose()
  })

  it('answers a cursor position report once installed', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('\x1b[6n')
    expect(decode(effects.takeResponses())).toEqual(['\x1b[1;1R'])
    effects.dispose()
  })

  it('reports the cursor where it actually is', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('hello\r\nworld')
    effects.takeResponses()
    write('\x1b[6n')
    expect(decode(effects.takeResponses())).toEqual(['\x1b[2;6R'])
    effects.dispose()
  })

  it('answers primary device attributes', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('\x1b[c')
    expect(decode(effects.takeResponses())).toEqual(['\x1b[?62;22c'])
    effects.dispose()
  })

  it('answers a device status report', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('\x1b[5n')
    expect(decode(effects.takeResponses())).toEqual(['\x1b[0n'])
    effects.dispose()
  })

  it('keeps several replies from one write separate and ordered', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('\x1b[6n\x1b[c\x1b[5n')
    expect(decode(effects.takeResponses())).toEqual(['\x1b[1;1R', '\x1b[?62;22c', '\x1b[0n'])
    effects.dispose()
  })

  it('empties on take, so a second call does not repeat the replies', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('\x1b[6n')
    expect(effects.takeResponses()).toHaveLength(1)
    expect(effects.takeResponses()).toEqual([])
    effects.dispose()
  })

  it('copies the bytes, so a later write cannot rewrite an earlier reply', () => {
    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write('\x1b[6n')
    write('\x1b[9;20H\x1b[6n')
    // If the callback handed back a view over wasm memory rather than a copy,
    // the first reply would have been overwritten by the second.
    expect(decode(effects.takeResponses())).toEqual(['\x1b[1;1R', '\x1b[9;20R'])
    effects.dispose()
  })

  it('returns its table slot on dispose, so panes do not leak entries', () => {
    const { ex, term } = boot()
    const table = ex.__indirect_function_table
    const first = new MainEffects({ ex, term })
    const grown = table.length
    first.dispose()
    const second = new MainEffects({ ex, term })
    // The recycled slot means the table did not have to grow again.
    expect(table.length).toBe(grown)
    second.dispose()
  })

  it('matches what the vendored queue answers for the same queries', async () => {
    const queries = '\x1b[6n\x1b[c\x1b[5n'

    const wasm = await instantiateGhosttyWasm(readFileSync(VENDORED).buffer as ArrayBuffer)
    const vterm = createTerminal(wasm, COLS, ROWS, {
      scrollbackLimit: 1024 * 1024,
      fgColor: 0xffffff,
      bgColor: 0,
      cursorColor: 0,
      palette: [],
    })
    writeString(wasm, vterm, queries)
    const old: string[] = []
    for (let i = 0; i < 64; i++) {
      const r = readResponse(wasm, vterm)
      if (!r || r.length === 0) break
      old.push(new TextDecoder().decode(r))
    }
    wasm.exports.ghostty_terminal_free(vterm)

    const { ex, term, write } = boot()
    const effects = new MainEffects({ ex, term })
    write(queries)
    const neu = decode(effects.takeResponses())
    effects.dispose()

    // The vendored side may coalesce replies into one drain; compare the bytes
    // rather than the chunking, which is not part of the contract.
    expect(neu.join('')).toBe(old.join(''))
  })
})
