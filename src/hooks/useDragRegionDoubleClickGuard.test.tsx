// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useDragRegionDoubleClickGuard } from './useDragRegionDoubleClickGuard'

/**
 * Two listeners maximize the window on the same gesture and the guard has to
 * stop both — see the hook's header. Neither exists under Vitest, so these
 * stand a spy in for each, registered the way the real one is:
 *
 *   - `tauri`: on `document`, bubble phase, reading `e.detail` off a
 *     `mousedown` — mirrors tauri/src/window/scripts/drag.js.
 *   - `react`: a `dblclick` listener on the spacer itself — mirrors the
 *     `onDoubleClick` App.tsx puts there.
 *
 * They are kept apart because the distinction is the whole lesson: suppressing
 * the presses does nothing to the `dblclick` they compose, so an earlier
 * version of this fix passed a suite that only modelled Tauri, and still
 * maximized the window in the running app. Both were then confirmed by hand to
 * fire on their own, each with the other disabled.
 */

let tauri: Mock<() => void>
let react: Mock<() => void>
let tauriListener: (e: MouseEvent) => void

beforeEach(() => {
  document.body.innerHTML = `
    <div id="strip">
      <button id="close">x</button>
      <div id="spacer" data-tauri-drag-region></div>
    </div>`
  tauri = vi.fn()
  react = vi.fn()
  tauriListener = (e: MouseEvent) => {
    const t = e.target
    const onDragRegion = t instanceof Element && t.closest('[data-tauri-drag-region]')
    if (onDragRegion && e.detail === 2) tauri()
  }
  document.addEventListener('mousedown', tauriListener)
  document.querySelector('#spacer')!.addEventListener('dblclick', () => react())
})

afterEach(() => {
  document.removeEventListener('mousedown', tauriListener)
  // Explicit, because this suite runs without Vitest globals and so without
  // RTL's automatic cleanup — a Harness left mounted keeps its guard installed
  // on `document`, where it goes on suppressing in every later test.
  cleanup()
})

function Harness() {
  useDragRegionDoubleClickGuard()
  return null
}

/** `detail` is read-only on a constructed MouseEvent, so it goes in through the
 *  init dict — which is also how the browser sets it. */
function press(el: Element, detail: number) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail }))
}

/** A whole double-click, as the browser delivers one: two presses, then a
 *  `dblclick` at the target of the completing click. Passing different elements
 *  is the bug — the second press lands somewhere the first never aimed at. */
function doubleClick(first: Element, second: Element) {
  press(first, 1)
  press(second, 2)
  second.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, detail: 2 }))
}

const spacer = () => document.querySelector('#spacer')!
const closeButton = () => document.querySelector('#close')!

describe('useDragRegionDoubleClickGuard', () => {
  it('lets a real double-click on the drag region maximize', () => {
    render(<Harness />)
    doubleClick(spacer(), spacer())
    expect(tauri).toHaveBeenCalledTimes(1)
    expect(react).toHaveBeenCalledTimes(1)
  })

  it('suppresses both paths when the first press was on a control', () => {
    render(<Harness />)
    // The reported bug: press 1 closes the tab, the spacer expands under the
    // stationary cursor, press 2 lands on it still counting as a double-click.
    doubleClick(closeButton(), spacer())
    expect(tauri).not.toHaveBeenCalled()
    expect(react).not.toHaveBeenCalled()
  })

  it('leaves a single press on the drag region alone, so dragging still works', () => {
    render(<Harness />)
    press(spacer(), 1)
    // Not a maximize either way — what matters is that the press still reaches
    // the listener, since the same event is what starts a window drag.
    expect(tauri).not.toHaveBeenCalled()
    expect(react).not.toHaveBeenCalled()
  })

  it('recovers on the next gesture rather than latching', () => {
    render(<Harness />)
    doubleClick(closeButton(), spacer())
    expect(react).not.toHaveBeenCalled()
    // A fresh double-click, this time aimed at the drag region throughout.
    doubleClick(spacer(), spacer())
    expect(tauri).toHaveBeenCalledTimes(1)
    expect(react).toHaveBeenCalledTimes(1)
  })

  it('ignores a right-press between the two left ones', () => {
    render(<Harness />)
    press(spacer(), 1)
    spacer().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, detail: 1 }))
    press(spacer(), 2)
    expect(tauri).toHaveBeenCalledTimes(1)
  })

  /** The negative control: the same presses the suppression cases make, with
   *  the guard gone. Without this, a suite that never reached either listener
   *  would look identical to a working guard. */
  it('stops guarding once unmounted', () => {
    const { unmount } = render(<Harness />)
    unmount()
    doubleClick(closeButton(), spacer())
    expect(tauri).toHaveBeenCalledTimes(1)
    expect(react).toHaveBeenCalledTimes(1)
  })
})
