import { describe, expect, it } from 'vitest'

import { fitToWorkArea } from './windowFit'

// The primary display from the report: 1920x1080 with a 48px taskbar.
const WORK = { x: 0, y: 0, width: 1920, height: 1032 }

describe('fitToWorkArea', () => {
  it('leaves a window that fits where it is', () => {
    expect(fitToWorkArea({ x: 100, y: 50, width: 1200, height: 800 }, WORK)).toBeNull()
  })

  it('shrinks and lifts the window that put the restore prompt off-screen', () => {
    expect(fitToWorkArea({ x: 305, y: 780, width: 1344, height: 1091 }, WORK)).toEqual({
      x: 305,
      y: 0,
      width: 1344,
      height: 1032,
    })
  })

  it('moves a window that fits back from whichever edge it went past', () => {
    expect(fitToWorkArea({ x: 1000, y: 500, width: 1200, height: 800 }, WORK)).toEqual({
      x: 720,
      y: 232,
      width: 1200,
      height: 800,
    })
    expect(fitToWorkArea({ x: -50, y: -20, width: 1200, height: 800 }, WORK)).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    })
  })

  it('works against a monitor that is not at the origin', () => {
    const right = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(fitToWorkArea({ x: 3000, y: 100, width: 1200, height: 800 }, right)).toEqual({
      x: 2640,
      y: 100,
      width: 1200,
      height: 800,
    })
  })
})
