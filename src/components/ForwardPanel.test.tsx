// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ForwardPanel } from './ForwardPanel'
import type { ForwardInfo } from '../lib/forward'

/**
 * A forward that did not survive a reconnect.
 *
 * This is the case the panel exists to make visible, and the one it used to
 * get wrong in the worst possible direction: the list lived in component
 * state, so a forward whose connection had gone kept being drawn exactly like
 * a working one — a tunnel on a local port that accepts connections and
 * carries nothing. Both halves are pinned here: that a dead forward is shown
 * as dead *with its reason*, and that the list is re-read when the pane's
 * connection changes state, which is the only moment it can find out.
 */

const listForwards = vi.fn<(sessionId: string) => Promise<ForwardInfo[]>>()
const retryForward = vi.fn<(forwardId: string) => Promise<void>>()
const removeForward = vi.fn<(forwardId: string) => Promise<void>>()

vi.mock('../lib/forward', () => ({
  NON_LOOPBACK_BIND_ERROR: 'non-loopback bind host requires confirmation',
  listForwards: (id: string) => listForwards(id),
  retryForward: (id: string) => retryForward(id),
  removeForward: (id: string) => removeForward(id),
  addForward: vi.fn(),
}))

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('./confirmContext', () => ({ useConfirm: () => async () => true }))

// Captured so a test can fire the backend's event by hand, which is the only
// way to reproduce the ordering that matters here.
let emit: ((payload: string) => void) | null = null
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, handler: (event: { payload: string }) => void) => {
    emit = (payload: string) => handler({ payload })
    return Promise.resolve(() => {
      emit = null
    })
  },
}))

const live: ForwardInfo = {
  id: 'fwd-1',
  spec: {
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: 5432,
    targetHost: 'db.internal',
    targetPort: 5432,
  },
  active: true,
  error: null,
}

const dead: ForwardInfo = {
  ...live,
  active: false,
  error: 'Address already in use (os error 10048)',
}

beforeEach(() => {
  listForwards.mockReset()
  retryForward.mockReset()
  removeForward.mockReset()
  listForwards.mockResolvedValue([])
})

afterEach(cleanup)

describe('ForwardPanel', () => {
  it('lists what the backend holds rather than what it opened itself', async () => {
    listForwards.mockResolvedValue([live])
    render(<ForwardPanel sessionId="ssh-0" status="connected" onClose={() => {}} />)

    // The panel was just mounted and has opened nothing — every row it shows
    // came from the backend, which is the point of the ownership change.
    expect(await screen.findByText('127.0.0.1:5432 → db.internal:5432')).toBeTruthy()
    expect(listForwards).toHaveBeenCalledWith('ssh-0')
  })

  it('shows a forward that is down, and says why', async () => {
    listForwards.mockResolvedValue([dead])
    render(<ForwardPanel sessionId="ssh-0" status="connected" onClose={() => {}} />)

    expect(await screen.findByText('Address already in use (os error 10048)')).toBeTruthy()
    // "stop" would be wrong for something already stopped, and the retry is
    // only offered where there is something to retry.
    expect(screen.getByText('dismiss')).toBeTruthy()
    expect(screen.getByText('retry')).toBeTruthy()
  })

  it('offers no retry on a forward that is working', async () => {
    listForwards.mockResolvedValue([live])
    render(<ForwardPanel sessionId="ssh-0" status="connected" onClose={() => {}} />)

    await screen.findByText('127.0.0.1:5432 → db.internal:5432')
    expect(screen.queryByText('retry')).toBeNull()
    expect(screen.getByText('stop')).toBeTruthy()
  })

  /**
   * The ordering bug, pinned.
   *
   * `connected` reaches the webview from inside the SSH handshake — before the
   * backend has re-established anything — so the refetch it triggers reads the
   * *old* list, in which this forward still looks healthy. Only the event that
   * follows the restore carries the truth. The earlier version of this test had
   * the mock already returning the dead row at the moment of the status change,
   * so it passed against code that could never have shown the failure at all.
   */
  it('does not trust the list it reads when the status flips to connected', async () => {
    listForwards.mockResolvedValue([live])
    const { rerender } = render(
      <ForwardPanel sessionId="ssh-0" status="lost" onClose={() => {}} />,
    )
    await screen.findByText('127.0.0.1:5432 → db.internal:5432')

    // The reconnect lands. At this instant the backend has published the
    // session but has not yet re-established the forwards, so the list it can
    // answer with still says the old one is fine.
    rerender(<ForwardPanel sessionId="ssh-0" status="connected" onClose={() => {}} />)
    await waitFor(() => expect(listForwards).toHaveBeenCalled())

    // Now the restore finishes, fails to rebind, and says so.
    listForwards.mockResolvedValue([dead])
    emit?.('ssh-0')

    expect(await screen.findByText('Address already in use (os error 10048)')).toBeTruthy()
  })

  it('ignores the event when it belongs to another pane', async () => {
    listForwards.mockResolvedValue([live])
    render(<ForwardPanel sessionId="ssh-0" status="connected" onClose={() => {}} />)
    await screen.findByText('127.0.0.1:5432 → db.internal:5432')

    listForwards.mockResolvedValue([dead])
    emit?.('ssh-9')

    // Every session emits on one channel, so a panel that refetched on any of
    // them would redraw itself from an unrelated pane's reconnect.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('Address already in use (os error 10048)')).toBeNull()
  })

  it('takes the backend at its word after a retry rather than assuming it worked', async () => {
    listForwards.mockResolvedValue([dead])
    // Resolves — but the entry is still down, which is what the panel must
    // show. Anything that optimistically marked the row live on a resolved
    // promise would draw a working tunnel over a dead one.
    retryForward.mockResolvedValue(undefined)
    render(<ForwardPanel sessionId="ssh-0" status="connected" onClose={() => {}} />)

    await screen.findByText('retry')
    await userEvent.click(screen.getByText('retry'))

    await waitFor(() => expect(retryForward).toHaveBeenCalledWith('fwd-1'))
    expect(await screen.findByText('Address already in use (os error 10048)')).toBeTruthy()
  })
})
