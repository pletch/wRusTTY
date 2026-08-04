import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'
import { MainScrollbackReader } from './ScrollbackReader'
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
 * `MainScrollbackReader.readRow` against `get_scrollback_line`, byte for byte.
 *
 * The colour cases carry the weight here. Unlike the render iterator, `grid_ref`
 * has no resolved-colour accessor, so this reader flattens colour itself — style
 * for foreground, cell content tag ahead of style for background — and that
 * order is invisible on ordinary text. A cleared region is where it shows.
 */

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_WASM = process.env.GHOSTTY_MAIN_WASM ?? join(here, 'vendor-main/ghostty-vt.wasm')
const VENDORED = join(here, '../vendor-131/ghostty-vt.wasm')

const COLS = 40
const ROWS = 6
/** Enough to push plenty above the active screen. */
const FILL_ROWS = 60

function blankHyperlinkIds(buf: Uint8Array): Uint8Array {
  const out = buf.slice()
  for (let i = 0; i < out.length; i += CELL_BYTES) {
    out[i + 12] = 0
    out[i + 13] = 0
  }
  return out
}

const run = existsSync(MAIN_WASM) ? describe : describe.skip

run('MainScrollbackReader against get_scrollback_line, byte for byte', () => {
  let vendored: Promise<GhosttyWasm> | null = null
  const loadVendored = () => (vendored ??= instantiateGhosttyWasm(readFileSync(VENDORED).buffer as ArrayBuffer))
  let mainMod: WebAssembly.Module | null = null
  const loadMain = () => (mainMod ??= new WebAssembly.Module(Uint8Array.from(readFileSync(MAIN_WASM))))

  async function viaVendored(input: string) {
    const wasm = await loadVendored()
    const term = createTerminal(wasm, COLS, ROWS, {
      scrollbackLimit: 16 * 1024 * 1024,
      fgColor: DEFAULT_FG,
      bgColor: DEFAULT_BG,
      cursorColor: 0,
      palette: [...PALETTE_16],
    })
    if (term === 0) throw new Error('createTerminal failed')
    writeBytes(wasm, term, new TextEncoder().encode(input))
    // Required: scrollback rows read through RenderState.row_data, so without
    // this every row comes back blank — the trap that inverted search.mjs.
    wasm.exports.ghostty_render_state_update(term)
    const count = wasm.exports.ghostty_terminal_get_scrollback_length(term)
    const ptr = allocBuffer(wasm, COLS * CELL_BYTES)
    const rows: Uint8Array[] = []
    for (let y = 0; y < count; y++) {
      new Uint8Array(wasm.exports.memory.buffer, ptr, COLS * CELL_BYTES).fill(0)
      wasm.exports.ghostty_terminal_get_scrollback_line(term, y, ptr, COLS)
      rows.push(new Uint8Array(wasm.exports.memory.buffer, ptr, COLS * CELL_BYTES).slice())
    }
    wasm.exports.ghostty_terminal_free(term)
    return rows
  }

  function viaMain(input: string) {
    const inst = new WebAssembly.Instance(loadMain(), { env: { log: () => {} } })
    const ex = inst.exports as unknown as abi.GhosttyMainExports
    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_terminal_new(0, slot, COLS, ROWS), 'terminal_new')
    const term = new DataView(ex.memory.buffer).getUint32(slot, true)

    const v = ex.ghostty_wasm_alloc_usize()
    new DataView(ex.memory.buffer).setUint32(v, 512 * 1024 * 1024, true)
    abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_SCROLLBACK_MAX_BYTES, v), 'set sb bytes')
    new DataView(ex.memory.buffer).setUint32(v, 100000, true)
    abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_SCROLLBACK_MAX_LINES, v), 'set sb lines')

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

    const out = ex.ghostty_wasm_alloc_u8_array(16)
    abi.expectOk(ex.ghostty_terminal_get(term, abi.T_DATA_SCROLLBACK_ROWS, out), 'get sb rows')
    const count = new DataView(ex.memory.buffer).getUint32(out, true)

    const buf = ex.ghostty_wasm_alloc_u8_array(COLS * CELL_BYTES)
    const reader = new MainScrollbackReader({ ex, term })
    const rows: Uint8Array[] = []
    for (let y = 0; y < count; y++) {
      new Uint8Array(ex.memory.buffer, buf, COLS * CELL_BYTES).fill(0)
      reader.readRow(buf, y, COLS)
      rows.push(new Uint8Array(ex.memory.buffer, buf, COLS * CELL_BYTES).slice())
    }
    reader.dispose()
    ex.ghostty_terminal_free(term)
    return rows
  }

  const identical = async (name: string, input: string) => {
    const a = await viaVendored(input)
    const b = viaMain(input)
    expect(b.length, `${name}: scrollback row count`).toBe(a.length)
    expect(a.length).toBeGreaterThan(0)
    for (let y = 0; y < a.length; y++) {
      const ra = blankHyperlinkIds(a[y])
      const rb = blankHyperlinkIds(b[y])
      for (let i = 0; i < ra.length; i += CELL_BYTES) {
        const av = Array.from(ra.slice(i, i + CELL_BYTES))
        const bv = Array.from(rb.slice(i, i + CELL_BYTES))
        if (av.join() !== bv.join()) {
          throw new Error(
            `${name}: scrollback row ${y}, col ${i / CELL_BYTES} differs\n` +
              `  get_scrollback_line: ${av.join(' ')}\n` +
              `  grid_ref           : ${bv.join(' ')}`,
          )
        }
      }
    }
  }

  const filler = (n: number, decorate = (s: string, _i: number) => s) => {
    let s = ''
    for (let i = 0; i < n; i++) s += `${decorate(`row ${i} content here`, i)}\r\n`
    return s
  }

  it('matches on plain scrolled text', () => identical('plain', filler(FILL_ROWS)))

  it('matches on styled scrollback', () =>
    identical(
      'styled',
      filler(FILL_ROWS, (s, i) => `\x1b[${(i % 7) + 31}m${i % 3 === 0 ? '\x1b[1m' : ''}${s}\x1b[0m`),
    ))

  it('matches on underline styles held across the scroll', () =>
    identical('underline', filler(FILL_ROWS, (s, i) => `\x1b[4:${(i % 5) + 1}m${s}\x1b[0m`)))

  it('matches on direct rgb in scrollback', () =>
    identical('rgb', filler(FILL_ROWS, (s, i) => `\x1b[38;2;${i % 256};20;30m${s}\x1b[0m`)))

  it('matches on background-coloured rows, where the flattening order shows', () =>
    identical('bg', filler(FILL_ROWS, (s, i) => `\x1b[4${(i % 7) + 1}m${s}\x1b[0m`)))

  it('matches on cleared regions, which carry colour on the cell not the style', () => {
    // EL with a background set paints blanks whose colour lives in the cell's
    // content tag rather than in any style. Taking the style first would read
    // these as default and look entirely reasonable.
    let s = ''
    for (let i = 0; i < FILL_ROWS; i++) s += `\x1b[4${(i % 6) + 1}mtext\x1b[K\x1b[0m\r\n`
    return identical('cleared', s)
  })

  it('matches on wide glyphs in scrollback', () =>
    identical('wide', filler(FILL_ROWS, (s, i) => (i % 2 ? `世界 ${s}` : s))))

  it('matches on combining marks in scrollback', () =>
    identical('graphemes', filler(FILL_ROWS, (s, i) => (i % 2 ? `é à ${s}` : s))))

  it('returns grapheme codepoints base-first, as the vendored call does', async () => {
    // Every row, not alternating ones: the assertion below is about a specific
    // scrollback row, and making it depend on row parity lining up with the
    // scroll offset is how this first failed.
    const input = filler(FILL_ROWS, (s) => `é ${s}`)
    const wasm = await loadVendored()
    const term = createTerminal(wasm, COLS, ROWS, {
      scrollbackLimit: 16 * 1024 * 1024,
      fgColor: DEFAULT_FG,
      bgColor: DEFAULT_BG,
      cursorColor: 0,
      palette: [...PALETTE_16],
    })
    writeBytes(wasm, term, new TextEncoder().encode(input))
    wasm.exports.ghostty_render_state_update(term)
    const gp = allocBuffer(wasm, 16 * 4)
    const n = wasm.exports.ghostty_terminal_get_scrollback_grapheme(term, 1, 0, gp, 16)
    const oldCps: number[] = []
    for (let i = 0; i < n; i++) {
      oldCps.push(new DataView(wasm.exports.memory.buffer).getUint32(gp + i * 4, true))
    }
    wasm.exports.ghostty_terminal_free(term)

    const inst = new WebAssembly.Instance(loadMain(), { env: { log: () => {} } })
    const ex = inst.exports as unknown as abi.GhosttyMainExports
    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_terminal_new(0, slot, COLS, ROWS), 'terminal_new')
    const t2 = new DataView(ex.memory.buffer).getUint32(slot, true)
    const v = ex.ghostty_wasm_alloc_usize()
    new DataView(ex.memory.buffer).setUint32(v, 512 * 1024 * 1024, true)
    ex.ghostty_terminal_set(t2, abi.T_OPT_SCROLLBACK_MAX_BYTES, v)
    new DataView(ex.memory.buffer).setUint32(v, 100000, true)
    ex.ghostty_terminal_set(t2, abi.T_OPT_SCROLLBACK_MAX_LINES, v)
    const data = new TextEncoder().encode(input)
    const p = ex.ghostty_wasm_alloc_u8_array(data.length)
    new Uint8Array(ex.memory.buffer).set(data, p)
    ex.ghostty_terminal_vt_write(t2, p, data.length)

    const reader = new MainScrollbackReader({ ex, term: t2 })
    const gbuf = ex.ghostty_wasm_alloc_u8_array(16 * 4)
    const m = reader.graphemes(1, 0, gbuf, 16)
    const newCps: number[] = []
    for (let i = 0; i < m; i++) {
      newCps.push(new DataView(ex.memory.buffer).getUint32(gbuf + i * 4, true))
    }
    reader.dispose()
    ex.ghostty_terminal_free(t2)

    expect(newCps).toEqual(oldCps)
    expect(oldCps.length).toBeGreaterThan(1) // the case is only meaningful with a cluster
  })
})
