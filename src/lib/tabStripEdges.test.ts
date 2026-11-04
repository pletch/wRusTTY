import { describe, expect, it } from 'vitest'

import { stripEdges, stripMask } from './tabStripEdges'

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
})
