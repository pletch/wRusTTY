// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TabBar } from './TabBar'
import type { Tab } from '../types'

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)

// jsdom has no layout, so the strip is given one: a 300px view, and tabs 200px
// wide laid end to end after 16px of padding. Five of them overflow it; one
// fits.
const VIEW = 300
const TAB = 200
const PAD = 16
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(VIEW)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(TAB)
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.tabId === undefined || !this.parentElement) return 0
    const onTrack = Array.from(this.parentElement.children).filter(
      (c) => (c as HTMLElement).dataset.tabId !== undefined,
    )
    return PAD + onTrack.indexOf(this) * TAB
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function tab(id: string, title: string): Tab {
  return {
    id,
    title,
    root: { type: 'leaf', id: `${id}-pane`, source: null, generation: 0 },
    activePaneId: `${id}-pane`,
  }
}

const tabs = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((t, i) => tab(`t${i}`, t))

function bar(props: Partial<Parameters<typeof TabBar>[0]> = {}) {
  return (
    <TabBar
      tabs={tabs}
      activeTabId="t0"
      statusByPane={{}}
      activityByPane={{}}
      progressByPane={{}}
      attentionPanes={{}}
      titleByPane={{}}
      paneBackground="#16171d"
      tabHoverWash="none"
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
      onDuplicate={() => {}}
      onReconnect={() => {}}
      onReorder={() => {}}
      onDropPaneAsNewTab={() => {}}
      {...props}
    />
  )
}

/** How far the track is scrolled, read off its transform. */
function offset(): number {
  const track = document.querySelector<HTMLElement>('[data-tab-id]')!.parentElement!
  const m = /translateX\((-?[\d.]+)px\)/.exec(track.style.transform)
  return m ? -Number(m[1]) : 0
}

/** Where the active tab is drawn, in px from the strip's left. */
function overlayX(): number {
  const overlay = document.querySelector<HTMLElement>('[data-active-overlay]')!.parentElement!
  return Number(/translateX\((-?[\d.]+)px\)/.exec(overlay.style.transform)?.[1])
}

const maxOffset = PAD + tabs.length * TAB + PAD - VIEW

describe('TabBar overflow controls', () => {
  it('shows nothing extra while the tabs fit', () => {
    render(bar({ tabs: tabs.slice(0, 1) }))
    expect(screen.queryByTestId('tab-list-button')).toBeNull()
    expect(screen.queryByTestId('more-tabs-right')).toBeNull()
  })

  it('offers both arrows, the left one dimmed at the start', () => {
    render(bar())
    expect((screen.getByTestId('more-tabs-left') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('more-tabs-right') as HTMLButtonElement).disabled).toBe(false)
  })

  it('glides the strip right when the right arrow is clicked', async () => {
    render(bar())
    await userEvent.click(screen.getByTestId('more-tabs-right'))
    await waitFor(() => expect(offset()).toBe(VIEW - 130 > 130 ? VIEW - 130 : 130))
  })

  it('scrolls with the mouse wheel, and stops at the end', () => {
    render(bar())
    const view = document.querySelector('[data-tab-id]')!.parentElement!.parentElement!
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }))
    expect(offset()).toBe(120)
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: 5000, cancelable: true }))
    expect(offset()).toBe(maxOffset)
  })

  it('lists every tab and selects the one picked', async () => {
    const onSelect = vi.fn()
    render(bar({ onSelect }))
    await userEvent.click(screen.getByTestId('tab-list-button'))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo'])
    await userEvent.click(items[3])
    expect(onSelect).toHaveBeenCalledWith('t3')
    expect(screen.queryByTestId('tab-list')).toBeNull()
  })

  it('closes the list on Escape', async () => {
    render(bar())
    await userEvent.click(screen.getByTestId('tab-list-button'))
    expect(screen.getByTestId('tab-list')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('tab-list')).toBeNull()
  })
})

