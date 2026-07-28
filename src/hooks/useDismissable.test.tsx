// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useDismissable } from './useDismissable'
import { resetDismissStack } from '../lib/dismissStack'

afterEach(() => {
  cleanup()
  resetDismissStack()
})

/** A panel whose trigger lives *outside* its own subtree — the shape that
 * broke: the toolbar buttons for the forwarding and files panels are in App's
 * toolbar, not in the panel. */
function PanelWithOutsideTrigger({ within }: { within: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button data-panel-toggle onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
      <button data-unrelated>elsewhere</button>
      {open && <Panel within={within} onClose={() => setOpen(false)} />}
    </div>
  )
}

function Panel({ within, onClose }: { within: string; onClose: () => void }) {
  useDismissable(true, onClose, { within })
  return <div data-panel>panel contents</div>
}

describe('useDismissable click-away', () => {
  // Not covered here: the case where the listener is attached *while the
  // opening click is still bubbling*, which is what broke the forwarding and
  // files panels. Reproducing it needs React to flush passive effects
  // mid-dispatch, and every route jsdom offers (userEvent, fireEvent) wraps
  // the interaction in act(), which defers that flush and removes the timing.
  // A raw dispatchEvent doesn't flush the render at all. The guard for it in
  // useDismissable is therefore verified in the running app, not here — do
  // not add a test that appears to cover it, because it will pass either way.

  it('closes on a genuine click elsewhere', async () => {
    const user = userEvent.setup()
    render(<PanelWithOutsideTrigger within="[data-panel]" />)
    await user.click(screen.getByText('toggle'))
    expect(screen.queryByText('panel contents')).not.toBeNull()

    await user.click(screen.getByText('elsewhere'))

    expect(screen.queryByText('panel contents')).toBeNull()
  })

  it('stays open when the click lands inside it', async () => {
    const user = userEvent.setup()
    render(<PanelWithOutsideTrigger within="[data-panel]" />)
    await user.click(screen.getByText('toggle'))

    await user.click(screen.getByText('panel contents'))

    expect(screen.queryByText('panel contents')).not.toBeNull()
  })

  /** What the panels actually do: naming the trigger in `within` means
   * pressing it is not "clicking away", so the trigger's own toggle is the
   * single path that closes it. */
  it('a trigger named in the scope closes only via its own toggle', async () => {
    const user = userEvent.setup()
    render(<PanelWithOutsideTrigger within="[data-panel], [data-panel-toggle]" />)

    await user.click(screen.getByText('toggle'))
    expect(screen.queryByText('panel contents')).not.toBeNull()

    await user.click(screen.getByText('toggle'))
    expect(screen.queryByText('panel contents')).toBeNull()
  })
})

/** Two stacked surfaces, the inner one opened after the outer. */
function Stacked() {
  const [outer, setOuter] = useState(true)
  const [inner, setInner] = useState(false)
  return (
    <div>
      {outer && (
        <Surface label="outer" onClose={() => setOuter(false)}>
          <button onClick={() => setInner(true)}>raise inner</button>
        </Surface>
      )}
      {inner && <Surface label="inner" onClose={() => setInner(false)} />}
    </div>
  )
}

function Surface({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children?: React.ReactNode
}) {
  useDismissable(true, onClose)
  return (
    <div>
      <span>{label} open</span>
      {children}
    </div>
  )
}

describe('useDismissable Escape stacking', () => {
  /** Cancelling a confirmation raised from a panel must not also close the
   * panel underneath — the papercut the stack exists to remove. */
  it('Escape reaches only the topmost surface, then the one below', async () => {
    const user = userEvent.setup()
    render(<Stacked />)
    await user.click(screen.getByText('raise inner'))
    expect(screen.queryByText('inner open')).not.toBeNull()
    expect(screen.queryByText('outer open')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByText('inner open')).toBeNull()
    expect(screen.queryByText('outer open')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByText('outer open')).toBeNull()
  })
})
