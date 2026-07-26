import { describe, it, expect } from 'vitest'
import { shouldRestoreCursor } from './GhosttyEngine'

/**
 * When a full reset has thrown away the configured cursor and the host should
 * put it back.
 *
 * RIS returns the core to a steady block, which silently discards the cursor
 * preference — `clear`, a curses program exiting, anything that resets the
 * terminal. The core reports *when* a reset and a DECSCUSR last happened and
 * this decides between them, because the alternative — scanning the byte
 * stream for `ESC c` — is guesswork: the two bytes can split across writes and
 * can appear inside payloads that are not sequences.
 *
 * The ordering is the whole point. A TUI commonly resets and then sets the
 * cursor it wants, both inside one write, and restoring on any reset would
 * overwrite the choice it just made.
 */
describe('shouldRestoreCursor', () => {
  it('does nothing when there has never been a reset', () => {
    expect(shouldRestoreCursor(0, 0)).toBe(false)
    // An application that set a cursor and never reset is not a reason to
    // overwrite its choice.
    expect(shouldRestoreCursor(0, 7)).toBe(false)
  })

  it('restores when a reset is the last word on the cursor', () => {
    expect(shouldRestoreCursor(5, 0)).toBe(true)
    expect(shouldRestoreCursor(5, 4)).toBe(true)
  })

  it('leaves an application that chose its own cursor after resetting', () => {
    // The case that makes blind restoration wrong.
    expect(shouldRestoreCursor(5, 6)).toBe(false)
  })

  it('treats a tie as the application having spoken', () => {
    // Ticks are distinct in practice, so this only says which way an
    // impossible-looking value falls: toward leaving the stream alone rather
    // than overwriting it.
    expect(shouldRestoreCursor(5, 5)).toBe(true)
  })

  it('stops repeating once the restore itself has been written', () => {
    // Restoring writes DECSCUSR, which advances the style tick past the reset.
    // That, not a separate handled-marker, is what keeps this from firing on
    // every subsequent write — so it is worth pinning.
    const resetAt = 9
    expect(shouldRestoreCursor(resetAt, 3)).toBe(true)
    const styleAfterRestore = resetAt + 1
    expect(shouldRestoreCursor(resetAt, styleAfterRestore)).toBe(false)
  })

  it('restores again after a second reset', () => {
    // The tick advances per event, so a later reset outranks the restore that
    // followed the earlier one.
    expect(shouldRestoreCursor(12, 10)).toBe(true)
  })
})
