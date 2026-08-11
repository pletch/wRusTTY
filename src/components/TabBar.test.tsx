// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TabBar } from './TabBar'
import type { Tab } from '../types'

// The strip measures itself to decide how tabs share the width. jsdom has no
// layout and no ResizeObserver, so it is stubbed rather than mocked away —
// nothing here depends on a measurement, only on what is rendered.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)

afterEach(cleanup)

/**
 * The close button.
 *
 * Hover-gating it on every tab made it intermittently impossible to click, and
 * not for the reason it looks like: an `opacity-0` button still takes clicks.
 * You cannot *aim* at what you cannot see. The reproducible case is cancelling
 * a confirmation — while the dialog is up its overlay owns the pointer, so the
 * tab beneath is not hovered, and the browser does not re-evaluate `:hover`
 * until the pointer moves. Go straight back to the ✕ and it is invisible: hit
 * it and the tab closes, miss by a few pixels and you land on the tab body,
 * which re-selects an already-active tab and looks like nothing happened.
 */

function tab(id: string, title: string): Tab {
  return {
    id,
    title,
    root: { type: 'leaf', id: `${id}-pane`, source: null, generation: 0 },
    activePaneId: `${id}-pane`,
  }
}

const tabs = [tab('t1', 'alpha'), tab('t2', 'bravo')]

function bar(props: Partial<Parameters<typeof TabBar>[0]> = {}) {
  return (
    <TabBar
      tabs={tabs}
      activeTabId="t1"
      statusByPane={{}}
      activityByPane={{}}
      progressByPane={{}}
      attentionPanes={{}}
      titleByPane={{}}
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

describe('TabBar close button', () => {
  it('is visible on the active tab without hovering it', () => {
    render(bar())
    const close = screen.getByLabelText('Close alpha')
    // The point of the fix: no hover gate on the tab you are most likely to
    // close, so it can be aimed at even when the pointer has not moved.
    expect(close.className).not.toContain('opacity-0')
  })

  it('still reveals on hover for inactive tabs, so the strip stays quiet', () => {
    render(bar())
    const close = screen.getByLabelText('Close bravo')
    expect(close.className).toContain('opacity-0')
    expect(close.className).toContain('group-hover:opacity-100')
  })

  it('closes the tab it belongs to without also selecting it', async () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    render(bar({ onClose, onSelect }))

    await userEvent.click(screen.getByLabelText('Close bravo'))

    expect(onClose).toHaveBeenCalledWith('t2')
    // The button sits inside the tab, whose own onClick selects — without the
    // stopPropagation, closing a background tab would select it on the way out.
    expect(onSelect).not.toHaveBeenCalled()
  })
})
