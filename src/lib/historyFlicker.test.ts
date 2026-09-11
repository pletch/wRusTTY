import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GAP_MS, HistoryFlicker, HIDE_MS, spansFor, type HiddenSpan } from './historyFlicker'

/**
 * The spans are what the renderer blanks, so an error here either hides the
 * wrong text — visibly corrupting a line the user is reading — or hides
 * nothing and looks like the feature not firing. Neither is caught by the
 * watcher's tests, which stop at deciding *that* there is something to say.
 */

describe('spansFor', () => {
  it('covers the input and not the prompt beside it', () => {
    // Column 12 is where the prompt ended. Blanking from column 0 would blink
    // `root@host:~#` along with the command, which reads as the whole line
    // glitching rather than as this command being the same one.
    expect(spansFor({ row: 100, col: 12 }, { row: 100, col: 27 })).toEqual([
      { row: 100, from: 12, to: 27 },
    ])
  })

  it('follows a wrapped command onto every row it occupies', () => {
    const spans = spansFor({ row: 100, col: 70 }, { row: 102, col: 30 })
    expect(spans).toHaveLength(3)
    expect(spans[0]).toMatchObject({ row: 100, from: 70 })
    // The middle row wrapped, so it is full by definition; the renderer clamps
    // the end to its own column count rather than this having to know it.
    expect(spans[1].from).toBe(0)
    expect(spans[1].to).toBeGreaterThan(1000)
    expect(spans[2]).toEqual({ row: 102, from: 0, to: 30 })
  })

  it('blanks nothing for an empty line', () => {
    // The bottom of the history: readline leaves the line blank and every
    // further Down leaves it blank. There is no text to blink, and the old
    // overlay's fixed-width band drawn where no text exists is exactly the
    // chrome this design removed. An empty line is its own evidence.
    expect(spansFor({ row: 100, col: 12 }, { row: 100, col: 12 })).toEqual([])
  })

  it('refuses a cursor above its own origin', () => {
    // Nonsense the engine should never produce, but it decides a loop bound.
    expect(spansFor({ row: 100, col: 12 }, { row: 98, col: 4 })).toEqual([])
  })
})

describe('HistoryFlicker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const driver = () => {
    const applied: (HiddenSpan[] | null)[] = []
    return { applied, flicker: new HistoryFlicker((spans) => applied.push(spans)) }
  }

  const span: HiddenSpan[] = [{ row: 1, from: 0, to: 5 }]

  it('hides the text and puts it back', () => {
    const { applied, flicker } = driver()
    flicker.flash(span)
    expect(applied).toEqual([span])
    vi.advanceTimersByTime(HIDE_MS)
    expect(applied).toEqual([span, null])
  })

  it('shows the text again between two flashes in a row', () => {
    const { applied, flicker } = driver()
    flicker.flash(span)
    // A second press while the text is still dark from the first — which is
    // every press after the first once auto-repeat takes over, since they
    // arrive every ~30ms and the hide lasts longer than that.
    vi.advanceTimersByTime(HIDE_MS - 20)
    const again: HiddenSpan[] = [{ row: 1, from: 0, to: 9 }]
    flicker.flash(again)
    // Restored first. Without this the text went dark on the first press and
    // stayed dark until the hand stopped, which reads as the line having been
    // deleted rather than as a flicker.
    expect(applied).toEqual([span, null])
    vi.advanceTimersByTime(GAP_MS)
    expect(applied).toEqual([span, null, again])
    vi.advanceTimersByTime(HIDE_MS)
    expect(applied).toEqual([span, null, again, null])
  })

  it('gives a held key one countable blink per press', () => {
    const { applied, flicker } = driver()
    // Windows auto-repeat, near its fastest.
    for (let i = 0; i < 5; i++) {
      flicker.flash(span)
      vi.advanceTimersByTime(30)
    }
    // Every hide is preceded by a restore, so the run is a series of blinks
    // rather than one long blank. Counting hides: one per press.
    const hides = applied.filter((a) => a !== null).length
    expect(hides).toBe(5)
    // And it never oscillates on its own — once the key stops, it settles
    // visible and holds no timer.
    vi.advanceTimersByTime(HIDE_MS + GAP_MS)
    expect(applied[applied.length - 1]).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never blanks anything for an empty span list', () => {
    const { applied, flicker } = driver()
    flicker.flash([])
    expect(applied).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores the text and holds no timer when stopped', () => {
    const { applied, flicker } = driver()
    flicker.flash(span)
    // A disposed pane. A surviving timer would blank cells in a freed core,
    // and text left hidden would look like the pane had lost a line.
    flicker.stop()
    expect(applied).toEqual([span, null])
    expect(vi.getTimerCount()).toBe(0)
  })
})
