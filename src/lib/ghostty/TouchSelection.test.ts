// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Selection } from './SelectionController'
import { TouchScroller } from './TouchScroller'
import { TouchSelection } from './TouchSelection'

const CELL = { width: 10, height: 20 }

describe('TouchSelection', () => {
  let container: HTMLElement
  let sel: Selection | null
  let top: number
  let calls: string[]
  let overlay: TouchSelection

  const buttons = () => [...container.querySelectorAll('button')]
  const button = (label: string) => buttons().find((b) => b.textContent === label)!
  const handles = () =>
    [...container.children].filter((el) => el.tagName === 'DIV' && el.querySelector('div')) as HTMLElement[]
  const bar = () => button('Paste').parentElement!

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    sel = null
    top = 100
    calls = []
    overlay = new TouchSelection(container, {
      cellSize: () => CELL,
      rows: () => 24,
      topRow: () => top,
      selection: () => sel,
      dragFrom: (p) => calls.push(`from ${p.x},${p.y}`),
      dragTo: (x, y) => calls.push(`to ${x},${y}`),
      dragEnd: () => calls.push('end'),
      copy: () => calls.push('copy'),
      paste: () => calls.push('paste'),
      clear: () => {
        sel = null
        calls.push('clear')
      },
    })
  })

  afterEach(() => {
    overlay.dispose()
    container.remove()
  })

  it('shows nothing until there is a selection', () => {
    overlay.update()
    expect(overlay.showing()).toBe(false)
    expect(bar().style.display).toBe('none')
    expect(handles().every((h) => h.style.display === 'none')).toBe(true)
  })

  it('puts a handle under each end, on its text', () => {
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 106 } }
    overlay.update()
    const [start, end] = handles()
    expect(start.style.display).toBe('block')
    expect(start.style.left).toBe(`${2 * CELL.width - 22}px`)
    expect(start.style.top).toBe(`${6 * CELL.height}px`)
    // The end handle sits after its last cell.
    expect(end.style.left).toBe(`${8 * CELL.width - 22}px`)
    expect(end.style.top).toBe(`${7 * CELL.height}px`)
  })

  it('finds the ends whichever way the selection was dragged', () => {
    sel = { start: { x: 7, y: 106 }, end: { x: 2, y: 105 } }
    overlay.update()
    expect(handles()[0].style.top).toBe(`${6 * CELL.height}px`)
    expect(handles()[1].style.top).toBe(`${7 * CELL.height}px`)
  })

  it('follows its text as the view scrolls, and hides a handle that left it', () => {
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 105 } }
    overlay.update()
    top = 103
    overlay.update()
    expect(handles()[0].style.top).toBe(`${3 * CELL.height}px`)
    top = 200
    overlay.update()
    expect(handles()[0].style.display).toBe('none')
    // Still selected, just not on screen.
    expect(overlay.showing()).toBe(true)
  })

  it('copies, then clears', () => {
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 105 } }
    overlay.update()
    button('Copy').click()
    expect(calls).toEqual(['copy', 'clear'])
    expect(overlay.showing()).toBe(false)
    expect(bar().style.display).toBe('none')
  })

  it('offers only Paste with nothing selected', () => {
    overlay.offerPaste(50, 60)
    expect(overlay.showing()).toBe(true)
    expect(bar().style.display).toBe('flex')
    expect(button('Copy').style.display).toBe('none')
    expect(handles().every((h) => h.style.display === 'none')).toBe(true)
    button('Paste').click()
    expect(calls).toContain('paste')
    expect(overlay.showing()).toBe(false)
  })

  it('offers Copy again once something is selected', () => {
    overlay.offerPaste(50, 60)
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 105 } }
    overlay.update()
    expect(button('Copy').style.display).toBe('')
  })

  it('drags from the end that stays put', () => {
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 106 } }
    overlay.update()
    handles()[0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(calls).toEqual(['from 7,106'])
    calls.length = 0
    handles()[1].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(calls).toEqual(['from 2,105'])
  })

  it('reports the drag above the finger, then its end', () => {
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 105 } }
    overlay.update()
    const handle = handles()[1]
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientY: 200, bubbles: true }))
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 90, clientY: 250, bubbles: true }))
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(calls).toEqual(['from 2,105', `to 90,${250 - (200 + CELL.height / 2)}`, 'end'])
  })

  it('keeps a dragged handle alive while the selection is briefly empty', () => {
    // Hiding it would release the pointer capture and end the drag.
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 105 } }
    overlay.update()
    const handle = handles()[1]
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    sel = null
    overlay.update()
    expect(handle.style.display).toBe('block')
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(handle.style.display).toBe('none')
  })

  it('keeps presses out of the terminal and focus where it is', () => {
    sel = { start: { x: 2, y: 105 }, end: { x: 7, y: 105 } }
    overlay.update()
    const reached = vi.fn()
    container.addEventListener('mousedown', reached)
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button('Copy').dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(reached).not.toHaveBeenCalled()
  })
})

