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
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Terminal as XTerm } from '@xterm/xterm'
import {
  instantiateGhosttyWasm,
  createTerminal,
  writeBytes,
  allocBuffer,
  freeBuffer,
  parseCell,
  CELL_BYTES,
  type GhosttyWasm,
} from '../lib/ghostty/wasmBindings'

const here = dirname(fileURLToPath(import.meta.url))
const WASM_PATH = join(here, '../lib/ghostty/vendor/ghostty-vt.wasm')

let wasmModule: Promise<GhosttyWasm> | null = null
/** Compiling the module is the expensive part; every snapshot in a test run
 * shares one compiled module, each with its own terminal instance. */
function loadWasm(): Promise<GhosttyWasm> {
  if (!wasmModule) wasmModule = instantiateGhosttyWasm(readFileSync(WASM_PATH).buffer as ArrayBuffer)
  return wasmModule
}

export interface GridSnapshot {
  /** One string per row, trailing whitespace trimmed (the customary way to
   * compare terminal grid content — trailing blank cells aren't meaningful). */
  rows: string[]
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

export async function snapshotViaGhostty(input: SnapshotInput): Promise<GridSnapshot> {
  const { cols, rows } = input
  const wasm = await loadWasm()
  const termPtr = createTerminal(wasm, cols, rows, {
    scrollbackLimit: 1024 * 1024,
    fgColor: 0,
    bgColor: 0,
    cursorColor: 0,
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
    for (let y = 0; y < rows; y++) {
      let line = ''
      let x = 0
      while (x < cols) {
        const cell = parseCell(view, (y * cols + x) * CELL_BYTES)
        line += cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)
        // A wide glyph occupies two grid cells; the second is a spacer with
        // no codepoint of its own, matching how xterm's translateToString
        // already folds a wide character's continuation cell away.
        x += cell.width === 2 ? 2 : 1
      }
      outRows.push(line.replace(/\s+$/, ''))
    }

    return {
      rows: outRows,
      cursorX: wasm.exports.ghostty_render_state_get_cursor_x(termPtr),
      cursorY: wasm.exports.ghostty_render_state_get_cursor_y(termPtr),
    }
  } finally {
    freeBuffer(wasm, cellsPtr, cellCount * CELL_BYTES)
    wasm.exports.ghostty_terminal_free(termPtr)
  }
}

export async function snapshotViaXterm(input: SnapshotInput): Promise<GridSnapshot> {
  const { cols, rows } = input
  const term = new XTerm({ cols, rows, allowProposedApi: true })
  try {
    if (input.setup) await new Promise<void>((r) => term.write(input.setup!, () => r()))
    await new Promise<void>((r) => term.write(concat(input.events), () => r()))

    const buf = term.buffer.active
    const outRows: string[] = []
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.viewportY + y)
      outRows.push((line?.translateToString(true) ?? '').replace(/\s+$/, ''))
    }
    return { rows: outRows, cursorX: buf.cursorX, cursorY: buf.cursorY }
  } finally {
    term.dispose()
  }
}
