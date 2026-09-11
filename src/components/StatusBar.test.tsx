// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatusBar } from './StatusBar'

afterEach(cleanup)

/**
 * The terminal-size readout.
 *
 * Pinned because the interesting cases are the ones that render *nothing* —
 * a pane that hasn't fitted yet has no honest size to show, and a placeholder
 * there ("--x--", or worse "0x0") would read as a real measurement of a broken
 * pane. The bar is also the only place the column count is visible, and column
 * count decides scrollback depth (see `estimateScrollbackRows`), so a wrong or
 * absent number here is not merely cosmetic.
 */

const base = {
  protocol: 'SSH',
  target: 'admin@router.example.net',
  status: 'connected',
  connectedAt: null,
  logging: false,
  remoteTitle: null as string | null,
  remoteCwd: null as string | null,
  dimensions: null as { cols: number; rows: number } | null,
  scrollbackBudgetBytes: null as number | null,
  paneIndex: 1,
  paneCount: 1,
  tabCount: 1,
  serialSessionId: null,
}

describe('StatusBar dimensions readout', () => {
  it('shows the fitted grid', () => {
    render(<StatusBar {...base} dimensions={{ cols: 120, rows: 40 }} />)
    expect(screen.getByText('120×40')).toBeTruthy()
  })

  it('renders nothing at all before the pane has fitted', () => {
    const { container } = render(<StatusBar {...base} dimensions={null} />)
    expect(container.textContent).not.toMatch(/\d+×\d+/)
  })

  it('names both axes in the tooltip, since the bare pair is ambiguous', () => {
    // 80x24 is guessable; 200x60 on a wide split is not, and the two orders
    // differ by a factor of three in what you would then type into a switch.
    render(<StatusBar {...base} dimensions={{ cols: 200, rows: 60 }} />)
    const title = screen.getByText('200×60').getAttribute('title') ?? ''
    expect(title).toMatch(/200 columns/)
    expect(title).toMatch(/60 rows/)
  })

  it('sits alongside the rest of the right-hand cluster rather than replacing it', () => {
    render(
      <StatusBar
        {...base}
        dimensions={{ cols: 80, rows: 24 }}
        logging
        paneIndex={2}
        paneCount={3}
        tabCount={2}
      />,
    )
    expect(screen.getByText('80×24')).toBeTruthy()
    expect(screen.getByText('REC')).toBeTruthy()
    expect(screen.getByText('pane 2/3')).toBeTruthy()
    expect(screen.getByText('2 tabs')).toBeTruthy()
  })
})

/**
 * The scrollback-depth estimate that rides alongside the size.
 *
 * It exists because the setting is memory, not rows: the same budget is worth
 * ~34,000 rows at 80 columns and ~6,800 at 400, and this is where that becomes
 * visible instead of being a fact buried in a code comment. (Both numbers went
 * up with the port to ghostty `main`, whose rows cost less — the estimate is
 * `SCROLLBACK_BYTES_PER_CELL`, a measurement of the core, not a constant.)
 */
describe('StatusBar scrollback estimate', () => {
  const dims = { cols: 80, rows: 24 }

  it('shows a depth estimate beside the size', () => {
    render(<StatusBar {...base} dimensions={dims} scrollbackBudgetBytes={24 * 1024 * 1024} />)
    expect(screen.getByText(/~34k/)).toBeTruthy()
  })

  it('shows nothing extra when the pane has not reported a budget', () => {
    const { container } = render(<StatusBar {...base} dimensions={dims} scrollbackBudgetBytes={null} />)
    expect(screen.getByText('80×24')).toBeTruthy()
    expect(container.textContent).not.toMatch(/~/)
  })

  it('estimates a smaller depth for a wider pane on the same budget', () => {
    // The trade the whole memory-based setting exists to express. If these two
    // ever read the same, the width has stopped reaching the estimate.
    const budget = 24 * 1024 * 1024
    const { container: narrow } = render(
      <StatusBar {...base} dimensions={{ cols: 80, rows: 24 }} scrollbackBudgetBytes={budget} />,
    )
    const narrowText = narrow.textContent ?? ''
    cleanup()
    const { container: wide } = render(
      <StatusBar {...base} dimensions={{ cols: 400, rows: 24 }} scrollbackBudgetBytes={budget} />,
    )
    expect(narrowText).not.toBe(wide.textContent ?? '')
    expect(narrowText).toMatch(/~34k/)
    expect(wide.textContent ?? '').toMatch(/~6\.8k/)
  })

  it('explains both numbers in the tooltip', () => {
    render(<StatusBar {...base} dimensions={dims} scrollbackBudgetBytes={24 * 1024 * 1024} />)
    const title = screen.getByText('80×24').getAttribute('title') ?? ''
    expect(title).toMatch(/80 columns/)
    expect(title).toMatch(/Scrollback/)
    expect(title).toMatch(/wider pane holds fewer/)
  })
})

/**
 * What the far end says about itself.
 *
 * The cases worth pinning are the absent ones and the precedence one: this is
 * remote-supplied text sitting in the same bar as the fields that say what you
 * are actually connected to, so it must never displace them or appear when the
 * host never sent it.
 */
describe('StatusBar remote title and directory', () => {
  it('shows neither until the host reports them', () => {
    const { container } = render(<StatusBar {...base} />)
    expect(container.textContent).toContain('admin@router.example.net')
    expect(container.textContent).toBe(
      render(<StatusBar {...base} remoteTitle={null} remoteCwd={null} />).container.textContent,
    )
  })

  it('shows the reported directory', () => {
    render(<StatusBar {...base} remoteCwd="/etc/frr" />)
    expect(screen.getByText('/etc/frr')).toBeTruthy()
  })

  it('shows the reported title', () => {
    render(<StatusBar {...base} remoteTitle="tim@build01: ~/src" />)
    expect(screen.getByText('tim@build01: ~/src')).toBeTruthy()
  })

  it('keeps the connection target alongside them, not replaced by them', () => {
    // The failure this guards is a remote title that reads as the answer to
    // "what am I connected to" — the bar has exactly one such field and the
    // host does not get to be it.
    render(<StatusBar {...base} remoteTitle="prod-db-primary" remoteCwd="/" />)
    expect(screen.getByText('admin@router.example.net')).toBeTruthy()
    expect(screen.getByText('prod-db-primary')).toBeTruthy()
  })

  it('says whose words they are, in the tooltip', () => {
    render(<StatusBar {...base} remoteTitle="prod-db-primary" />)
    const title = screen.getByText('prod-db-primary').getAttribute('title') ?? ''
    expect(title).toMatch(/remote host/i)
  })
})

/**
 * A running local shell has no connection to report, so "Connected" and its
 * green dot say nothing the pane's existence does not. The rule stops at
 * `connected`: a shell that failed to start keeps its state, because that pane
 * stays open precisely so the reason can be read.
 */
describe('StatusBar connection state for a local shell', () => {
  it('says nothing about a running local shell', () => {
    render(<StatusBar {...base} protocol="LOCAL" target="pwsh" />)
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('still reports a local shell that failed to start', () => {
    render(<StatusBar {...base} protocol="LOCAL" target="pwsh" status="failed: no such executable" />)
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('keeps reporting a remote connection', () => {
    render(<StatusBar {...base} />)
    expect(screen.getByText('Connected')).toBeTruthy()
  })
})
