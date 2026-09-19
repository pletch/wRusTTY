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
      paneBackground="#16171d"
      tabHoverWash="linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04))"
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

/**
 * The badge a program sets for itself.
 *
 * There is no icon protocol that survives SSH, so a program that wants to mark
 * itself in the strip writes a symbol at the front of its title (OSC 0/2) and
 * lets the font draw it. wRusTTY already had these titles — they reached the
 * tooltip and the status bar — so this is only about the strip finally showing
 * one. See lib/titleBadge.ts for which characters qualify and why.
 */
describe('TabBar remote title badge', () => {
  it('shows the symbol a program leads its title with', () => {
    render(bar({ titleByPane: { 't1-pane': '\u2733 Building the renderer' } }))
    // With the variation selector: the badge asks for the colour form, since
    // U+2733's default presentation is a monochrome text glyph.
    expect(screen.getByText('\u2733\ufe0f')).toBeTruthy()
  })

  it('keeps the connection name as the label beside it', () => {
    // The tab is still which host it is. A remote program that could rename it
    // would cost the strip the one thing it is for.
    render(bar({ titleByPane: { 't1-pane': '\u2733 Building the renderer' } }))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('Building the renderer')).toBeNull()
  })

  it('shows nothing for an ordinary title', () => {
    render(bar({ titleByPane: { 't1-pane': 'tim@build01: ~/src' } }))
    // A badge here would be noise on every tab in the strip.
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('tim@build01: ~/src')).toBeNull()
  })

  it('shows nothing when the far end set no title at all', () => {
    render(bar())
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('still carries the full title on the tooltip, badge or not', () => {
    // The badge is aria-hidden, so the tooltip is where the title is readable
    // as words rather than as a symbol a screen reader would have to name.
    const { container } = render(bar({ titleByPane: { 't1-pane': '\u2733 Building' } }))
    const withTooltip = container.querySelector('[title="alpha — \u2733 Building"]')
    expect(withTooltip).toBeTruthy()
  })
})

/**
 * A badge in a split tab.
 *
 * The active pane is preferred, so the badge describes what clicking the tab
 * would show. The fallback exists because the case worth catching is the one
 * where the working pane is *not* the one you are looking at.
 */
function splitTab(id: string, title: string, activePane: 'a' | 'b'): Tab {
  return {
    id,
    title,
    root: {
      type: 'split',
      id: `${id}-split`,
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: `${id}-a`, source: null, generation: 0 },
        { type: 'leaf', id: `${id}-b`, source: null, generation: 0 },
      ],
    },
    activePaneId: `${id}-${activePane}`,
  }
}

describe('TabBar badge across a split', () => {
  it('prefers the active pane when both panes badge', () => {
    render(
      bar({
        tabs: [splitTab('t1', 'alpha', 'a')],
        titleByPane: { 't1-a': '\u2733 active one', 't1-b': '\u{1F525} other one' },
      }),
    )
    // With the variation selector: the badge asks for the colour form, since
    // U+2733's default presentation is a monochrome text glyph.
    expect(screen.getByText('\u2733\ufe0f')).toBeTruthy()
    expect(screen.queryByText('\u{1F525}')).toBeNull()
  })

  it('falls back to the other pane when the active one has no badge', () => {
    // The case the fallback is for: you are looking at a shell while the pane
    // next to it is the one working.
    render(
      bar({
        tabs: [splitTab('t1', 'alpha', 'a')],
        titleByPane: { 't1-a': 'tim@build01: ~/src', 't1-b': '\u2733 Building' },
      }),
    )
    // With the variation selector: the badge asks for the colour form, since
    // U+2733's default presentation is a monochrome text glyph.
    expect(screen.getByText('\u2733\ufe0f')).toBeTruthy()
  })

  it('names the badge\u2019s own pane in the tooltip when it is not the active one', () => {
    // Otherwise the tooltip describes one pane while the badge beside it
    // describes another.
    const { container } = render(
      bar({
        tabs: [splitTab('t1', 'alpha', 'a')],
        titleByPane: { 't1-a': 'tim@build01: ~/src', 't1-b': '\u2733 Building' },
      }),
    )
    expect(
      container.querySelector('[title="alpha \u2014 tim@build01: ~/src \u2014 \u2733 Building"]'),
    ).toBeTruthy()
  })

  it('does not double up the title when the badge is the active pane\u2019s own', () => {
    const { container } = render(
      bar({
        tabs: [splitTab('t1', 'alpha', 'a')],
        titleByPane: { 't1-a': '\u2733 Building' },
      }),
    )
    expect(container.querySelector('[title="alpha \u2014 \u2733 Building"]')).toBeTruthy()
  })

  it('shows nothing when no pane in the split badges', () => {
    render(
      bar({
        tabs: [splitTab('t1', 'alpha', 'a')],
        titleByPane: { 't1-a': 'tim@build01: ~/src', 't1-b': 'vim README.md' },
      }),
    )
    expect(screen.getByText('alpha')).toBeTruthy()
  })
})
