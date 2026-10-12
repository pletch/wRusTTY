// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useDragRegionDoubleClickGuard } from './useDragRegionDoubleClickGuard'

/**
 * Two listeners maximize the window on the same gesture and the guard must
 * stop both (see the hook's header). Neither exists under Vitest, so a spy
 * stands in for each, registered like the real one:
 *
 *   - `tauri`: on `document`, bubble phase, reading `e.detail` off a
 *     `mousedown` (tauri/src/window/scripts/drag.js).
 *   - `react`: a `dblclick` listener on the spacer (App.tsx's
 *     `onDoubleClick`).
 *
 * Kept apart because suppressing the presses does nothing to the `dblclick`
 * they compose.
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
  // Explicit: without Vitest globals there's no automatic RTL cleanup, and a
  // mounted Harness would keep guarding `document` in later tests.
  cleanup()
})

function Harness() {
  useDragRegionDoubleClickGuard()
  return null
}

/** `detail` is read-only on a constructed MouseEvent, so it goes in the init
 *  dict, as the browser sets it. */
function press(el: Element, detail: number) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail }))
}

/** A double-click as the browser delivers it: two presses, then `dblclick` at
 *  the completing click's target. Different elements reproduce the bug. */
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
    // Press 1 closes the tab, the spacer expands under the cursor, press 2
    // lands on it still counting as a double-click.
    doubleClick(closeButton(), spacer())
    expect(tauri).not.toHaveBeenCalled()
    expect(react).not.toHaveBeenCalled()
  })

  it('leaves a single press on the drag region alone, so dragging still works', () => {
    render(<Harness />)
    press(spacer(), 1)
    // The press still reaches the listener, since it also starts a window drag.
    expect(tauri).not.toHaveBeenCalled()
    expect(react).not.toHaveBeenCalled()
  })

  it('recovers on the next gesture rather than latching', () => {
    render(<Harness />)
    doubleClick(closeButton(), spacer())
    expect(react).not.toHaveBeenCalled()
    // A fresh double-click aimed at the drag region throughout.
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

  /** Negative control: without the guard, both listeners fire, so the
   *  suppression cases above aren't passing vacuously. */
  it('stops guarding once unmounted', () => {
    const { unmount } = render(<Harness />)
    unmount()
    doubleClick(closeButton(), spacer())
    expect(tauri).toHaveBeenCalledTimes(1)
    expect(react).toHaveBeenCalledTimes(1)
  })
})