describe('TouchScroller long press', () => {
  let target: HTMLElement
  let log: string[]
  let claim: boolean
  let consume: boolean
  let tapsOffered: number
  let scroller: TouchScroller

  function touch(type: string, y = 100, x = 5) {
    const e = new Event(type, { cancelable: true, bubbles: true })
    Object.assign(e, { touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] })
    target.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    vi.useFakeTimers()
    target = document.createElement('div')
    log = []
    claim = true
    consume = false
    tapsOffered = 0
    scroller = new TouchScroller(target, {
      rowHeight: () => 20,
      scroll: (n) => log.push(`scroll ${n}`),
      canFling: () => false,
      longPress: (x, y) => {
        log.push(`press ${x},${y}`)
        return claim
      },
      longPressMove: (x, y) => log.push(`move ${x},${y}`),
      longPressEnd: () => log.push('end'),
      consumeTap: () => {
        tapsOffered++
        return consume
      },
    })
  })

  afterEach(() => {
    scroller.dispose()
    vi.useRealTimers()
  })

  it('fires once the finger has stayed put', () => {
    touch('touchstart', 100, 40)
    vi.advanceTimersByTime(449)
    expect(log).toEqual([])
    vi.advanceTimersByTime(1)
    expect(log).toEqual(['press 40,100'])
  })

  it('tolerates a shaky finger', () => {
    touch('touchstart')
    touch('touchmove', 104)
    vi.advanceTimersByTime(450)
    expect(log[0]).toMatch(/^press/)
  })

  it('does not fire once the gesture is a scroll', () => {
    touch('touchstart')
    touch('touchmove', 140)
    vi.advanceTimersByTime(1000)
    expect(log.some((l) => l.startsWith('press'))).toBe(false)
  })

  it('does not fire after the finger lifts', () => {
    touch('touchstart')
    touch('touchend')
    vi.advanceTimersByTime(1000)
    expect(log).toEqual([])
  })

  it('hands the rest of a claimed press to selection, not scrolling', () => {
    touch('touchstart')
    vi.advanceTimersByTime(450)
    const moved = touch('touchmove', 200, 60)
    expect(moved.defaultPrevented).toBe(true)
    const ended = touch('touchend')
    expect(ended.defaultPrevented).toBe(true)
    expect(log).toEqual(['press 5,100', 'move 60,200', 'end'])
  })

  it('lets a press it did not claim carry on as usual', () => {
    claim = false
    touch('touchstart')
    vi.advanceTimersByTime(450)
    touch('touchmove', 200)
    touch('touchmove', 300)
    expect(log).toContain('scroll 5')
    expect(log).not.toContain('end')
  })

  it('does not treat lifting from a claimed press as a tap', () => {
    // A tap dismisses the selection or Paste bar the press just put up, so they
    // would vanish the moment the finger lifted.
    consume = true
    touch('touchstart')
    vi.advanceTimersByTime(450)
    touch('touchend')
    expect(tapsOffered).toBe(0)
  })

  it('ends a claimed press when the system takes the touch away', () => {
    touch('touchstart')
    vi.advanceTimersByTime(450)
    touch('touchcancel')
    expect(log).toEqual(['press 5,100', 'end'])
  })

  it('offers a tap to be consumed, which stops it reaching the terminal', () => {
    touch('touchstart')
    expect(touch('touchend').defaultPrevented).toBe(false)
    consume = true
    touch('touchstart')
    expect(touch('touchend').defaultPrevented).toBe(true)
  })

  it('does not treat the end of a scroll as a tap', () => {
    consume = true
    touch('touchstart')
    touch('touchmove', 140)
    expect(touch('touchend').defaultPrevented).toBe(false)
  })
})
