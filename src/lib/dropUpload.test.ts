import { describe, it, expect } from 'vitest'
import { verdictForDrop, type DropState } from './dropUpload'

/**
 * The refusals, which are the part of drag-and-drop worth pinning: each one is
 * a different thing for the user to fix, and a drop that quietly does nothing
 * is worse than one that says why — they walk away believing the file arrived.
 */

const ok: DropState = {
  transport: 'ssh',
  connected: true,
  busy: false,
  folder: false,
  fileCount: 1,
}

describe('verdictForDrop', () => {
  it('accepts one file on a connected SSH pane', () => {
    expect(verdictForDrop(ok)).toEqual({ ok: true })
  })

  it('refuses transports with no file channel at all', () => {
    for (const transport of ['telnet', 'serial'] as const) {
      const verdict = verdictForDrop({ ...ok, transport })
      expect(verdict.ok).toBe(false)
      expect(verdict.ok === false && verdict.reason).toMatch(/SSH/)
    }
  })

  it('refuses a pane whose session has gone', () => {
    const verdict = verdictForDrop({ ...ok, connected: false })
    expect(verdict).toEqual({ ok: false, reason: 'Not connected — nothing to upload to.' })
  })

  it('refuses a second upload while one is running', () => {
    expect(verdictForDrop({ ...ok, busy: true }).ok).toBe(false)
  })

  it('refuses a folder', () => {
    const verdict = verdictForDrop({ ...ok, folder: true })
    expect(verdict.ok === false && verdict.reason).toMatch(/folder/)
  })

  /** A folder arrives as a single item, so the count check would otherwise
   *  claim it was accepted and then send something surprising. */
  it('names the folder rather than the file count when a folder is dropped', () => {
    const verdict = verdictForDrop({ ...ok, folder: true, fileCount: 1 })
    expect(verdict.ok === false && verdict.reason).toMatch(/folder/)
  })

  it('refuses several files, for now', () => {
    const verdict = verdictForDrop({ ...ok, fileCount: 3 })
    expect(verdict.ok === false && verdict.reason).toMatch(/one file at a time/)
  })

  it('refuses a drop carrying nothing usable', () => {
    expect(verdictForDrop({ ...ok, fileCount: 0 }).ok).toBe(false)
  })

  /**
   * Ordering: the *first* applicable refusal is the one reported. Someone on a
   * serial console who drops three files needs to hear about the serial
   * console — being told to drop one at a time would send them off solving a
   * problem that is not theirs.
   */
  it('reports the most fundamental refusal first', () => {
    const verdict = verdictForDrop({
      transport: 'serial',
      connected: false,
      busy: true,
      folder: true,
      fileCount: 4,
    })
    expect(verdict.ok === false && verdict.reason).toMatch(/SSH/)
  })
})
