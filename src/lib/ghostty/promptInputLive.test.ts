import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PromptInputTracker } from '../promptInput'

/**
 * Reading the typed line off a real grid through a real core, pinning what
 * `promptInput.test.ts`'s fake can't:
 *
 *   - **`cursorCell` and `readRowText` agree about coordinates** (both
 *     absolute; a scrollback offset between them would read the wrong row).
 *   - **Wrapping is real**: the core decides, and a wrapped command reads back
 *     as one string.
 *   - **The prompt-relative origin survives scrolling.**
 *   - **Columns aren't characters**: a wide character would drift a
 *     character-indexed slice.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
  wasm: unknown
}

describe('reading the prompt line off a live grid', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function ready(cols = 40, rows = 10) {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr || !inner.wasm) throw new Error('core did not load')
    engine.resize(cols, rows)

    const tracker = new PromptInputTracker(engine)
    // Wired as in Terminal.tsx: one OSC handler feeds both trackers.
    engine.registerOscHandler(133, (data) => {
      tracker.handleOsc(data)
      return true
    })
    // The `B` origin is measured after parsing, since OSC dispatches before the
    // prompt it terminates is drawn.
    engine.onWriteParsed(() => tracker.noteParsed())
    return { engine, tracker }
  }

  /** A prompt, its OSC 133 `B` marker, then typed text. */
  it('reads text typed after the prompt marker', async () => {
    const { engine, tracker } = await ready()
    expect(tracker.supported).toBe(true)
    engine.write('dev@host:~$ \x1b]133;B\x07')
    engine.write('git status')
    expect(tracker.read()?.text).toBe('git status')
    expect(tracker.read()?.atEnd).toBe(true)
  })

  it('reads a line the core wrapped for itself', async () => {
    // A command longer than one row of 20; the core decides where it wraps.
    const { engine, tracker } = await ready(20, 10)
    engine.write('$ \x1b]133;B\x07')
    engine.write('rsync -avz --dry-run src/ dst/')
    expect(tracker.read()?.text).toBe('rsync -avz --dry-run src/ dst/')
  })

  /**
   * The origin is absolute, so output pushing the prompt up a full screen
   * doesn't invalidate it.
   */
  it('keeps its origin as the screen scrolls', async () => {
    const { engine, tracker } = await ready(40, 6)
    for (let i = 0; i < 20; i++) engine.write(`line ${i}\r\n`)
    engine.write('$ \x1b]133;B\x07')
    for (let i = 0; i < 0; i++) engine.write('')
    engine.write('make test')
    expect(tracker.read()?.text).toBe('make test')
  })

  it('slices by column across a wide character', async () => {
    const { engine, tracker } = await ready()
    engine.write('$ \x1b]133;B\x07')
    engine.write('echo 世界 ok')
    expect(tracker.read()?.text).toBe('echo 世界 ok')
  })

  /**
   * At a password prompt the far end echoes nothing, so the read is empty,
   * without recognizing the prompt.
   */
  it('reads nothing when the far end echoes nothing', async () => {
    const { engine, tracker } = await ready()
    engine.write("dev@host's password: \x1b]133;B\x07")
    // No echo, as with `read -s`.
    expect(tracker.read()?.text).toBe('')
  })

  it('stops reading once a command starts and resumes at the next prompt', async () => {
    const { engine, tracker } = await ready()
    // Prompt and marker in one write, typing in another (the ordinary shape).
    engine.write('$ \x1b]133;B\x07')
    engine.write('make')
    expect(tracker.read()?.text).toBe('make')

    engine.write('\x1b]133;C\x07\r\nbuilding...\r\n')
    expect(tracker.read()).toBeNull()

    engine.write('\x1b]133;D;0\x07$ \x1b]133;B\x07')
    engine.write('ls')
    expect(tracker.read()?.text).toBe('ls')
  })

  it('reads only up to the cursor after it is moved back into the line', async () => {
    const { engine, tracker } = await ready()
    engine.write('$ \x1b]133;B\x07')
    engine.write('git commit')
    // Three columns left, like a left-arrow.
    engine.write('\x1b[3D')
    const input = tracker.read()
    expect(input?.text).toBe('git com')
    // Not completable mid-line, which would splice into the command.
    expect(input?.atEnd).toBe(false)
  })

  /**
   * Readline's redraw on SIGWINCH (and `^L`, and after job-control messages)
   * reprints the prompt, `B` marker and line in one write. The engine splits
   * its parse at each OSC so the tracker measures the origin at the prompt, not
   * at the end of the write.
   */
  it('puts the origin at the prompt when one write redraws the whole line', async () => {
    const { engine, tracker } = await ready(20, 8)
    engine.write('$ \x1b]133;B\x07')
    engine.write('cat a.log | grep x | sort | uniq -c')
    const before = tracker.read()
    expect(before?.text).toBe('cat a.log | grep x | sort | uniq -c')

    // Erase, prompt, marker and command as one chunk.
    engine.write('\r\x1b[J$ \x1b]133;B\x07cat a.log | grep x | sort | uniq -c')
    const after = tracker.read()
    expect(after?.text).toBe('cat a.log | grep x | sort | uniq -c')
    expect(after?.origin.col).toBe(2)
    // The command wraps, so the origin is a row above the cursor.
    expect(after!.cursor.row).toBe(after!.origin.row + 1)
  })

  /**
   * The same redraw, then a widening: the command fits one row, and the origin
   * must still name the cell after the prompt (an origin below the cursor reads
   * as null).
   */
  it('still reads the line after a redraw and a widening', async () => {
    const { engine, tracker } = await ready(20, 8)
    engine.write('$ \x1b]133;B\x07cat a.log | grep x | sort | uniq -c')
    engine.resize(60, 8)
    // The shell redraws at the new width, as on SIGWINCH.
    engine.write('\r\x1b[J$ \x1b]133;B\x07cat a.log | grep x | sort | uniq -c')
    const input = tracker.read()
    expect(input?.text).toBe('cat a.log | grep x | sort | uniq -c')
    expect(input?.cursor.row).toBe(input?.origin.row)
  })
})
