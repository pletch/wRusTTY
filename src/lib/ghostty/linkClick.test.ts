// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Link } from './LinkController'

/**
 * Activating a link, through the engine's real mouse handlers.
 *
 * The same shape as `selectionDrag.test.ts`, and for the same reason: what is
 * worth pinning here is not any one handler but the order they resolve in.
 * Ctrl+click has to outrank mouse reporting, leave shift's two existing
 * meanings alone, and not fire on the press — a drag that begins on a link
 * must not open a browser.
 *
 * Detection itself is stubbed out. `urlDetect` and `LinkController` have their
 * own tests; what reaches here is "there is a link on row 0, columns 4-9",
 * which is all these handlers know.
 */

const CELL = { width: 10, height: 20 }
const URL = 'https://example.com/x'

interface Internals {
  renderer: unknown
  links: {
    linkAt(pos: { x: number; y: number }): Link | null
    linksInViewport(): Link[]
    invalidate(): void
  }
  mouseTracking(): boolean
  refreshLinkRanges(): void
  bufferGen: number
}

/** How many times the whole viewport has been asked for its links, so a test
 *  can pin that the always-on underline is not a per-frame parse. */
let viewportQueries = 0

/** A link on row 0, columns 4 to 9. */
function linkStub(url = URL): Internals['links'] {
  const link: Link = { url, segments: [{ row: 0, from: 4, to: 9 }], source: 'detected' }
  return {
    linkAt: (pos) => (pos.y === 0 && pos.x >= 4 && pos.x <= 9 ? link : null),
    linksInViewport: () => {
      viewportQueries++
      return [link]
    },
    invalidate: () => {},
  }
}

async function mounted({ mouseTracking = false, url = URL } = {}) {
  const { GhosttyEngine } = await import('./GhosttyEngine')
  const engine = new GhosttyEngine()
  const container = document.createElement('div')
  document.body.appendChild(container)
  engine.mount(container)

  const inner = engine as unknown as Internals
  inner.renderer = {
    selection: null,
    linkHighlight: null as { row: number; from: number; to: number }[] | null,
    linkRanges: null as { row: number; from: number; to: number }[] | null,
    getCellSize: () => CELL,
    dispose: () => {},
  }
  inner.mouseTracking = () => mouseTracking
  inner.links = linkStub(url)

  const canvas = container.querySelector('canvas')!
  // jsdom lays nothing out, so the canvas has to be given real edges — the
  // release handler asks whether the pointer is still over the grid.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480, x: 0, y: 0 }) as DOMRect

  const opened: string[] = []
  engine.onLinkActivate((u) => opened.push(u))
  const sent: string[] = []
  engine.onData((d) => sent.push(new TextDecoder().decode(d)))

  const at = (x: number, y: number) => ({
    clientX: x * CELL.width + CELL.width / 2,
    clientY: y * CELL.height + CELL.height / 2,
  })
  const down = (x: number, y: number, mods: MouseEventInit = {}) =>
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1, ...at(x, y), ...mods }),
    )
  /** A hovering pointer: no button held. */
  const move = (x: number, y: number, mods: MouseEventInit = {}) =>
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...at(x, y), ...mods }))
  /** A pointer with the button down. `buttons` is the live state the drag
   *  handler reads to notice a release it never received, so a drag that
   *  omitted it would be taken for one. */
  const drag = (x: number, y: number, mods: MouseEventInit = {}) =>
    canvas.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, buttons: 1, ...at(x, y), ...mods }),
    )
  const up = (x: number, y: number, mods: MouseEventInit = {}) =>
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...at(x, y), ...mods }))
  const leave = () => canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
  const key = (type: 'keydown' | 'keyup', mods: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent(type, { key: 'Control', ...mods }))

  const highlight = () =>
    (inner.renderer as { linkHighlight: unknown[] | null }).linkHighlight
  const ranges = () => (inner.renderer as { linkRanges: unknown[] | null }).linkRanges
  const selection = () => (inner.renderer as { selection: unknown }).selection

  return { engine, inner, canvas, opened, sent, down, move, drag, up, leave, key, highlight, ranges, selection }
}

beforeEach(() => {
  // No core: nothing here consults one, and a refused fetch is how the engine
  // is told it will not get one.
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

describe('activating a link with Ctrl+click', () => {
  it('opens it on release', async () => {
    const { engine, opened, down, up } = await mounted()
    down(6, 0, { ctrlKey: true })
    // Not yet: a press is not a click, and a drag begins with one.
    expect(opened).toEqual([])
    up(6, 0, { ctrlKey: true })
    expect(opened).toEqual([URL])
    engine.unmount()
  })

  it('treats Cmd the same way, so the gesture reads as it does on a Mac', async () => {
    const { engine, opened, down, up } = await mounted()
    down(6, 0, { metaKey: true })
    up(6, 0, { metaKey: true })
    expect(opened).toEqual([URL])
    engine.unmount()
  })

  /** The reason activation waits for the release at all. */
  it('does not open when the press turns into a drag', async () => {
    const { engine, opened, down, drag, up } = await mounted()
    down(6, 0, { ctrlKey: true })
    drag(20, 0, { ctrlKey: true })
    up(20, 0, { ctrlKey: true })
    expect(opened).toEqual([])
    engine.unmount()
  })

  it('does not open when the release lands outside the pane', async () => {
    const { engine, opened, down } = await mounted()
    down(6, 0, { ctrlKey: true })
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 2000, clientY: 2000 }))
    expect(opened).toEqual([])
    engine.unmount()
  })

  it('does nothing without the modifier — hover and click are never enough', async () => {
    const { engine, opened, down, up, move } = await mounted()
    move(6, 0)
    down(6, 0)
    up(6, 0)
    expect(opened).toEqual([])
    engine.unmount()
  })

  it('does nothing when the pointer is beside the link', async () => {
    const { engine, opened, down, up } = await mounted()
    down(20, 0, { ctrlKey: true })
    up(20, 0, { ctrlKey: true })
    expect(opened).toEqual([])
    engine.unmount()
  })

  /** Ctrl on empty ground is unchanged behaviour: it starts a selection, the
   *  same as a plain press does today. */
  it('still begins a selection on a Ctrl+drag that misses the link', async () => {
    const { engine, selection, down, drag } = await mounted()
    down(20, 0, { ctrlKey: true })
    drag(24, 0, { ctrlKey: true })
    expect(selection()).toMatchObject({ start: { x: 20, y: 0 }, end: { x: 24, y: 0 } })
    engine.unmount()
  })

  /**
   * The scheme is checked again at the point of opening, not only at
   * detection. Nothing detection produces could get here — this stands in for
   * an OSC 8 URI, which never passes through detection at all.
   */
  it('refuses a URL whose scheme is not http or https', async () => {
    const { engine, opened, down, up } = await mounted({ url: 'file://attacker.example/share' })
    down(6, 0, { ctrlKey: true })
    up(6, 0, { ctrlKey: true })
    expect(opened).toEqual([])
    engine.unmount()
  })
})