describe('TabBar dragging a tab along the strip', () => {
  // jsdom has no DragEvent, and Testing Library then builds a plain Event that
  // drops clientX, which is the whole point here: a MouseEvent carries it.
  class DragEventStandIn extends MouseEvent {}
  beforeEach(() => {
    vi.stubGlobal('DragEvent', DragEventStandIn)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  })

  // On screen as laid out (the strip unscrolled, from x=0), for the pickup.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const left = this.dataset.tabId !== undefined ? this.offsetLeft : 0
      const width = this.dataset.tabId !== undefined ? TAB : VIEW
      return { left, right: left + width, width, top: 0, bottom: 40, height: 40 } as DOMRect
    })
  })

  const dataTransfer = () => ({
    types: ['application/x-wrustty-tab'],
    setData() {},
    getData: () => '',
    effectAllowed: '',
    dropEffect: '',
  })
  const strip = () => document.querySelector('[data-tab-id]')!.parentElement!.parentElement!.parentElement!
  const shiftOf = (id: string) =>
    Number(/translateX\((-?[\d.]+)px\)/.exec(document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!.style.transform)?.[1] ?? 0)

  /** Picks up tab `id` 50px in from its left edge. */
  function pickUp(id: string) {
    const el = document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!
    fireEvent.dragStart(el, { clientX: el.offsetLeft + 50, dataTransfer: dataTransfer() })
  }

  it('slides the tabs it passes aside, the active one included, and drops where the gap is', async () => {
    const onReorder = vi.fn()
    render(bar({ onReorder }))
    pickUp('t1')
    // Its middle now over tab 0's slot: tab 0 makes room by sliding right.
    fireEvent.dragOver(strip(), { clientX: 60, dataTransfer: dataTransfer() })
    await waitFor(() => expect(shiftOf('t0')).toBe(TAB))
    // Tab 0 is the active one, drawn by the overlay: it slides with its slot,
    // from 16 toward 216, pinning at the right edge of this narrow view.
    expect(overlayX()).toBe(VIEW - PAD - TAB)
    expect(shiftOf('t2')).toBe(0)

    fireEvent.drop(strip(), { clientX: 60, dataTransfer: dataTransfer() })
    expect(onReorder).toHaveBeenCalledWith('t1', 't0')
    // Settled at once: the reordered tabs already sit where the slide put them.
    expect(shiftOf('t0')).toBe(0)
  })

  it('leaves the order alone when dropped back over its own slot', () => {
    const onReorder = vi.fn()
    render(bar({ onReorder }))
    pickUp('t1')
    fireEvent.dragOver(strip(), { clientX: PAD + TAB + 50, dataTransfer: dataTransfer() })
    fireEvent.drop(strip(), { clientX: PAD + TAB + 50, dataTransfer: dataTransfer() })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('closes the gap when the drag leaves the strip', async () => {
    render(bar())
    pickUp('t1')
    fireEvent.dragOver(strip(), { clientX: 60, dataTransfer: dataTransfer() })
    await waitFor(() => expect(shiftOf('t0')).toBe(TAB))
    fireEvent.dragOver(document.body, { clientX: 60, dataTransfer: dataTransfer() })
    await waitFor(() => expect(shiftOf('t0')).toBe(0))
  })

  it('puts everything back when the drag ends elsewhere', async () => {
    render(bar())
    pickUp('t1')
    fireEvent.dragOver(strip(), { clientX: 60, dataTransfer: dataTransfer() })
    await waitFor(() => expect(shiftOf('t0')).toBe(TAB))
    fireEvent.dragEnd(document.querySelector('[data-tab-id="t1"]')!)
    expect(shiftOf('t0')).toBe(0)
  })
})

describe('TabBar pinned active tab', () => {
  it('draws the active tab once, over an invisible slot that keeps its place', () => {
    render(bar({ activeTabId: 't2' }))
    expect(screen.getAllByText('charlie')).toHaveLength(1)
    const slot = document.querySelector<HTMLElement>('[data-tab-id="t2"]')!
    expect(slot.style.visibility).toBe('hidden')
    expect(slot.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('[data-active-overlay]')!.textContent).toContain('charlie')
  })

  it('scrolls a newly active tab to its own slot', async () => {
    const { rerender } = render(bar())
    rerender(bar({ activeTabId: 't4' }))
    // Its slot at 816–1016 shown with 16px to spare: the strip's far end.
    await waitFor(() => expect(offset()).toBe(maxOffset))
    expect(overlayX()).toBe(PAD + 4 * TAB - maxOffset)
  })

  it('lands a new tab in its slot even when its arrival brings in the overflow buttons', async () => {
    // A wider view this time, which the buttons narrow by 90px once they appear.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() =>
      document.querySelector('[data-testid="tab-list-button"]') ? 410 : 500,
    )
    const { rerender } = render(bar({ tabs: tabs.slice(0, 2), activeTabId: 't1' }))
    expect(screen.queryByTestId('tab-list-button')).toBeNull()
    // The third tab, opened at the end: 632px of tabs, now in 410px.
    rerender(bar({ tabs: tabs.slice(0, 3), activeTabId: 't2' }))
    expect(screen.getByTestId('tab-list-button')).toBeTruthy()
    await waitFor(() => expect(offset()).toBe(632 - 410))
    // Resting in its own slot, not pinned apart from its neighbor.
    expect(overlayX()).toBe(PAD + 2 * TAB - (632 - 410))
  })

  it('holds the active tab at the left edge once the strip scrolls past it', () => {
    render(bar({ activeTabId: 't0' }))
    const view = document.querySelector('[data-tab-id]')!.parentElement!.parentElement!
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, cancelable: true }))
    expect(overlayX()).toBe(PAD)
  })

  it('brings the active tab back when focus lands in a pane, but not in the strip', async () => {
    const pane = document.createElement('textarea')
    document.body.appendChild(pane)
    render(bar({ activeTabId: 't0' }))
    const view = document.querySelector('[data-tab-id]')!.parentElement!.parentElement!
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, cancelable: true }))

    screen.getByTestId('tab-list-button').focus()
    await new Promise((r) => setTimeout(r, 300))
    expect(offset()).toBe(500)

    pane.focus()
    await waitFor(() => expect(offset()).toBe(0))
    pane.remove()
  })
})
