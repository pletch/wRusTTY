// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Dragging out a selection through the engine's real mouse handlers, since
 * the bugs live in the handoff between handlers.
 *
 * Under mouse reporting (any full-screen UI), shift is what takes a drag from
 * the program, so shift-drag is the only way to select and anything else
 * shift means must give way. No core is needed; the renderer is stubbed.
 */

const CELL = { width: 10, height: 20 }

interface Internals {
  renderer: unknown
  /** Drag state moved into `SelectionController`; reached through the engine
   *  because what these tests pin is what the handlers leave behind for each
   *  other, which is exactly that controller's fields. */
  selection: { start: { x: number; y: number } | null; anchor: { x: number; y: number } | null }
  mouseTracking(): boolean
}

type Sel = { start: { x: number; y: number }; end: { x: number; y: number }; rectangular?: boolean }

async function mounted({ mouseTracking = false } = {}) {
  const { GhosttyEngine } = await import('./GhosttyEngine')
  const engine = new GhosttyEngine()
  const container = document.createElement('div')
  document.body.appendChild(container)
  engine.mount(container)

  const inner = engine as unknown as Internals
  // jsdom has no WebGL, and the selection path only ever asks the renderer for
  // the cell size and hands it back a selection. `dispose` is for unmount, which
  // each test runs so the blink timer and window listeners don't outlive it.
  inner.renderer = { selection: null as Sel | null, getCellSize: () => CELL, dispose: () => {} }
  // Standing in for the core's mode state: whether a program asked for the mouse
  // is the only thing about it these handlers read.
  inner.mouseTracking = () => mouseTracking

  const canvas = container.querySelector('canvas')!
  // jsdom lays nothing out, so every rect is zero-sized — which would put any
  // pointer at all outside the canvas and arm the drag-autoscroll on moves that
  // never left it. The edges have to be real for anything about dragging *past*
  // them to mean something.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480, x: 0, y: 0 }) as DOMRect

  const at = (x: number, y: number) => ({
    clientX: x * CELL.width + CELL.width / 2,
    clientY: y * CELL.height + CELL.height / 2,
  })
  const down = (x: number, y: number, mods: MouseEventInit = {}) =>
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1, ...at(x, y), ...mods }),
    )
  // `buttons: 1` is the live button state the drag handler checks to notice a
  // release it never received.
  const move = (x: number, y: number, mods: MouseEventInit = {}) =>
    canvas.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, buttons: 1, ...at(x, y), ...mods }),
    )
  const up = (x: number, y: number) =>
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...at(x, y) }))
  /** A move the canvas would never see, because the pointer has left it. */
  const moveOutside = (clientX: number, clientY: number) =>
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX, clientY }))
  const selection = () => (inner.renderer as { selection: Sel | null }).selection

  /** Leaves a selection on screen, which is the precondition for extending. */
  const dragOut = (fromX: number, toX: number, mods: MouseEventInit = {}) => {
    down(fromX, 0, mods)
    move(toX, 0, mods)
    up(toX, 0)
  }

  return { engine, selection, down, move, up, moveOutside, dragOut, inner }
}

beforeEach(() => {
  // The core is not wanted here; a refused fetch is how the engine is told it
  // will not get one.
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status: 404,
    arrayBuffer: async () => new ArrayBuffer(0),
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('dragging out a selection', () => {
  it('tracks the pointer on a fresh drag', async () => {
    const { engine, selection, down, move } = await mounted()
    down(2, 0)
    move(5, 0)
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 }, end: { x: 5, y: 0 } })
    move(9, 0)
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 }, end: { x: 9, y: 0 } })
    engine.unmount()
  })

  it('keeps a column drag rectangular as it goes', async () => {
    const { engine, selection, down, move } = await mounted()
    down(2, 0, { altKey: true })
    move(6, 2, { altKey: true })
    expect(selection()).toMatchObject({ end: { x: 6, y: 2 }, rectangular: true })
    engine.unmount()
  })
})

