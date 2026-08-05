import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPtyResizeSender, PTY_RESIZE_QUIET_MS } from './ptyResize'

/**
 * What a drag costs the far end.
 *
 * The behaviour under test is not "fewer messages" for its own sake — it is
 * that a program holding a status line at the bottom of the screen redraws it
 * on every SIGWINCH, at the new last row, leaving the previous row behind as
 * text. Measured against a live apt progress bar, a drag across five row
 * boundaries left five stranded bars and scrolled the real output away. So the
 * assertions here are about *how many sizes reach the remote*, and about the
 * last one always being the settled one.
 */
describe('createPtyResizeSender', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const record = () => {
    const sent: string[] = []
    const sender = createPtyResizeSender((c, r) => sent.push(`${c}x${r}`))
    return { sent, sender }
  }

  it('sends one size for a whole drag, and it is the settled one', () => {
    const { sent, sender } = record()
    // The shape the trace showed: six ticks inside 80 ms.
    for (const rows of [38, 37, 36, 35, 36, 37]) {
      sender.post(178, rows)
      vi.advanceTimersByTime(13)
    }
    expect(sent).toEqual([])
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    expect(sent).toEqual(['178x37'])
  })

  it('never sends a size the remote already has', () => {
    const { sent, sender } = record()
    sender.post(178, 38)
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    // Every tab switch used to deliver one of these.
    for (let i = 0; i < 5; i++) {
      sender.post(178, 38)
      vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    }
    expect(sent).toEqual(['178x38'])
  })

  it('sends again once the size really changes', () => {
    const { sent, sender } = record()
    sender.post(178, 38)
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    sender.post(178, 30)
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    sender.post(178, 38)
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    expect(sent).toEqual(['178x38', '178x30', '178x38'])
  })

  it('delivers a settled size even when the drag never pauses', () => {
    // A slow drag is still a drag: the quiet period restarts, but the final
    // size must not be lost — a remote left believing the old size is worse
    // than a stranded status line.
    const { sent, sender } = record()
    for (let rows = 38; rows > 20; rows--) {
      sender.post(178, rows)
      vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS - 1)
    }
    expect(sent).toEqual([])
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS)
    expect(sent).toEqual(['178x21'])
  })

  it('flushes on demand, for a size that must not wait', () => {
    const { sent, sender } = record()
    sender.post(120, 40)
    sender.flush()
    expect(sent).toEqual(['120x40'])
    // And the flush leaves nothing behind to fire later.
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS * 2)
    expect(sent).toEqual(['120x40'])
  })

  it('drops anything pending when cancelled, so a disposed pane sends nothing', () => {
    const { sent, sender } = record()
    sender.post(120, 40)
    sender.cancel()
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS * 2)
    expect(sent).toEqual([])
  })
})
