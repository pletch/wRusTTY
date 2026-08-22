import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'

/**
 * Proves `abi.ts` against a real ghostty `main` build, because almost nothing in
 * that file fails loudly when it is wrong.
 *
 * A mistyped key reads a different field of the same struct and returns a
 * plausible number. A wrong `GhosttyPoint` offset reads a real cell from the
 * wrong place. Neither raises. The only way to know the constants are right is
 * to drive the binary and compare against content we wrote ourselves — which is
 * what this does.
 *
 * ## The binary is not in the tree
 *
 * It is a 5 MB comparison artifact, not something we ship, so this suite skips
 * unless one is provided:
 *
 *   GHOSTTY_MAIN_WASM=/path/to/ghostty-vt.wasm npx vitest run abi.parity
 *
 * It must be built from the pin in `docs/PORT_GHOSTTY_MAIN.md`
 * (5851d98615187d85052e41042bcf66e0ccec11d4) with Zig 0.16.0. Skipping is
 * deliberate: CI has no such binary, and a suite that silently passed without
 * one would assert nothing while looking like coverage.
 */

const here = dirname(fileURLToPath(import.meta.url))
const envPath = process.env.GHOSTTY_MAIN_WASM
const fallback = join(here, 'vendor-main', 'ghostty-vt.wasm')
const wasmPath = envPath && existsSync(envPath) ? envPath : existsSync(fallback) ? fallback : null

const COLS = 80
const ROWS = 24

interface Harness {
  ex: abi.GhosttyMainExports
  dv(): DataView
  term: number
  write(s: string): void
  point(tag: number, x: number, y: number): number
  refPtr: number
  cellPtr: number
  outPtr: number
}

