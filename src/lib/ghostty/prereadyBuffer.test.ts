import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Imported dynamically: `vi.resetModules` gives the engine a fresh module
// graph, and a static import would be a different writePhases copy.
type Phases = typeof import('../writePhases')

/**
 * Output arriving before a pane's core has loaded. A core that never resolves
 * leaves every write on the buffering path: nothing parsed, no phase timed, a
 * blank pane and excellent-looking numbers. The core is stubbed never to load.
 */
describe('writes that arrive before the core is ready', () => {
  let phases: Phases | null = null

  beforeEach(() => {
    vi.resetModules()
    phases = null
    // A fetch that never settles, so `wasm` stays null without an error.
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    // Enough DOM for teardown; nothing is mounted.
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
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
    // The message states the consequence: nothing was parsed.
    expect(errors[0]).toContain('has been parsed')
  })

  /**
   * Feeding past the bound neither grows the buffer nor reports more than once.
   */
  it('reports once and stops accumulating, however much follows', async () => {
    const { engine, errors } = await newEngine()
    for (let i = 0; i < 12; i++) engine.write(new Uint8Array(1024 * 1024))
    expect(errors).toHaveLength(1)
  })

  /**
   * Every live engine is counted (engines surviving a hot reload each hold
   * their own linear memory).
   */
  it('counts every live engine, and stops counting a disposed one', async () => {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const a = new GhosttyEngine()
    const b = new GhosttyEngine()
    expect(GhosttyEngine.diagnostics().engines).toBe(2)
    // No core loaded, so no terminal or linear memory.
    expect(GhosttyEngine.diagnostics().terminals).toBe(0)
    expect(GhosttyEngine.diagnostics().wasmBytes).toBe(0)

    a.dispose()
    expect(GhosttyEngine.diagnostics().engines).toBe(1)
    b.dispose()
    expect(GhosttyEngine.diagnostics().engines).toBe(0)
  })

  /**
   * A devtools flood targets the pane most recently on screen.
   */
  it('targets no pane when none exists, and the visible one when it does', async () => {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    expect(GhosttyEngine.activeEngine()).toBeNull()
    const a = new GhosttyEngine()
    expect(GhosttyEngine.activeEngine()).toBe(a)
    const b = new GhosttyEngine()
    // Neither has been on screen, so the choice is stable.
    expect([a, b]).toContain(GhosttyEngine.activeEngine())
    a.dispose()
    b.dispose()
    expect(GhosttyEngine.activeEngine()).toBeNull()
  })

  it('reports the page state alongside the throughput figure', async () => {
    const rec = await recorder()
    rec.start()
    const { engine } = await newEngine()
    engine.write(new Uint8Array(1024))
    // Registered by the engine's constructor, so every report carries it.
    expect(rec.formatReport()).toContain('1 live engine(s)')
  })

  /**
   * Buffered-only bytes are counted separately, so the throughput line is
   * marked invalid.
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