describe('activating a link while a program has the mouse', () => {
  it('opens the link and keeps the click from the program', async () => {
    const { engine, opened, sent, down, up } = await mounted({ mouseTracking: true })
    down(6, 0, { ctrlKey: true })
    up(6, 0, { ctrlKey: true })
    expect(opened).toEqual([URL])
    // The program sees neither half of the click. Not just the press: a
    // release reported for a press that never arrived would leave it tracking
    // a button it was never told about.
    expect(sent).toEqual([])
    engine.unmount()
  })

  /** The regression this whole design is chosen to avoid: shift keeps both of
   *  its meanings, on a link as much as anywhere else. */
  it('leaves shift-to-select untouched over a link', async () => {
    const { engine, opened, selection, down, drag } = await mounted({ mouseTracking: true })
    down(6, 0, { shiftKey: true })
    drag(9, 0, { shiftKey: true })
    expect(selection()).toMatchObject({ start: { x: 6, y: 0 }, end: { x: 9, y: 0 } })
    expect(opened).toEqual([])
    engine.unmount()
  })
})

describe('showing where the links are', () => {
  /** Hover-only feedback makes the gesture undiscoverable: nobody holds Ctrl
   *  over text they have no reason to think is a link. */
  it('marks every link on screen without any modifier', async () => {
    const { engine, inner, ranges } = await mounted()
    inner.refreshLinkRanges()
    expect(ranges()).toEqual([{ row: 0, from: 4, to: 9 }])
    engine.unmount()
  })

  it('re-reads only when the buffer or the view moved', async () => {
    const { engine, inner } = await mounted()
    viewportQueries = 0
    inner.refreshLinkRanges()
    inner.refreshLinkRanges()
    inner.refreshLinkRanges()
    // The frame loop calls this every frame; a still pane must not pay for a
    // parse per frame.
    expect(viewportQueries).toBe(1)

    inner.bufferGen++
    inner.refreshLinkRanges()
    expect(viewportQueries).toBe(2)
    engine.unmount()
  })
})

describe('hover feedback', () => {
  it('underlines the link and shows a pointer while the modifier is held', async () => {
    const { engine, canvas, move, highlight } = await mounted()
    move(6, 0, { ctrlKey: true })
    expect(highlight()).toEqual([{ row: 0, from: 4, to: 9 }])
    expect(canvas.style.cursor).toBe('pointer')
    engine.unmount()
  })

  it('shows nothing without the modifier', async () => {
    const { engine, canvas, move, highlight } = await mounted()
    move(6, 0)
    expect(highlight()).toBeNull()
    expect(canvas.style.cursor).toBe('')
    engine.unmount()
  })

  it('drops it when the pointer moves off the link', async () => {
    const { engine, canvas, move, highlight } = await mounted()
    move(6, 0, { ctrlKey: true })
    move(20, 0, { ctrlKey: true })
    expect(highlight()).toBeNull()
    expect(canvas.style.cursor).toBe('')
    engine.unmount()
  })

  /** Releasing the modifier is a state change the mouse never reports, so
   *  without this the pointer cursor sticks. */
  it('drops it when the modifier is released', async () => {
    const { engine, canvas, move, key, highlight } = await mounted()
    move(6, 0, { ctrlKey: true })
    key('keyup', { ctrlKey: false })
    expect(highlight()).toBeNull()
    expect(canvas.style.cursor).toBe('')
    engine.unmount()
  })

  /** And pressing it is the other half: the pointer is already resting on the
   *  link, and nothing else will fire until it moves. */
  it('picks it up when the modifier is pressed without the mouse moving', async () => {
    const { engine, move, key, highlight } = await mounted()
    move(6, 0)
    expect(highlight()).toBeNull()
    key('keydown', { ctrlKey: true })
    expect(highlight()).toEqual([{ row: 0, from: 4, to: 9 }])
    engine.unmount()
  })

  it('drops it when the pointer leaves the pane', async () => {
    const { engine, canvas, move, leave, highlight } = await mounted()
    move(6, 0, { ctrlKey: true })
    leave()
    expect(highlight()).toBeNull()
    expect(canvas.style.cursor).toBe('')
    engine.unmount()
  })
})
