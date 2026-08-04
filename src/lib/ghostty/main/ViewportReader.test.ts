import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'
import { MainViewportReader } from './ViewportReader'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  allocBuffer,
  CELL_BYTES,
  type GhosttyWasm,
} from '../wasmBindings'
import { PALETTE_16, PALETTE_256, DEFAULT_FG, DEFAULT_BG } from '../../../bench/gridPalette'

/**
 * The port's sharpest available check: the packed cell buffer produced by
 * `MainViewportReader` against the one `get_viewport` produces, **byte for
 * byte**, from the same input.
 *
 * `gridSnapshotMain.test.ts` compares interpreted snapshots and so can only
 * catch what a snapshot models. This compares the actual bytes the renderer
 * consumes, which is the thing that has to be right for the port to be a
 * no-op downstream — every consumer (renderer, search, links, selection, mark
 * mode) reads this buffer through the same `parseCellInto`.
 *
 * Skips without a comparison build; see `vendor-main/README.md`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_WASM = process.env.GHOSTTY_MAIN_WASM ?? join(here, 'vendor-main/ghostty-vt.wasm')
const VENDORED = join(here, '../vendor-131/ghostty-vt.wasm')

const COLS = 40
const ROWS = 8
const CELLS = COLS * ROWS

/** Bytes 12-13 are a hyperlink id our ABI packs and main's iterator cannot —
 * the one documented divergence. Blanked on both sides rather than skipped, so
 * every other byte of every cell still has to match exactly. */
function blankHyperlinkIds(buf: Uint8Array): Uint8Array {
  const out = buf.slice()
  for (let i = 0; i < out.length; i += CELL_BYTES) {
    out[i + 12] = 0
    out[i + 13] = 0
  }
  return out
}

const run = existsSync(MAIN_WASM) ? describe : describe.skip