function boot(mod: WebAssembly.Module): Harness {
  const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
  const ex = inst.exports as unknown as abi.GhosttyMainExports
  const mem = ex.memory
  let view = new DataView(mem.buffer)
  // Linear memory growth detaches every view made against the old buffer, so
  // this is re-made rather than cached across a growth.
  const dv = () => {
    if (view.buffer !== mem.buffer) view = new DataView(mem.buffer)
    return view
  }

  const slot = ex.ghostty_wasm_alloc_opaque()
  abi.expectOk(ex.ghostty_terminal_new(0, slot, COLS, ROWS), 'terminal_new')
  const term = dv().getUint32(slot, true)

  const write = (s: string) => {
    const b = new TextEncoder().encode(s)
    const p = ex.ghostty_wasm_alloc(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    // Returns void; failures surface via T_DATA_VT_PROCESSING_ERROR.
    ex.ghostty_terminal_vt_write(term, p, b.length)
    ex.ghostty_wasm_free(p, b.length)
  }

  const ptPtr = ex.ghostty_wasm_alloc(abi.POINT_SIZE)
  const point = (tag: number, x: number, y: number) => {
    const d = dv()
    for (let i = 0; i < abi.POINT_SIZE; i += 4) d.setUint32(ptPtr + i, 0, true)
    d.setUint32(ptPtr + abi.POINT_OFF_TAG, tag, true)
    d.setUint32(ptPtr + abi.POINT_OFF_X, x, true)
    d.setUint32(ptPtr + abi.POINT_OFF_Y, y, true)
    return ptPtr
  }

  return {
    ex,
    dv,
    term,
    write,
    point,
    refPtr: ex.ghostty_wasm_alloc(abi.GRID_REF_SIZE),
    cellPtr: ex.ghostty_wasm_alloc(abi.CELL_U64_BYTES),
    outPtr: ex.ghostty_wasm_alloc(16),
  }
}

/** Reads a row through grid_ref, resolving once and stepping `ref.x`. */
function readRow(h: Harness, tag: number, y: number, cols = COLS): string {
  const r = h.ex.ghostty_terminal_grid_ref(h.term, h.point(tag, 0, y), h.refPtr)
  if (r !== abi.GHOSTTY_SUCCESS) return ''
  let s = ''
  const d = h.dv()
  for (let x = 0; x < cols; x++) {
    d.setUint16(h.refPtr + abi.GRID_REF_OFF_X, x, true)
    if (h.ex.ghostty_grid_ref_cell(h.refPtr, h.cellPtr) !== abi.GHOSTTY_SUCCESS) {
      s += ' '
      continue
    }
    const cp = abi.codepointOf(d.getUint32(h.cellPtr, true))
    s += cp > 0 ? String.fromCodePoint(cp) : ' '
  }
  return s.trimEnd()
}

const run = wasmPath ? describe : describe.skip

run('ghostty main ABI, against a build at the pin', () => {
  /**
   * Compiled once and lazily. Both halves matter: each `boot` only instantiates,
   * so a 5 MB module is not recompiled per test — and it must not be compiled at
   * collection time, because `describe.skip` still *runs* this body. Building
   * the module eagerly threw on the empty buffer whenever no binary was present,
   * which is precisely the CI case this suite is meant to skip in.
   */
  let cached: WebAssembly.Module | null = null
  const moduleOnce = (): WebAssembly.Module => {
    cached ??= new WebAssembly.Module(Uint8Array.from(readFileSync(wasmPath as string)))
    return cached
  }

  it('reads back what was written, which is what fixes the GhosttyPoint layout', () => {
    const h = boot(moduleOnce())
    h.write('hello world')
    // If POINT_OFF_X/Y were the header's apparent +4/+8, this reads a real cell
    // from the wrong place rather than failing — so the assertion is on content.
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 0)).toBe('hello world')
  })

  it('addresses distinct rows and columns independently', () => {
    const h = boot(moduleOnce())
    h.write('AAAA\r\nBBBB\r\nCCCC')
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 0)).toBe('AAAA')
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 1)).toBe('BBBB')
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 2)).toBe('CCCC')

    // Transposed offsets would make these agree; independent ones must not.
    abi.expectOk(
      h.ex.ghostty_terminal_grid_ref(h.term, h.point(abi.POINT_TAG_ACTIVE, 2, 1), h.refPtr),
      'grid_ref',
    )
    abi.expectOk(h.ex.ghostty_grid_ref_cell(h.refPtr, h.cellPtr), 'grid_ref_cell')
    const at21 = abi.codepointOf(h.dv().getUint32(h.cellPtr, true))
    expect(String.fromCodePoint(at21)).toBe('B')
  })

  it('unpacks the packed cell the same way ghostty_cell_get reads it', () => {
    const h = boot(moduleOnce())
    h.write('Zx')
    abi.expectOk(
      h.ex.ghostty_terminal_grid_ref(h.term, h.point(abi.POINT_TAG_ACTIVE, 0, 0), h.refPtr),
      'grid_ref',
    )
    abi.expectOk(h.ex.ghostty_grid_ref_cell(h.refPtr, h.cellPtr), 'grid_ref_cell')
    const lo = h.dv().getUint32(h.cellPtr, true)
    const hi = h.dv().getUint32(h.cellPtr + 4, true)

    // The JS unpack must agree with the accessor it exists to replace. If it
    // does not, every fast-path read is subtly wrong and nothing else notices.
    const cell = (BigInt(hi) << 32n) | BigInt(lo)
    abi.expectOk(h.ex.ghostty_cell_get(cell, abi.CELL_DATA_CODEPOINT, h.outPtr), 'cell_get')
    expect(abi.codepointOf(lo)).toBe(h.dv().getUint32(h.outPtr, true))
    expect(String.fromCodePoint(abi.codepointOf(lo))).toBe('Z')
  })

  it('reports cols and rows through the generic render-state getter', () => {
    const h = boot(moduleOnce())
    const slot = h.ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(h.ex.ghostty_render_state_new(0, slot), 'render_state_new')
    const state = h.dv().getUint32(slot, true)
    abi.expectOk(h.ex.ghostty_render_state_update(state, h.term), 'render_state_update')

    abi.expectOk(h.ex.ghostty_render_state_get(state, abi.RS_DATA_COLS, h.outPtr), 'get COLS')
    expect(h.dv().getUint32(h.outPtr, true)).toBe(COLS)
    abi.expectOk(h.ex.ghostty_render_state_get(state, abi.RS_DATA_ROWS, h.outPtr), 'get ROWS')
    expect(h.dv().getUint32(h.outPtr, true)).toBe(ROWS)
  })

  it('needs both scrollback caps set, not just the line one', () => {
    const h = boot(moduleOnce())
    const v = h.ex.ghostty_wasm_alloc(abi.USIZE_BYTES)
    h.dv().setUint32(v, 512 * 1024 * 1024, true)
    abi.expectOk(h.ex.ghostty_terminal_set(h.term, abi.T_OPT_SCROLLBACK_MAX_BYTES, v), 'set bytes')
    h.dv().setUint32(v, 6000, true)
    abi.expectOk(h.ex.ghostty_terminal_set(h.term, abi.T_OPT_SCROLLBACK_MAX_LINES, v), 'set lines')

    let s = ''
    for (let r = 0; r < 3000; r++) s += `line ${r}\r\n`
    h.write(s)

    abi.expectOk(h.ex.ghostty_terminal_get(h.term, abi.T_DATA_SCROLLBACK_ROWS, h.outPtr), 'get rows')
    const kept = h.dv().getUint32(h.outPtr, true)
    // With only MAX_LINES set this came back byte-pruned to a few hundred.
    expect(kept).toBeGreaterThan(2900)
    expect(readRow(h, abi.POINT_TAG_SCREEN, 0)).toBe('line 0')
    expect(readRow(h, abi.POINT_TAG_SCREEN, 1500)).toBe('line 1500')
  })

  /**
   * `GhosttyStyle`'s offsets were found by writing one attribute at a time and
   * seeing which byte moved, because the header's apparent layout is wrong —
   * the colour union is 8-aligned, so the booleans sit 20-odd bytes further
   * along than a naive reading puts them. These assert the answers.
   */
  describe('GhosttyStyle', () => {
    /** Style of the first cell after writing `seq` then one glyph. */
    const styleAfter = (seq: string) => {
      const h = boot(moduleOnce())
      const p = h.ex.ghostty_wasm_alloc(abi.STYLE_SIZE)
      h.write(`${seq}X`)
      const d = h.dv()
      for (let i = 0; i < abi.STYLE_SIZE; i += 4) d.setUint32(p + i, 0, true)
      d.setUint32(p + abi.STYLE_OFF_SIZE, abi.STYLE_SIZE, true) // versioned struct
      abi.expectOk(
        h.ex.ghostty_terminal_grid_ref(h.term, h.point(abi.POINT_TAG_ACTIVE, 0, 0), h.refPtr),
        'grid_ref',
      )
      abi.expectOk(h.ex.ghostty_grid_ref_style(h.refPtr, p), 'grid_ref_style')
      return { d: h.dv(), p }
    }

    it('reports the size it filled, which is how a layout change announces itself', () => {
      const { d, p } = styleAfter('')
      expect(d.getUint32(p + abi.STYLE_OFF_SIZE, true)).toBe(abi.STYLE_SIZE)
    })

    it.each([
      ['bold', '\x1b[1m', abi.STYLE_OFF_BOLD],
      ['italic', '\x1b[3m', abi.STYLE_OFF_ITALIC],
      ['faint', '\x1b[2m', abi.STYLE_OFF_FAINT],
      ['blink', '\x1b[5m', abi.STYLE_OFF_BLINK],
      ['inverse', '\x1b[7m', abi.STYLE_OFF_INVERSE],
      ['invisible', '\x1b[8m', abi.STYLE_OFF_INVISIBLE],
      ['strikethrough', '\x1b[9m', abi.STYLE_OFF_STRIKETHROUGH],
      ['overline', '\x1b[53m', abi.STYLE_OFF_OVERLINE],
    ])('sets %s and only %s', (_name, seq, offset) => {
      const { d, p } = styleAfter(seq)
      expect(d.getUint8(p + offset)).toBe(1)
      // Every other boolean must stay clear — an offset that is merely close
      // would otherwise pass by landing on a neighbour.
      for (const other of [
        abi.STYLE_OFF_BOLD, abi.STYLE_OFF_ITALIC, abi.STYLE_OFF_FAINT, abi.STYLE_OFF_BLINK,
        abi.STYLE_OFF_INVERSE, abi.STYLE_OFF_INVISIBLE, abi.STYLE_OFF_STRIKETHROUGH,
        abi.STYLE_OFF_OVERLINE,
      ]) {
        if (other !== offset) expect(d.getUint8(p + other)).toBe(0)
      }
    })

    it.each([
      ['single', '\x1b[4m', 1],
      ['double', '\x1b[4:2m', 2],
      ['curly', '\x1b[4:3m', 3],
      ['dotted', '\x1b[4:4m', 4],
      ['dashed', '\x1b[4:5m', 5],
    ])('carries %s underline as an int, not a flag', (_name, seq, expected) => {
      const { d, p } = styleAfter(seq)
      expect(d.getUint32(p + abi.STYLE_OFF_UNDERLINE_STYLE, true)).toBe(expected)
    })

    it('tags a palette colour apart from an rgb one', () => {
      const pal = styleAfter('\x1b[31m')
      expect(pal.d.getUint32(pal.p + abi.STYLE_OFF_FG_TAG, true)).toBe(abi.STYLE_COLOR_PALETTE)
      expect(pal.d.getUint8(pal.p + abi.STYLE_OFF_FG_VALUE)).toBe(1) // red

      const rgb = styleAfter('\x1b[38;2;10;20;30m')
      expect(rgb.d.getUint32(rgb.p + abi.STYLE_OFF_FG_TAG, true)).toBe(abi.STYLE_COLOR_RGB)
      expect(rgb.d.getUint8(rgb.p + abi.STYLE_OFF_FG_VALUE)).toBe(10)
      expect(rgb.d.getUint8(rgb.p + abi.STYLE_OFF_FG_VALUE + 1)).toBe(20)
      expect(rgb.d.getUint8(rgb.p + abi.STYLE_OFF_FG_VALUE + 2)).toBe(30)
    })

    it('keeps background in its own slot, not aliasing foreground', () => {
      const bg = styleAfter('\x1b[44m')
      expect(bg.d.getUint32(bg.p + abi.STYLE_OFF_BG_TAG, true)).toBe(abi.STYLE_COLOR_PALETTE)
      expect(bg.d.getUint8(bg.p + abi.STYLE_OFF_BG_VALUE)).toBe(4) // blue
      expect(bg.d.getUint32(bg.p + abi.STYLE_OFF_FG_TAG, true)).toBe(abi.STYLE_COLOR_NONE)
    })
  })

  /**
   * Swallows `ESC k` payloads, which is what `#176` is for.
   *
   * This assertion was the other way round until the patch existed: against a
   * stock `main` build `SCREENTITLE` reaches the grid, and that is how the fix
   * was confirmed to still be needed. It is inverted now because the binary
   * under `vendor-main/` is built **with** `patches/ghostty-main-esc-k.patch`.
   *
   * So this is the check that the patch actually applied, and it is a behaviour
   * rather than `git apply`'s exit code. If it fails after a rebuild, the patch
   * was skipped or silently no-op'd; if it fails against a build you believe is
   * unpatched, `#176` has landed upstream and can be dropped from the recipe.
   */
  it('swallows ESC k payloads, which is what #176 is carried for', () => {
    const h = boot(moduleOnce())
    h.write('\x1bkSCREENTITLE\x1b\\')
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 0)).not.toContain('SCREENTITLE')
  })

  it('keeps printing text that follows an ESC k sequence', () => {
    // The state has to exit, not just consume: a terminator that failed to
    // return to ground would swallow the rest of the stream, and the assertion
    // above would still pass.
    const h = boot(moduleOnce())
    h.write('\x1bktitle\x1b\\visible text')
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 0)).toBe('visible text')
  })

  it('exits an ESC k sequence terminated by BEL as well as ST', () => {
    const h = boot(moduleOnce())
    h.write('\x1bktitle\x07after bel')
    expect(readRow(h, abi.POINT_TAG_ACTIVE, 0)).toBe('after bel')
  })
})
