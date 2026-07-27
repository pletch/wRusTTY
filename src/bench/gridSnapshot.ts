/**
 * Feeds a byte stream through each engine with no DOM/WebGL involved at all,
 * and reads back what ended up on screen — grid *state*, not pixels. Per the
 * plan this is what actually regresses: not "do the two engines draw
 * identical pixels" (out of scope — see WebGLRenderer, untested on purpose)
 * but "do they agree about what the terminal contains" after the same bytes.
 *
 * Ghostty's WASM core exposes render-state queries independent of
 * WebGLRenderer (`ghostty_render_state_*`), and xterm.js's buffer is usable
 * without ever calling `open()` — so both sides run with no canvas, no GL
 * context, and no jsdom.
 *
 * A snapshot covers glyphs, layout, cursor, **per-cell colours and text
 * attributes**. The colours are only meaningful because both engines are
 * pinned to one palette first — see gridPalette.ts for why that is a
 * precondition rather than a convenience.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Terminal as XTerm } from '@xterm/xterm'
import type { IBufferCell } from '@xterm/xterm'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  allocBuffer,
  freeBuffer,
  parseCellInto,
  emptyCell,
  CELL_BYTES,
  CELL_BOLD,
  CELL_ITALIC,
  CELL_UNDERLINE,
  CELL_STRIKETHROUGH,
  CELL_INVERSE,
  CELL_INVISIBLE,
  CELL_BLINK,
  CELL_FAINT,
  CELL2_OVERLINE,
  CELL2_UNDERLINE_MASK,
  type GhosttyWasm,
} from '../lib/ghostty/wasmBindings'
import { PALETTE_16, PALETTE_256, DEFAULT_FG, DEFAULT_BG } from './gridPalette'

const here = dirname(fileURLToPath(import.meta.url))
const WASM_PATH = join(here, '../lib/ghostty/vendor/ghostty-vt.wasm')

let wasmModule: Promise<GhosttyWasm> | null = null
/** Compiling the module is the expensive part; every snapshot in a test run
 * shares one compiled module, each with its own terminal instance. */
function loadWasm(): Promise<GhosttyWasm> {
  if (!wasmModule) wasmModule = instantiateGhosttyWasm(readFileSync(WASM_PATH).buffer as ArrayBuffer)
  return wasmModule
}

/** Attributes the two engines both surface, on the CELL_* bit positions so a
 * ghostty flags byte is already in this form. Overline and the underline
 * variants live in `COMPARED_ATTRS2` below rather than here, because they are
 * a second byte and only one of them has an oracle; including them would compare xterm
 * against a constant zero and read as a divergence every time. */
export const COMPARED_ATTRS =
  CELL_BOLD | CELL_ITALIC | CELL_UNDERLINE | CELL_STRIKETHROUGH |
  CELL_INVERSE | CELL_INVISIBLE | CELL_BLINK | CELL_FAINT

/**
 * The second attribute byte, compared separately because only part of it has an
 * oracle. xterm exposes `isOverline()`, so overline is a real parity check; it
 * does not expose *which* underline is drawn, so the underline style in bits
 * 0-2 is only populated on the ghostty side and must not be compared —
 * `gridSnapshot.test.ts` asserts that directly against the SGR that set it.
 */
export const COMPARED_ATTRS2 = CELL2_OVERLINE

export interface GridSnapshot {
  /** One string per row, trailing whitespace trimmed (the customary way to
   * compare terminal grid content — trailing blank cells aren't meaningful). */
  rows: string[]
  /** Per-row foreground colours as 0xRRGGBB, index-aligned with `rows`:
   * `fg[y][i]` is the colour of `rows[y][i]`. A wide glyph contributes one
   * entry, matching how `rows` folds its continuation cell away, and the row
   * is truncated to the trimmed string's length for the same reason `rows` is
   * trimmed — a trailing blank cell's colour is not something the two engines
   * meaningfully agree or disagree about. */
  fg: number[][]
  bg: number[][]
  /** Per-row attribute bitsets over COMPARED_ATTRS, aligned as `fg` is. */
  flags: number[][]
  /** Per-row second attribute byte: underline style and overline. */
  attrs2: number[][]
  cursorX: number
  cursorY: number
}

