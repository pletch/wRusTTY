// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Dragging out a selection, through the engine's real mouse handlers.
 *
 * These go through mount() and real MouseEvents rather than calling a helper,
 * because the bugs they pin live entirely in the handoff between handlers and in
 * what one leaves behind for the next — a stale `selectionStart`, a `rectangular`
 * set on the selection but not on the field the drag rebuilds it from. Nothing
 * inspecting either handler alone would show either.
 *
 * Mouse reporting is the axis that matters most here. Once a program turns it on
 * (which any full-screen UI does), shift is what takes a drag off the program and
 * gives it to the terminal — so shift-drag becomes the *only* way to select, and
 * anything else shift is overloaded to mean has to give way.
 *
 * The core is deliberately absent — none of this consults it, and the renderer is
 * stubbed to the members the selection path actually uses, which is what lets the
 * test run without WebGL.
 */

const CELL = { width: 10, height: 20 }

interface Internals {
  renderer: unknown
  selectionStart: { x: number; y: number } | null
  selectionAnchor: { x: number; y: number } | null
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
  const selection = () => (inner.renderer as { selection: Sel | null }).selection

  /** Leaves a selection on screen, which is the precondition for extending. */
  const dragOut = (fromX: number, toX: number, mods: MouseEventInit = {}) => {
    down(fromX, 0, mods)
    move(toX, 0, mods)
    up(toX, 0)
  }

  return { engine, selection, down, move, up, dragOut, inner }
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

describe('selecting while a program has the mouse', () => {
  it('starts a new selection where the shift-drag went down', async () => {
    const { engine, selection, down, move, dragOut } = await mounted({ mouseTracking: true })
    // Shift is mandatory here — without it the drag belongs to the program.
    dragOut(2, 5, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 2, y: 0 }, end: { x: 5, y: 0 } })

    // The regression: shift was read as "extend", so this second drag stayed
    // anchored to the first selection's start (x: 2) and there was no gesture
    // left that could begin a selection somewhere else.
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
    expect(inner.selectionStart).toBeNull()

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
