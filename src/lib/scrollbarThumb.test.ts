import { describe, expect, it } from 'vitest'

import { lineForThumb } from './scrollbarThumb'

describe('lineForThumb', () => {
  it('maps the thumb across the whole scrollback', () => {
    expect(lineForThumb(0, 400, 10_000)).toBe(0)
    expect(lineForThumb(200, 400, 10_000)).toBe(5_000)
    expect(lineForThumb(400, 400, 10_000)).toBe(10_000)
  })

  it('stays in range when a finger overshoots', () => {
    expect(lineForThumb(-50, 400, 10_000)).toBe(0)
    expect(lineForThumb(900, 400, 10_000)).toBe(10_000)
  })

  it('has nowhere to go with no room to move', () => {
    expect(lineForThumb(10, 0, 10_000)).toBe(0)
  })
})
