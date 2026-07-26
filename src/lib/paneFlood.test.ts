import { describe, it, expect } from 'vitest'
import { formatFloodReport } from './paneFlood'

const info = { bytes: 100 * 1048576, cols: 174, rows: 38, wallMs: 4110 }

/**
 * The check that the measurement itself is sound.
 *
 * V8 runs WebAssembly in a debuggable tier while DevTools is open, which cost
 * 2.75x on this build — 11.14 ms/MB closed against 30.65 open, one page,
 * nothing else changed. Both recorders used to be reachable only from the
 * console, so every production figure taken during the Phase 7 investigation
 * was measured in that tier, and the resulting "the live pane is 2.7x slower
 * than the harness" gap was chased through the workload, the grid, the
 * scrollback, the transport, the backend and the page state before anyone
 * suspected the instrument.
 *
 * So the report says it itself, and it says it before the numbers rather than
 * after them.
 */
describe('pane flood report', () => {
  it('stays quiet at the rate a healthy run produces', () => {
    const out = formatFloodReport(info, 11.14, '=== write phases ===')
    expect(out).not.toContain('!!')
    expect(out).toContain('core 11.14 ms/MB')
  })

  it('calls out a run measured in the debuggable tier', () => {
    const out = formatFloodReport(info, 30.65, '=== write phases ===')
    expect(out).toContain('debuggable tier')
    expect(out).toContain('Close DevTools')
  })

  /** Warned above the phase breakdown, so the rate is never read on its own. */
  it('warns before the numbers it disqualifies', () => {
    const out = formatFloodReport(info, 30.65, '=== write phases ===')
    expect(out.indexOf('!!')).toBeLessThan(out.indexOf('=== write phases ==='))
  })

  /**
   * The threshold sits between the two observed modes rather than just above
   * the good one, so ordinary run-to-run variation cannot trip it and a genuine
   * 2.75x cannot slip under it.
   */
  it('separates the two observed modes with room either side', () => {
    expect(formatFloodReport(info, 15, '').includes('!!')).toBe(false)
    expect(formatFloodReport(info, 25, '').includes('!!')).toBe(true)
  })

  it('records the grid it measured, since parse cost was long suspected of scaling with it', () => {
    expect(formatFloodReport(info, 11, '')).toContain('174x38 (6612 cells)')
  })
})
