import { describe, expect, it } from 'vitest'
import { liveSessionCount } from './keepAlive'

describe('liveSessionCount', () => {
  it('counts sessions that are open or on their way', () => {
    expect(liveSessionCount(['connected', 'connecting', 'reconnecting: 2 in 5'])).toBe(3)
  })

  it('lets go of sessions that have ended', () => {
    // Holding a wake lock for one of these would drain the battery for nothing.
    expect(liveSessionCount(['disconnected', 'lost', 'failed: refused', ''])).toBe(0)
  })
})
