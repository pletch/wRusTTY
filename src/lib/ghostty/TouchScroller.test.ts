// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TouchScroller } from './TouchScroller'
import {
  MODE_ALTERNATE_SCROLL,
  createTerminal,
  instantiateGhosttyWasm,
  writeString,
} from './wasmBindings'

const ROW = 20

describe('alternate scroll in the shipped core', () => {
  it('is on until a program turns it off', async () => {
    // A swipe in `less` or `man` relies on this: off by default, it does nothing.
    const here = dirname(fileURLToPath(import.meta.url))
    const wasm = await instantiateGhosttyWasm(
      Uint8Array.from(readFileSync(join(here, 'vendor/ghostty-vt.wasm'))).buffer as ArrayBuffer,
    )
    const term = createTerminal(wasm, 80, 24, {
      scrollbackLimit: 1024 * 1024,
      fgColor: 0,
      bgColor: 0,
      cursorColor: 0,
    })
    const mode = () => wasm.exports.ghostty_terminal_get_mode(term, MODE_ALTERNATE_SCROLL, 0) !== 0
    expect(mode()).toBe(true)
    writeString(wasm, term, '\x1b[?1007l')
    expect(mode()).toBe(false)
  })
})

describe('TouchScroller', () => {
  let target: HTMLElement
  let rows: number[]
  let time: number
  let canFling: boolean
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  let scroller: TouchScroller

  /** A touch event as far as the scroller looks: `touches`, and whether it was canceled. */
  function touch(type: string, ...ys: number[]) {
    const e = new Event(type, { cancelable: true, bubbles: true })
    Object.assign(e, { touches: ys.map((y) => ({ clientX: 5, clientY: y })) })
    target.dispatchEvent(e)
    return e
  }

  function moveTo(y: number, afterMs = 16) {
    time += afterMs
    return touch('touchmove', y)
  }

  function runFrames(count: number) {
    for (let i = 0; i < count; i++) {
      time += 16
      const pending = [...frames.values()]
      frames.clear()
      for (const frame of pending) frame(time)
    }
  }

  beforeEach(() => {
    target = document.createElement('div')
    rows = []
    time = 1000
    canFling = true
    frames = new Map()
    nextFrame = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(nextFrame, cb)
      return nextFrame++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    scroller = new TouchScroller(target, {
      rowHeight: () => ROW,
      scroll: (n) => rows.push(n),
      canFling: () => canFling,
      now: () => time,
    })
  })

  afterEach(() => {
    scroller.dispose()
    vi.unstubAllGlobals()
  })

  it('leaves a tap alone, so it can still open the keyboard', () => {
    touch('touchstart', 100)
    const moved = moveTo(105)
    const ended = touch('touchend')
    expect(rows).toEqual([])
    expect(moved.defaultPrevented).toBe(false)
    expect(ended.defaultPrevented).toBe(false)
  })

  it('claims a drag once it passes the slop', () => {
    touch('touchstart', 100)
    expect(moveTo(105).defaultPrevented).toBe(false)
    expect(moveTo(120).defaultPrevented).toBe(true)
  })

  it('does not jump by the slack when a drag begins', () => {
    touch('touchstart', 100)
    moveTo(119)
    expect(rows).toEqual([])
    moveTo(139)
    expect(rows).toEqual([1])
  })

  it('moves one row per row of finger travel, in either direction', () => {
    touch('touchstart', 100)
    moveTo(120)
    moveTo(160) // Two rows down, which brings up older text.
    moveTo(140) // One back.
    expect(rows).toEqual([2, -1])
  })

  it('carries fractions rather than rounding each step up', () => {
    touch('touchstart', 100)
    moveTo(120)
    for (let y = 125; y <= 180; y += 5) moveTo(y)
    expect(rows.reduce((sum, n) => sum + n, 0)).toBe(3)
    expect(rows.every((n) => n === 1)).toBe(true)
  })

  it('ignores two fingers', () => {
    touch('touchstart', 100, 200)
    moveTo(150)
    expect(rows).toEqual([])
  })

  it('stops following when a second finger lands mid-drag', () => {
    touch('touchstart', 100)
    moveTo(120)
    time += 16
    touch('touchmove', 160, 300)
    moveTo(200)
    expect(rows).toEqual([])
  })

  it('carries a flick on after release, slowing to a stop', () => {
    touch('touchstart', 100)
    moveTo(150, 16)
    moveTo(200, 16)
    moveTo(250, 16)
    const during = rows.length
    touch('touchend')
    runFrames(10)
    expect(rows.length).toBeGreaterThan(during)
    runFrames(400)
    expect(frames.size).toBe(0)
    const early = rows.slice(during, during + 3).reduce((sum, n) => sum + n, 0)
    const late = rows.slice(-3).reduce((sum, n) => sum + n, 0)
    expect(early).toBeGreaterThan(late)
  })

  it('does not fling where a program is listening', () => {
    // There each row is a keypress or a wheel report, and momentum would keep
    // sending them after the finger has gone.
    canFling = false
    touch('touchstart', 100)
    moveTo(150)
    moveTo(200)
    touch('touchend')
    expect(frames.size).toBe(0)
  })

  it('does not fling after the finger stopped before lifting', () => {
    touch('touchstart', 100)
    moveTo(150)
    moveTo(200)
    time += 500
    touch('touchend')
    expect(frames.size).toBe(0)
  })

  it('stops a flick on touch, without that tap reaching the terminal', () => {
    touch('touchstart', 100)
    moveTo(150)
    moveTo(200)
    touch('touchend')
    expect(frames.size).toBe(1)
    touch('touchstart', 300)
    expect(frames.size).toBe(0)
    expect(touch('touchend').defaultPrevented).toBe(true)
    // The next tap is an ordinary one.
    touch('touchstart', 300)
    expect(touch('touchend').defaultPrevented).toBe(false)
  })

  it('stops listening once disposed', () => {
    scroller.dispose()
    touch('touchstart', 100)
    moveTo(200)
    expect(rows).toEqual([])
  })
})