describe('dragging past the edge of the pane', () => {
  it('keeps following the pointer once it has left the canvas', async () => {
    const { engine, selection, down, moveOutside } = await mounted()
    down(2, 0)
    // `mousemove` must be bound beyond the canvas, or a pointer outside it
    // reports nowhere and the selection stops at the edge.
    moveOutside(95, 600)
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 } })
    engine.unmount()
  })

  // `scrollLines` is signed the way the wheel is: negative goes back into the
  // scrollback, positive goes forward toward the prompt.
  it('scrolls back into the scrollback while the pointer is held above it', async () => {
    vi.useFakeTimers()
    const { engine, down, moveOutside } = await mounted()
    const scrolled = vi.spyOn(engine, 'scrollLines').mockImplementation(() => {})
    down(2, 5)
    moveOutside(95, -200)
    vi.advanceTimersByTime(200)
    // The direction that matters: dragging up out of the pane is how you select
    // something that has already scrolled off, and it was going the other way —
    // running away from the history instead of into it.
    expect(scrolled).toHaveBeenCalled()
    expect(scrolled.mock.calls.every(([n]) => n < 0)).toBe(true)
    engine.unmount()
    vi.useRealTimers()
  })

  it('scrolls forward while the pointer is held below it', async () => {
    vi.useFakeTimers()
    const { engine, down, moveOutside } = await mounted()
    const scrolled = vi.spyOn(engine, 'scrollLines').mockImplementation(() => {})
    down(2, 0)
    moveOutside(95, 600)
    vi.advanceTimersByTime(200)
    expect(scrolled).toHaveBeenCalled()
    expect(scrolled.mock.calls.every(([n]) => n > 0)).toBe(true)
    engine.unmount()
    vi.useRealTimers()
  })

  it('scrolls faster the further out the pointer is dragged', async () => {
    vi.useFakeTimers()
    const { engine, down, moveOutside } = await mounted()
    const scrolled = vi.spyOn(engine, 'scrollLines').mockImplementation(() => {})
    down(2, 5)
    moveOutside(95, -10)
    vi.advanceTimersByTime(50)
    const near = Math.abs(scrolled.mock.calls[0][0])
    scrolled.mockClear()
    moveOutside(95, -400)
    vi.advanceTimersByTime(50)
    // Reaching a long way back has to feel like one gesture rather than a wait.
    expect(Math.abs(scrolled.mock.calls[0][0])).toBeGreaterThan(near)
    engine.unmount()
    vi.useRealTimers()
  })

  it('stops scrolling when the button is released outside', async () => {
    vi.useFakeTimers()
    const { engine, down, moveOutside } = await mounted()
    const scrolled = vi.spyOn(engine, 'scrollLines').mockImplementation(() => {})
    down(2, 0)
    moveOutside(95, 600)
    vi.advanceTimersByTime(200)
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 95, clientY: 600 }))
    scrolled.mockClear()
    vi.advanceTimersByTime(500)
    // A pane that keeps scrolling on its own after the drag ended has no way
    // left to be stopped.
    expect(scrolled).not.toHaveBeenCalled()
    engine.unmount()
    vi.useRealTimers()
  })
})

describe('selecting while a program has the mouse', () => {
  it('starts a new selection where the shift-drag went down', async () => {
    const { engine, selection, down, move, dragOut } = await mounted({ mouseTracking: true })
    // Shift is mandatory here — without it the drag belongs to the program.
    dragOut(2, 5, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 }, end: { x: 5, y: 0 } })

    // A shift-drag starts a new selection rather than extending the old one.
    down(20, 0, { shiftKey: true })
    move(24, 0, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 20, y: 0 }, end: { x: 24, y: 0 } })
    engine.unmount()
  })

  it('clears the previous selection the moment the new drag begins', async () => {
    const { engine, selection, down, dragOut } = await mounted({ mouseTracking: true })
    dragOut(2, 5, { shiftKey: true })
    down(20, 0, { shiftKey: true })
    // Leaving the old one painted while the new drag has yet to move a cell is
    // how a copy-on-select ends up copying the wrong thing.
    expect(selection()).toBeNull()
    engine.unmount()
  })
})

describe('extending a selection by shift-click', () => {
  it('tracks the pointer, rather than holding at the press point', async () => {
    const { engine, selection, down, move, dragOut } = await mounted()
    dragOut(2, 5)

    down(8, 0, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 }, end: { x: 8, y: 0 } })
    move(12, 0, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 }, end: { x: 12, y: 0 } })
    engine.unmount()
  })

  it('tracks the pointer after a triple-click, which leaves no drag origin', async () => {
    const { engine, selection, down, move, inner } = await mounted()
    // A line selection goes through applySelection, which sets the anchor and
    // clears `selectionStart` — so this is the case where the extend had nothing
    // to track from at all.
    down(4, 0, { detail: 3 })
    expect(inner.selection.start).toBeNull()

    down(30, 0, { shiftKey: true })
    move(34, 0, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 34, y: 0 } })
    engine.unmount()
  })

  it('keeps the anchor fixed while the extend is dragged back past it', async () => {
    const { engine, selection, down, move, dragOut } = await mounted()
    dragOut(10, 14)

    down(6, 0, { shiftKey: true })
    move(3, 0, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 10, y: 0 }, end: { x: 3, y: 0 } })
    engine.unmount()
  })

  it('keeps a column extend rectangular as it is dragged', async () => {
    const { engine, selection, down, move, dragOut } = await mounted()
    dragOut(2, 5)

    down(8, 0, { shiftKey: true, altKey: true })
    move(12, 2, { shiftKey: true, altKey: true })
    // `rectangular` lived in a field the drag handler rebuilds from, so setting
    // it only on the selection object lost it on the first move.
    expect(selection()).toMatchObject({ end: { x: 12, y: 2 }, rectangular: true })
    engine.unmount()
  })

  it('collapses an extend dragged back onto the anchor', async () => {
    const { engine, selection, down, move, dragOut } = await mounted()
    dragOut(4, 9)

    down(12, 0, { shiftKey: true })
    move(4, 0, { shiftKey: true })
    expect(selection()).toBeNull()
    engine.unmount()
  })
})
