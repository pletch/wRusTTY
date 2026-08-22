import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseOsc9, parseOsc777, ProgressTracker } from '../appProgress'
import type { AppProgress } from '../appProgress'
import { CommandTracker } from '../shellIntegration'
import { MODE_BRACKETED_PASTE, type GhosttyWasm } from './wasmBindings'
import type { CommandActivity } from '../shellIntegration'

/**
 * A program's own progress report reaching the pane, through a real engine and
 * a real core.
 *
 * `appProgress.test.ts` pins the grammar; this pins that the sequences carrying
 * it are actually recognised as OSC by the scanner and dispatched — which is
 * not free of assumptions. OSC 9 is the shortest identifier this app handles
 * and OSC 777 the longest, so between them they cover the digit-run parsing,
 * and progress arrives interleaved with an application's normal screen output
 * rather than on a chunk boundary of its own.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
}

describe('an application reporting its own progress over the wire', () => {
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

  /** A live core with nothing registered on it. */
  async function boot() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr) throw new Error('core did not load')
    return engine
  }

  async function ready() {
    const engine = await boot()

    const progress: (AppProgress | null)[] = []
    const notes: string[] = []
    engine.registerOscHandler(9, (data) => {
      const result = parseOsc9(data)
      if (result.kind === 'progress') progress.push(result.progress)
      if (result.kind === 'notify') notes.push(result.notification.body)
      return true
    })
    engine.registerOscHandler(777, (data) => {
      const note = parseOsc777(data)
      if (note) notes.push(note.body)
      return note !== null
    })

    const writeInChunks = (data: string, chunk: number) => {
      for (let i = 0; i < data.length; i += chunk) engine.write(data.slice(i, i + chunk))
    }
    return { engine, progress, notes, writeInChunks }
  }

  it('delivers a busy-then-done cycle amongst ordinary output', async () => {
    const { engine, progress } = await ready()
    // What a full-screen tool actually emits: progress wrapped in the screen
    // painting it is doing anyway, not sitting alone in a chunk.
    engine.write('\x1b[2J\x1b[H\x1b]9;4;3\x07working...\r\n')
    engine.write('done\r\n\x1b]9;4;0\x07')
    expect(progress).toEqual([{ state: 'active', percent: null }, null])
    engine.dispose()
  })

  it('delivers a determinate report split across deliveries', async () => {
    const { engine, progress, writeInChunks } = await ready()
    // One byte at a time is the worst case the coalescer can hand over, and
    // the case that exercises the scanner's carried-over pending buffer for
    // every byte of the sequence.
    writeInChunks('\x1b]9;4;1;40\x07', 1)
    expect(progress).toEqual([{ state: 'active', percent: 40 }])
    engine.dispose()
  })

  /**
   * The whole path for a report the program never clears: the engine
   * recognising `ESC c` in the stream, the tracker's watch being open at that
   * moment, and the indicator coming down.
   *
   * Worth a live test rather than only the unit ones either side of it,
   * because the two halves have to agree about a cost: the engine hunts for
   * `ESC c` only while a handler is registered, and the tracker registers one
   * only while a report is up. Get that backwards in either place and this
   * still compiles — it just never fires.
   */
  it('drops a report the program abandoned with a full reset', async () => {
    // `boot()` rather than `ready()`: that helper claims OSC 9 for itself, and
    // a claimed ident stops every later handler for it.
    const engine = await boot()
    const changes: (AppProgress | null)[] = []
    const completions: number[] = []
    const tracker = new ProgressTracker({
      onChange: (p) => changes.push(p),
      onComplete: (ms) => completions.push(ms),
      watchReset: (cb) => engine.registerResetHandler(cb),
    })
    engine.registerOscHandler(9, (data) => {
      const result = parseOsc9(data)
      if (result.kind === 'progress') tracker.set(result.progress)
      return true
    })

    engine.write('\x1b]9;4;3\x07working...')
    expect(changes).toEqual([{ state: 'active', percent: null }])

    // `reset` at the shell, or a full-screen program taking the terminal.
    engine.write('\x1bc')
    expect(changes).toEqual([{ state: 'active', percent: null }, null])
    // Abandoned, not finished — so no "your job is done" marker.
    expect(completions).toEqual([])

    // And the watch is down again: a second reset has nothing to clear and
    // must not re-report.
    engine.write('\x1bc')
    expect(changes).toHaveLength(2)
    tracker.dispose()
    engine.dispose()
  })

  it('still lets the reset through to the core when nothing is watching', async () => {
    // The other half of the gate: with no report showing, nothing registers a
    // reset handler and the scanner never hunts for `ESC c` — but the bytes
    // must still reach the core, which is what actually performs the reset.
    // Bracketed paste stands in for "any state a RIS clears" because it is the
    // one mode this engine can be asked about directly.
    const engine = await boot()
    const inner = engine as unknown as Internals & { wasm: GhosttyWasm }
    const bracketed = () =>
      inner.wasm.exports.ghostty_terminal_get_mode(inner.termPtr, MODE_BRACKETED_PASTE, 0) !== 0

    engine.write('\x1b[?2004h')
    expect(bracketed()).toBe(true)
    engine.write('\x1bc')
    expect(bracketed()).toBe(false)
    engine.dispose()
  })

  it('delivers notifications under both identifiers', async () => {
    const { engine, notes } = await ready()
    // ST-terminated rather than BEL, which is the other legal framing and the
    // one a longer identifier is more likely to be written with.
    engine.write('\x1b]777;notify;Backup;finished in 4m\x1b\\')
    engine.write('\x1b]9;backup finished\x07')
    expect(notes).toEqual(['finished in 4m', 'backup finished'])
    engine.dispose()
  })
})

