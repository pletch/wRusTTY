// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TabBar } from './TabBar'
import type { Tab } from '../types'

const startDragging = vi.fn(() => Promise.resolve())
const toggleMaximize = vi.fn(() => Promise.resolve())
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging, toggleMaximize }),
}))

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)

beforeEach(() => {
  startDragging.mockClear()
  toggleMaximize.mockClear()
})
afterEach(cleanup)

/**
 * Moving the window from the tab strip.
 *
 * With one tab there is nothing to reorder, so the tab itself is a handle for
 * the window, as in Chrome. With more, dragging a tab must keep meaning
 * "reorder" — and in neither case may a press on the close button start a move.
 */

function tab(id: string, title: string): Tab {
  return {
    id,
    title,
    root: { type: 'leaf', id: `${id}-pane`, source: null, generation: 0 },
    activePaneId: `${id}-pane`,
  }
}

function bar(tabs: Tab[]) {
  return (
    <TabBar
      tabs={tabs}
      activeTabId={tabs[0].id}
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
    />
  )
}

const tabElement = (title: string) => screen.getByTitle(title)

describe('dragging a tab', () => {
  it('moves the window when it is the only tab', () => {
    render(bar([tab('t1', 'alpha')]))
    expect(tabElement('alpha').getAttribute('draggable')).toBe('false')
    fireEvent.mouseDown(tabElement('alpha'), { button: 0 })
    expect(startDragging).toHaveBeenCalledOnce()
  })

  it('reorders instead when there are others, and never moves the window', () => {
    render(bar([tab('t1', 'alpha'), tab('t2', 'bravo')]))
    expect(tabElement('alpha').getAttribute('draggable')).toBe('true')
    fireEvent.mouseDown(tabElement('alpha'), { button: 0 })
    expect(startDragging).not.toHaveBeenCalled()
  })

  it('leaves the close button to close, even on the only tab', () => {
    render(bar([tab('t1', 'alpha')]))
    fireEvent.mouseDown(screen.getByLabelText('Close alpha'), { button: 0 })
    expect(startDragging).not.toHaveBeenCalled()
  })

  it('does not start a move on a right-click, which opens the tab menu', () => {
    render(bar([tab('t1', 'alpha')]))
    fireEvent.mouseDown(tabElement('alpha'), { button: 2 })
    expect(startDragging).not.toHaveBeenCalled()
  })

  it('maximizes on a double-click of the only tab, like the rest of the strip', () => {
    render(bar([tab('t1', 'alpha')]))
    fireEvent.doubleClick(tabElement('alpha'))
    expect(toggleMaximize).toHaveBeenCalledOnce()
  })
})
