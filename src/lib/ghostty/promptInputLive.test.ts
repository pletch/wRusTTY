import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PromptInputTracker } from '../promptInput'

/**
 * Reading the line being typed off a *real* grid, through a real core.
 *
 * `promptInput.test.ts` pins the logic against a fake whose rows are exactly
 * what the test wrote. This pins the assumptions that fake cannot check, and
 * they are the ones the whole approach rests on:
 *
 *   - **`cursorCell` and `readRowText` agree about coordinates.** One reports
 *     absolute buffer rows and the other indexes them; if they disagreed by
 *     the scrollback offset, every read would come from the wrong row and the
 *     fake would never notice.
 *   - **Wrapping is real.** The core decides when a line wraps, not the test.
 *     A wrapped command has to read back as one string.
 *   - **The prompt-relative origin survives scrolling.** Absolute coordinates
 *     are supposed to be stable as output pushes rows into scrollback; the
 *     whole design assumes an origin noted at `B` still names the same row a
 *     moment later.
 *   - **Columns are not characters.** A wide character in the typed line is
 *     where a character-indexed slice would silently drift.
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
    // Wired the way Terminal.tsx wires it: the same OSC handler feeds both
    // the command tracker and this one.
    engine.registerOscHandler(133, (data) => {
      tracker.handleOsc(data)
      return true
    })
    // Load-bearing: the `B` marker's origin is measured here, not in the OSC
    // handler, because the scanner dispatches OSC before the parser has drawn
    // the prompt the marker terminates.
    engine.onWriteParsed(() => tracker.noteParsed())
    return { engine, tracker }
  }

  /** A prompt, its OSC 133 `B` marker, then typed text — the ordinary case. */
  it('reads text typed after the prompt marker', async () => {
    const { engine, tracker } = await ready()
    expect(tracker.supported).toBe(true)
    engine.write('tim@host:~$ \x1b]133;B\x07')
    engine.write('git status')
    expect(tracker.read()?.text).toBe('git status')
    expect(tracker.read()?.atEnd).toBe(true)
  })

  it('reads a line the core wrapped for itself', async () => {
    // 20 columns, and a command comfortably longer than one row. Where it
    // wraps is the core's decision, which is the point of testing it here.
    const { engine, tracker } = await ready(20, 10)
    engine.write('$ \x1b]133;B\x07')
    engine.write('rsync -avz --dry-run src/ dst/')
    expect(tracker.read()?.text).toBe('rsync -avz --dry-run src/ dst/')
  })

  /**
   * The origin is noted in absolute coordinates precisely so that output
   * arriving afterwards cannot invalidate it. Here the prompt is pushed up the
   * screen by a full screenful of earlier output before anything is typed.
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
   * The property that makes this safe at a password prompt: the bytes were
   * typed, the far end echoed nothing, so the grid holds nothing and the read
   * is empty. Nothing here has to recognise a password prompt to get this
   * right.
   */
  it('reads nothing when the far end echoes nothing', async () => {
    const { engine, tracker } = await ready()
    engine.write("tim@host's password: \x1b]133;B\x07")
    // No echo written, which is what `read -s` looks like from out here.
    expect(tracker.read()?.text).toBe('')
  })

  it('stops reading once a command starts and resumes at the next prompt', async () => {
    const { engine, tracker } = await ready()
    // Prompt and marker in one write, the echo of typing in another, which is
    // the ordinary shape of it. The case where one write carries both is its
    // own test below.
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
    // Three columns left, as a left-arrow at a prompt would.
    engine.write('\x1b[3D')
    const input = tracker.read()
    expect(input?.text).toBe('git com')
    // ...and it must not be completed there, since appending would splice
    // text into the middle of the command.
    expect(input?.atEnd).toBe(false)
  })

  /**
   * The redraw readline does when the window is resized, and the regression
   * this file exists to catch.
   *
   * On SIGWINCH — and on `^L`, and after a job-control message — the shell
   * reprints the prompt *and* the line being edited, in one write. The prompt
   * carries the `B` marker, so that single chunk says "the input starts here"
   * and then keeps drawing. Measuring the origin at the end of the write puts
   * it at the end of the recalled command instead of at the prompt, and every
   * read afterwards returns a fragment of the line or nothing at all: the
   * history flicker blinked the tail of a wrapped command, and stopped
   * blinking entirely once the window was widened enough to unwrap it.
   *
   * The engine splits its parse at each dispatched OSC, so the handler runs at
   * exactly the right instant. This pins that the tracker measures there.
   */
  it('puts the origin at the prompt when one write redraws the whole line', async () => {
    const { engine, tracker } = await ready(20, 8)
    engine.write('$ \x1b]133;B\x07')
    engine.write('cat a.log | grep x | sort | uniq -c')
    const before = tracker.read()
    expect(before?.text).toBe('cat a.log | grep x | sort | uniq -c')

    // The whole line again — erase, prompt, marker, command — as one chunk.
    engine.write('\r\x1b[J$ \x1b]133;B\x07cat a.log | grep x | sort | uniq -c')
    const after = tracker.read()
    expect(after?.text).toBe('cat a.log | grep x | sort | uniq -c')
    expect(after?.origin.col).toBe(2)
    // The command wraps, so the origin is a row above the cursor. Reading the
    // origin off the end of the write would have collapsed the two onto the
    // last row and left nothing between them.
    expect(after!.cursor.row).toBe(after!.origin.row + 1)
  })

  /**
   * The same redraw, then the widening that follows it. The command now fits
   * on one row, and the origin still has to name the cell after the prompt —
   * an origin left on the old second row is *below* the cursor, which the read
   * can only answer with null.
   */
  it('still reads the line after a redraw and a widening', async () => {
    const { engine, tracker } = await ready(20, 8)
    engine.write('$ \x1b]133;B\x07cat a.log | grep x | sort | uniq -c')
    engine.resize(60, 8)
    // The shell redraws at the new width, as it does on SIGWINCH.
    engine.write('\r\x1b[J$ \x1b]133;B\x07cat a.log | grep x | sort | uniq -c')
    const input = tracker.read()
    expect(input?.text).toBe('cat a.log | grep x | sort | uniq -c')
    expect(input?.cursor.row).toBe(input?.origin.row)
  })
})
