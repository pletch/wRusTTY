import { describe, it, expect } from 'vitest'
import { NotifyLimiter } from './notifyLimit'

describe('NotifyLimiter', () => {
  it('allows a few, then drops the rest of a burst', () => {
    const limiter = new NotifyLimiter(3, 10_000)
    const got = [0, 1, 2, 3, 4].map((i) => limiter.allow('pane', 1000 + i))
    expect(got).toEqual([true, true, true, false, false])
  })

  it('allows again once the window has moved on', () => {
    const limiter = new NotifyLimiter(2, 1000)
    expect(limiter.allow('pane', 0)).toBe(true)
    expect(limiter.allow('pane', 10)).toBe(true)
    expect(limiter.allow('pane', 500)).toBe(false)
    expect(limiter.allow('pane', 1001)).toBe(true)
  })

  /** One noisy pane must not silence the others. */
  it('counts each pane separately', () => {
    const limiter = new NotifyLimiter(1, 1000)
    expect(limiter.allow('a', 0)).toBe(true)
    expect(limiter.allow('a', 1)).toBe(false)
    expect(limiter.allow('b', 1)).toBe(true)
  })
})
