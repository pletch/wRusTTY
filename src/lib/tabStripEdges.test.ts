import { describe, expect, it } from 'vitest'

import {
  activeTabHole,
  clampOffset,
  maxOffset,
  offsetToReveal,
  pinnedX,
  stripEdges,
  stripMask,
} from './tabStripEdges'

describe('stripEdges', () => {
  it('sees nothing off screen when everything fits', () => {
    expect(stripEdges(0, 400, 400)).toEqual({ left: false, right: false })
  })

  it('sees more to the right at the start', () => {
    expect(stripEdges(0, 400, 700)).toEqual({ left: false, right: true })
  })

  it('sees both sides partway along', () => {
    expect(stripEdges(150, 400, 700)).toEqual({ left: true, right: true })
  })

  it('sees more to the left at the end', () => {
    expect(stripEdges(300, 400, 700)).toEqual({ left: true, right: false })
  })

  it('ignores a pixel of rounding', () => {
    expect(stripEdges(0.5, 400, 400.5)).toEqual({ left: false, right: false })
  })
})

describe('stripMask', () => {
  it('has no fade with nothing off screen', () => {
    expect(stripMask({ left: false, right: false })).toBeNull()
  })

  it('fades only the side with more', () => {
    expect(stripMask({ left: false, right: true })).toBe(
      'linear-gradient(to right, black, black calc(100% - 24px), transparent)',
    )
    expect(stripMask({ left: true, right: false })).toBe(
      'linear-gradient(to right, transparent, black 24px, black)',
    )
  })

  it('fades both sides partway along', () => {
    expect(stripMask({ left: true, right: true })).toBe(
      'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)',
    )
  })

  it('takes a fade width', () => {
    expect(stripMask({ left: true, right: false }, 16)).toBe(
      'linear-gradient(to right, transparent, black 16px, black)',
    )
  })

  it('cuts a hard-edged hole where the active tab is drawn', () => {
    expect(stripMask({ left: true, right: true }, 16, [16, 196])).toBe(
      'linear-gradient(to right, transparent, black 16px, black 16px, transparent 16px, transparent 196px, black 196px, black calc(100% - 16px), transparent)',
    )
  })
})

describe('stripMask with a hole open to an edge', () => {
  it('cuts everything left of a tab pinned at the left, fade included', () => {
    expect(stripMask({ left: true, right: true }, 16, [null, 196])).toBe(
      'linear-gradient(to right, transparent, transparent 196px, black 196px, black calc(100% - 16px), transparent)',
    )
  })

  it('cuts everything right of a tab pinned at the right, fade included', () => {
    expect(stripMask({ left: true, right: true }, 16, [600, null])).toBe(
      'linear-gradient(to right, transparent, black 16px, black 600px, transparent 600px, transparent)',
    )
  })
})

describe('activeTabHole', () => {
  it('cuts just the tab while it sits in its own slot', () => {
    expect(activeTabHole(200, 200, 150)).toEqual([200, 350])
  })

  it('runs to the left edge once the tab is held there', () => {
    expect(activeTabHole(-300, 16, 150)).toEqual([null, 166])
  })

  it('runs to the right edge once the tab is held there', () => {
    expect(activeTabHole(1200, 634, 150)).toEqual([634, null])
  })
})

describe('pinnedX', () => {
  it('leaves a tab in view at its own slot', () => {
    expect(pinnedX(200, 150, 800, 16)).toBe(200)
  })

  it('holds a tab passing the left edge at the inset', () => {
    expect(pinnedX(-300, 150, 800, 16)).toBe(16)
  })

  it('holds a tab passing the right edge at the inset', () => {
    expect(pinnedX(1200, 150, 800, 16)).toBe(800 - 16 - 150)
  })

  it('moves continuously across the pin point, never jumping', () => {
    for (let x = 0; x < 40; x++) {
      expect(Math.abs(pinnedX(x + 1, 150, 800, 16) - pinnedX(x, 150, 800, 16))).toBeLessThanOrEqual(1)
    }
  })

  it('keeps to the left in a view too narrow for the tab', () => {
    expect(pinnedX(500, 150, 160, 16)).toBe(16)
  })
})

describe('offsetToReveal', () => {
  it('stays put when the slot is already in view', () => {
    expect(offsetToReveal(300, 450, 100, 800, 16)).toBe(100)
  })

  it('scrolls left just far enough', () => {
    expect(offsetToReveal(300, 450, 400, 800, 16)).toBe(284)
  })

  it('scrolls right just far enough', () => {
    expect(offsetToReveal(1000, 1150, 0, 800, 16)).toBe(366)
  })
})

describe('clampOffset and maxOffset', () => {
  it('cannot scroll when everything fits', () => {
    expect(maxOffset(500, 800)).toBe(0)
    expect(clampOffset(50, maxOffset(500, 800))).toBe(0)
  })

  it('stops at both ends', () => {
    expect(clampOffset(-20, 300)).toBe(0)
    expect(clampOffset(420, 300)).toBe(300)
  })
})