export interface SnapshotInput {
  setup?: Uint8Array
  events: Uint8Array[]
  cols: number
  rows: number
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Trims a row to its last non-space character and truncates the parallel
 * attribute arrays to match, so every index of `rows[y]` has a colour and a
 * flag set at the same index and nothing beyond it does. */
function trimRow(line: string, fg: number[], bg: number[], flags: number[]) {
  const trimmed = line.replace(/\s+$/, '')
  fg.length = trimmed.length
  bg.length = trimmed.length
  flags.length = trimmed.length
  return trimmed
}

export async function snapshotViaGhostty(input: SnapshotInput): Promise<GridSnapshot> {
  const { cols, rows } = input
  const wasm = await loadWasm()
  const termPtr = createTerminal(wasm, cols, rows, {
    scrollbackLimit: 1024 * 1024,
    // Pinned rather than left at the core's own defaults so the colours read
    // back here are comparable with xterm's — see gridPalette.ts.
    fgColor: DEFAULT_FG,
    bgColor: DEFAULT_BG,
    cursorColor: 0,
    palette: [...PALETTE_16],
  })
  if (termPtr === 0) throw new Error('ghostty_terminal_new_with_config failed')

  if (input.setup) writeBytes(wasm, termPtr, input.setup)
  writeBytes(wasm, termPtr, concat(input.events))
  wasm.exports.ghostty_render_state_update(termPtr)

  const cellCount = cols * rows
  const cellsPtr = allocBuffer(wasm, cellCount * CELL_BYTES)
  try {
    const written = wasm.exports.ghostty_render_state_get_viewport(termPtr, cellsPtr, cellCount)
    if (written < 0) throw new Error('ghostty_render_state_get_viewport failed')
    const view = new DataView(wasm.exports.memory.buffer, cellsPtr, cellCount * CELL_BYTES)

    const outRows: string[] = []
    const outFg: number[][] = []
    const outBg: number[][] = []
    const outFlags: number[][] = []
    const outAttrs2: number[][] = []
    const cell = emptyCell()
    for (let y = 0; y < rows; y++) {
      let line = ''
      const fg: number[] = []
      const bg: number[] = []
      const flags: number[] = []
      const attrs2: number[] = []
      let x = 0
      while (x < cols) {
        parseCellInto(view, (y * cols + x) * CELL_BYTES, cell)
        line += cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)
        fg.push((cell.fgR << 16) | (cell.fgG << 8) | cell.fgB)
        bg.push((cell.bgR << 16) | (cell.bgG << 8) | cell.bgB)
        flags.push(cell.flags & COMPARED_ATTRS)
        attrs2.push(cell.attrs2 & (COMPARED_ATTRS2 | CELL2_UNDERLINE_MASK))
        // A wide glyph occupies two grid cells; the second is a spacer with
        // no codepoint of its own, matching how xterm's translateToString
        // already folds a wide character's continuation cell away.
        x += cell.width === 2 ? 2 : 1
      }
      outRows.push(trimRow(line, fg, bg, flags))
      outFg.push(fg)
      outBg.push(bg)
      outFlags.push(flags)
      outAttrs2.push(attrs2)
    }

    return {
      rows: outRows,
      fg: outFg,
      bg: outBg,
      flags: outFlags,
      attrs2: outAttrs2,
      cursorX: wasm.exports.ghostty_render_state_get_cursor_x(termPtr),
      cursorY: wasm.exports.ghostty_render_state_get_cursor_y(termPtr),
    }
  } finally {
    freeBuffer(wasm, cellsPtr, cellCount * CELL_BYTES)
    wasm.exports.ghostty_terminal_free(termPtr)
  }
}

/** xterm reports a colour as one of three modes; only the palette case needs
 * the shared table, and only the default case needs to agree with what
 * ghostty was configured with. */
function xtermColor(
  isDefault: boolean,
  isPalette: boolean,
  raw: number,
  fallback: number,
): number {
  if (isDefault) return fallback
  if (isPalette) return PALETTE_256[raw] ?? fallback
  return raw & 0xffffff
}

function xtermFlags(cell: IBufferCell): number {
  // xterm's predicates return the attribute's raw bits rather than a boolean,
  // so each is compared against zero and re-encoded on the CELL_* positions
  // ghostty already uses. `isDim` is ghostty's `faint`.
  let f = 0
  if (cell.isBold() !== 0) f |= CELL_BOLD
  if (cell.isItalic() !== 0) f |= CELL_ITALIC
  if (cell.isUnderline() !== 0) f |= CELL_UNDERLINE
  if (cell.isStrikethrough() !== 0) f |= CELL_STRIKETHROUGH
  if (cell.isInverse() !== 0) f |= CELL_INVERSE
  if (cell.isInvisible() !== 0) f |= CELL_INVISIBLE
  if (cell.isBlink() !== 0) f |= CELL_BLINK
  if (cell.isDim() !== 0) f |= CELL_FAINT
  return f
}

/** Only overline: xterm's buffer API has no accessor for the underline style. */
function xtermAttrs2(cell: IBufferCell): number {
  return cell.isOverline() !== 0 ? CELL2_OVERLINE : 0
}

export async function snapshotViaXterm(input: SnapshotInput): Promise<GridSnapshot> {
  const { cols, rows } = input
  const term = new XTerm({ cols, rows, allowProposedApi: true })
  try {
    if (input.setup) await new Promise<void>((r) => term.write(input.setup!, () => r()))
    await new Promise<void>((r) => term.write(concat(input.events), () => r()))

    const buf = term.buffer.active
    const outRows: string[] = []
    const outFg: number[][] = []
    const outBg: number[][] = []
    const outFlags: number[][] = []
    const outAttrs2: number[][] = []
    const scratch = buf.getNullCell()
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.viewportY + y)
      const text = line?.translateToString(true) ?? ''
      const fg: number[] = []
      const bg: number[] = []
      const flags: number[] = []
      const attrs2: number[] = []
      // Walked with the same wide-character stride the ghostty side uses, so
      // the arrays stay index-aligned with `translateToString`'s output —
      // which likewise emits one character for a wide glyph's two cells.
      // The `line` null-check is a guard, not a loop condition — hoisted out
      // so the `while` tests only what the body actually advances.
      if (line) {
        let x = 0
        while (x < cols) {
          const cell = line.getCell(x, scratch)
          if (!cell) break
          fg.push(xtermColor(cell.isFgDefault(), cell.isFgPalette(), cell.getFgColor(), DEFAULT_FG))
          bg.push(xtermColor(cell.isBgDefault(), cell.isBgPalette(), cell.getBgColor(), DEFAULT_BG))
          flags.push(xtermFlags(cell))
          attrs2.push(xtermAttrs2(cell))
          x += cell.getWidth() === 2 ? 2 : 1
        }
      }
      outRows.push(trimRow(text, fg, bg, flags))
      outFg.push(fg)
      outBg.push(bg)
      outFlags.push(flags)
      outAttrs2.push(attrs2)
    }
    return {
      rows: outRows,
      fg: outFg,
      bg: outBg,
      flags: outFlags,
      attrs2: outAttrs2,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
    }
  } finally {
    term.dispose()
  }
}
