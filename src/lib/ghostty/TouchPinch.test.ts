// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TouchPinch, pinchedFontSize } from './TouchPinch'

const RANGE = { min: 8, max: 24 }

describe('pinchedFontSize', () => {
  it('scales with the fingers, to a whole size', () => {
    expect(pinchedFontSize(14, 1, RANGE)).toBe(14)
    expect(pinchedFontSize(14, 1.5, RANGE)).toBe(21)
    expect(pinchedFontSize(14, 0.75, RANGE)).toBe(11)
  })

  it('stays in range', () => {
    expect(pinchedFontSize(14, 10, RANGE)).toBe(24)
    expect(pinchedFontSize(14, 0.1, RANGE)).toBe(8)
  })
})

describe('TouchPinch', () => {
  let target: HTMLElement
  let sizes: number[]
  let resets: number
  let time: number
  let pinch: TouchPinch

  /** Fingers at these x positions, as far as the pinch looks at a touch event. */
  function touch(type: string, ...xs: number[]) {
    const e = new Event(type, { cancelable: true, bubbles: true })
    Object.assign(e, { touches: xs.map((x) => ({ clientX: x, clientY: 0 })) })
    target.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    target = document.createElement('div')
    sizes = []
    resets = 0
    time = 0
    pinch = new TouchPinch(
      target,
      {
        fontSize: () => 14,
        setFontSize: (size) => sizes.push(size),
        resetFontSize: () => resets++,
        now: () => time,
      },
      RANGE,
    )
  })

  afterEach(() => pinch.dispose())

  it('reports each new size once as the fingers spread', () => {
    touch('touchstart', 0, 100)
    touch('touchmove', 0, 110)
    touch('touchmove', 0, 110)
    touch('touchmove', 0, 150)
    expect(sizes).toEqual([15, 21])
  })

  it('claims the gesture from the page', () => {
    touch('touchstart', 0, 100)
    expect(touch('touchmove', 0, 110).defaultPrevented).toBe(true)
  })

  it('reports nothing for a move too small to change the size', () => {
    touch('touchstart', 0, 100)
    touch('touchmove', 0, 101)
    expect(sizes).toEqual([])
  })

  it('ignores one finger', () => {
    touch('touchstart', 0)
    const move = touch('touchmove', 50)
    expect(sizes).toEqual([])
    expect(move.defaultPrevented).toBe(false)
  })

  it('stops when a finger lifts, even if the other keeps moving', () => {
    touch('touchstart', 0, 100)
    touch('touchend', 0)
    touch('touchmove', 200)
    expect(sizes).toEqual([])
  })

  function twoFingerTap(heldMs = 50) {
    touch('touchstart', 0, 100)
    time += heldMs
    touch('touchend', 0)
    touch('touchend')
  }

  it('asks for the usual size on a two-finger double-tap', () => {
    twoFingerTap()
    expect(resets).toBe(0)
    time += 200
    twoFingerTap()
    expect(resets).toBe(1)
  })

  it('needs a fresh pair of taps for another reset', () => {
    twoFingerTap()
    time += 200
    twoFingerTap()
    time += 200
    twoFingerTap()
    expect(resets).toBe(1)
  })

  it('does not count taps too far apart', () => {
    twoFingerTap()
    time += 1000
    twoFingerTap()
    expect(resets).toBe(0)
  })

  it('does not count a long press as a tap', () => {
    twoFingerTap(1000)
    time += 100
    twoFingerTap()
    expect(resets).toBe(0)
  })

  it('does not count a pinch as a tap', () => {
    touch('touchstart', 0, 100)
    touch('touchmove', 0, 150)
    touch('touchend', 0)
    touch('touchend')
    time += 100
    twoFingerTap()
    expect(resets).toBe(0)
  })

  it('stops following after it is disposed', () => {
    touch('touchstart', 0, 100)
    pinch.dispose()
    touch('touchmove', 0, 200)
    expect(sizes).toEqual([])
  })
})
