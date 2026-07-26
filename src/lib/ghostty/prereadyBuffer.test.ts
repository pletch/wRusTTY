import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Imported dynamically, never statically: `vi.resetModules` below gives the
// engine a fresh module graph, and writePhases keeps module-level state. A
// static import here would be a *different* copy from the one the engine
// records into, and the recording assertions would silently see nothing.
type Phases = typeof import('../writePhases')

/**
 * What a Ghostty pane does with output that arrives before its core has loaded.
 *
 * This is the failure that produced a published parse figure roughly 3x too
 * fast. A core that never resolves leaves `wasm` null and `fatalError` null
 * forever, so every write takes the buffering path: it returns promptly having
 * parsed nothing, keeps a copy of every byte, and enters no phase timer — so
 * the instrument divides all the bytes by the time spent parsing none of them.
 * The pane is blank, the numbers are excellent, and nothing is logged.
 *
 * The core is stubbed to never load, which is exactly the state being pinned.
 */
describe('writes that arrive before the core is ready', () => {
  let phases: Phases | null = null

  beforeEach(() => {
    vi.resetModules()
    phases = null
    // A fetch that never settles: initWasm stays pending, so `wasm` is null for
    // the life of the engine and no error is ever raised by the load itself.
    vi.stubGlobal('fetch', () => new Promise(() => {}))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    phases?.stop()
    phases?.reset()
  })

  /** The recorder from the engine's own module graph. */
  async function recorder(): Promise<Phases> {
    phases = await import('../writePhases')
    return phases
  }

  async function newEngine() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const errors: string[] = []
    engine.onInitError((m) => errors.push(m))
    return { engine, errors }
  }

  it('holds a modest burst without complaint — the core may still be coming', async () => {
    const { engine, errors } = await newEngine()
    engine.write(new Uint8Array(64 * 1024))
    expect(errors).toEqual([])
  })

  it('gives up, loudly, once far more has arrived than a boot burst', async () => {
    const { engine, errors } = await newEngine()
    engine.write(new Uint8Array(2 * 1024 * 1024))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('never finished loading')
    // The consequence is stated, not just the cause: the reader's real question
    // is whether anything they saw was real.
    expect(errors[0]).toContain('has been parsed')
  })

  /**
   * The bound exists to stop a flood from being retained in full. Feeding well
   * past it must not keep growing the buffer, and must not raise repeatedly —
   * a dead engine reporting once per delivery is its own kind of unusable.
   */
  it('reports once and stops accumulating, however much follows', async () => {
    const { engine, errors } = await newEngine()
    for (let i = 0; i < 12; i++) engine.write(new Uint8Array(1024 * 1024))
    expect(errors).toHaveLength(1)
  })

  /**
   * The phase report has to be able to tell this apart from a fast parse. Bytes
   * that were only buffered are counted separately so the throughput line can
   * be marked invalid instead of celebrated.
   */
  it('tells the instrument the bytes were never parsed', async () => {
    const rec = await recorder()
    rec.start()
    const { engine } = await newEngine()
    engine.write(new Uint8Array(256 * 1024))

    const s = rec.snapshot()
    expect(s.unparsedBytes).toBe(256 * 1024)
    expect(s.totals.coreWrite).toBe(0)
    expect(rec.formatReport()).toContain('INVALID')
  })
})