/**
 * The same program on the two hosts it behaves differently on, replayed in the
 * order captured session logs put the sequences in.
 *
 * Claude Code over SSH switches to the alternate screen on one host and never
 * does on the other, and that decides whether the shell's run marker is ever
 * suppressed. Both shapes have to leave the pane quiet between turns, and in
 * the second one only the progress reports can deliver that.
 */
describe('a long-lived program reporting turns inside one shell command', () => {
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
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** An engine wired the way Terminal.tsx wires one: OSC 9 into the progress
   * reader and the tracker's takeover, OSC 133 into the tracker, and the
   * screen-buffer switch into setAltScreen. */
  async function pane() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr) throw new Error('core did not load')

    const activity: CommandActivity[] = []
    const tracker = new CommandTracker({
      onChange: (a) => activity.push(a),
      onComplete: () => {},
    })
    let progress: AppProgress | null = null
    engine.registerOscHandler(9, (data) => {
      const result = parseOsc9(data)
      if (result.kind === 'progress') {
        progress = result.progress
        tracker.noteProgress()
      }
      return true
    })
    engine.registerOscHandler(133, (data) => tracker.handleOsc(data))
    engine.onBufferChange((isAlternate) => tracker.setAltScreen(isAlternate))

    // What the tab strip would draw: the union of the shell's run and the
    // program's own progress, the way TabBar builds it.
    const marker = () => activity[activity.length - 1]?.state === 'running' || progress !== null
    return { engine, marker }
  }

  it('leaves the pane quiet between turns when the program never switches buffers', async () => {
    // office-pc: `]133;C` at byte 336, no `[?1049h` anywhere, `]133;D` at
    // 22335. Nothing stands the run down, so this pane swept for the entire
    // session before the progress takeover existed.
    const { engine, marker } = await pane()
    vi.useFakeTimers()
    engine.write('\x1b]133;C\x07')
    engine.write('\x1b]0;claude\x07')
    vi.advanceTimersByTime(400)
    expect(marker()).toBe(true) // launching, with nothing reported yet

    engine.write('\x1b]9;4;0\x07') // Claude Code's opening clear
    expect(marker()).toBe(false)

    engine.write('\x1b]9;4;3\x07working\r\n')
    expect(marker()).toBe(true) // a turn

    engine.write('done\r\n\x1b]9;4;0\x07')
    vi.advanceTimersByTime(10_000)
    expect(marker()).toBe(false) // between turns, with the run still open

    engine.write('\x1b]133;D;0\x07')
    expect(marker()).toBe(false)
    engine.dispose()
  })

  it('behaves the same when the program does switch buffers', async () => {
    // code-dev: `]133;C` at 255, `[?1049h` at 2111, the turn's progress at
    // 6798 and 8109, `[?1049l` at 12730, `]133;D` at 13103. The alternate
    // screen already stood the run down here, and the takeover must not
    // disturb what that host already does correctly.
    const { engine, marker } = await pane()
    vi.useFakeTimers()
    engine.write('\x1b]133;C\x07')
    engine.write('\x1b[?1049h\x1b[H')
    vi.advanceTimersByTime(400)
    expect(marker()).toBe(false)

    engine.write('\x1b]9;4;0\x07')
    engine.write('\x1b]9;4;3\x07')
    expect(marker()).toBe(true)

    engine.write('\x1b]9;4;0\x07')
    vi.advanceTimersByTime(10_000)
    expect(marker()).toBe(false)

    engine.write('\x1b[?1049l')
    engine.write('\x1b]133;D;0\x07')
    vi.advanceTimersByTime(1000)
    expect(marker()).toBe(false)
    engine.dispose()
  })
})