run('MainViewportReader against get_viewport, byte for byte', () => {
  let vendored: Promise<GhosttyWasm> | null = null
  const loadVendored = () => (vendored ??= instantiateGhosttyWasm(readFileSync(VENDORED).buffer as ArrayBuffer))

  let mainMod: WebAssembly.Module | null = null
  const loadMain = () => (mainMod ??= new WebAssembly.Module(Uint8Array.from(readFileSync(MAIN_WASM))))

  async function viaVendored(input: string): Promise<Uint8Array> {
    const wasm = await loadVendored()
    const term = createTerminal(wasm, COLS, ROWS, {
      scrollbackLimit: 1024 * 1024,
      fgColor: DEFAULT_FG,
      bgColor: DEFAULT_BG,
      cursorColor: 0,
      palette: [...PALETTE_16],
    })
    if (term === 0) throw new Error('createTerminal failed')
    writeBytes(wasm, term, new TextEncoder().encode(input))
    wasm.exports.ghostty_render_state_update(term)
    const ptr = allocBuffer(wasm, CELLS * CELL_BYTES)
    new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).fill(0)
    wasm.exports.ghostty_render_state_get_viewport(term, ptr, CELLS)
    const out = new Uint8Array(wasm.exports.memory.buffer, ptr, CELLS * CELL_BYTES).slice()
    wasm.exports.ghostty_terminal_free(term)
    return out
  }

  function viaMain(input: string): Uint8Array {
    const inst = new WebAssembly.Instance(loadMain(), { env: { log: () => {} } })
    const ex = inst.exports as unknown as abi.GhosttyMainExports
    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_terminal_new(0, slot, COLS, ROWS), 'terminal_new')
    const term = new DataView(ex.memory.buffer).getUint32(slot, true)

    // Same palette and defaults as the vendored side, or no colour matches.
    const pal = ex.ghostty_wasm_alloc_u8_array(abi.PALETTE_BYTES)
    const bytes = new Uint8Array(ex.memory.buffer)
    for (let i = 0; i < abi.PALETTE_ENTRIES; i++) {
      const rgb = PALETTE_256[i]
      bytes[pal + i * 3] = (rgb >> 16) & 0xff
      bytes[pal + i * 3 + 1] = (rgb >> 8) & 0xff
      bytes[pal + i * 3 + 2] = rgb & 0xff
    }
    abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_COLOR_PALETTE, pal), 'set palette')
    const c = ex.ghostty_wasm_alloc_u8_array(3)
    const setColor = (key: number, rgb: number) => {
      const b = new Uint8Array(ex.memory.buffer)
      b[c] = (rgb >> 16) & 0xff
      b[c + 1] = (rgb >> 8) & 0xff
      b[c + 2] = rgb & 0xff
      abi.expectOk(ex.ghostty_terminal_set(term, key, c), 'set color')
    }
    setColor(abi.T_OPT_COLOR_FOREGROUND, DEFAULT_FG)
    setColor(abi.T_OPT_COLOR_BACKGROUND, DEFAULT_BG)

    const data = new TextEncoder().encode(input)
    const p = ex.ghostty_wasm_alloc_u8_array(data.length)
    new Uint8Array(ex.memory.buffer).set(data, p)
    ex.ghostty_terminal_vt_write(term, p, data.length)

    const buf = ex.ghostty_wasm_alloc_u8_array(CELLS * CELL_BYTES)
    new Uint8Array(ex.memory.buffer, buf, CELLS * CELL_BYTES).fill(0)
    const reader = new MainViewportReader({ ex, term })
    // Update and read are separate for the same reason the vendored side's are:
    // one snapshot answers the cells, the dimensions and the cursor.
    reader.update()
    reader.read(buf, COLS, ROWS)
    const out = new Uint8Array(ex.memory.buffer, buf, CELLS * CELL_BYTES).slice()
    reader.dispose()
    ex.ghostty_terminal_free(term)
    return out
  }

  const identical = async (name: string, input: string) => {
    const a = blankHyperlinkIds(await viaVendored(input))
    const b = blankHyperlinkIds(viaMain(input))
    // Report the first differing cell rather than dumping 5 KB of bytes.
    for (let i = 0; i < a.length; i += CELL_BYTES) {
      const av = Array.from(a.slice(i, i + CELL_BYTES))
      const bv = Array.from(b.slice(i, i + CELL_BYTES))
      if (av.join() !== bv.join()) {
        const cell = i / CELL_BYTES
        throw new Error(
          `${name}: cell ${cell} (row ${Math.floor(cell / COLS)}, col ${cell % COLS}) differs\n` +
            `  get_viewport: ${av.join(' ')}\n` +
            `  iterator    : ${bv.join(' ')}`,
        )
      }
    }
    expect(b).toEqual(a)
  }

  it('matches on plain text', () => identical('plain', 'hello world\r\nsecond line'))

  it('matches on every attribute', () =>
    identical(
      'attrs',
      '\x1b[1mb\x1b[0m\x1b[3mi\x1b[0m\x1b[4mu\x1b[0m\x1b[9ms\x1b[0m' +
        '\x1b[7mv\x1b[0m\x1b[8mh\x1b[0m\x1b[5mk\x1b[0m\x1b[2mf\x1b[0m',
    ))

  it('matches on underline styles and overline', () =>
    identical('underlines', '\x1b[4:1ma\x1b[4:2mb\x1b[4:3mc\x1b[4:4md\x1b[4:5me\x1b[0m\x1b[53mo\x1b[0m'))

  it('matches on palette colours', () =>
    identical('palette', '\x1b[31mr\x1b[32mg\x1b[44mB\x1b[0m \x1b[38;5;208mx\x1b[48;5;27my\x1b[0m'))

  it('matches on direct rgb colours', () =>
    identical('rgb', '\x1b[38;2;10;20;30mf\x1b[48;2;40;50;60mb\x1b[0m'))

  it('matches on untouched default cells', () => identical('defaults', 'plain, no sgr'))

  it('matches on wide glyphs, including the spacer cell', () =>
    identical('wide', 'a世界b\r\n漢字テスト'))

  // Written as explicit combining sequences: a literal é in source is the
  // precomposed U+00E9, a single codepoint that exercises no cluster handling
  // at all, and it passed while the grapheme mapping was still off by one.
  it('matches on combining marks', () =>
    identical('graphemes', 'é à ö ñ done'))

  it('matches on cleared regions, where the payload is a colour not a codepoint', () =>
    // EL/ED with a background set paint blanks whose colour lives in the cell's
    // content union. Reading that as a codepoint yields a control character.
    identical('cleared', '\x1b[44mtext\x1b[K\r\n\x1b[41mmore\x1b[K\x1b[0m'))

  it('matches after scrolling past the viewport', () => {
    let s = ''
    for (let i = 0; i < ROWS * 3; i++) s += `row ${i} of many\r\n`
    return identical('scrolled', s)
  })

  it('matches on a full styled screen', () => {
    let s = '\x1b[H'
    for (let r = 0; r < ROWS; r++) {
      s += `\x1b[38;5;${(r % 200) + 16}m`
      if (r % 3 === 0) s += '\x1b[1m'
      if (r % 4 === 0) s += '\x1b[4:3m'
      s += `line ${r} `.repeat(6).slice(0, COLS - 2)
      s += '\x1b[0m'
      if (r < ROWS - 1) s += '\r\n'
    }
    return identical('styled', s)
  })
})
