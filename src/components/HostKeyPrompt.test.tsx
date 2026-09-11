// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { HostKeyPrompt } from './HostKeyPrompt'

afterEach(cleanup)

/**
 * The button emphasis on this dialog, pinned because it is a deliberate
 * inversion that reads like a mistake.
 *
 * On `changed`, the safe action is the filled primary and accepting is the
 * ghost — the opposite of every other dialog in the app. Someone tidying for
 * consistency would "fix" it straight back, which is why the intent is
 * asserted here rather than left to the comment in the component.
 */

const props = {
  host: 'router.example.net',
  port: 22,
  fingerprint: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  storedFingerprint: 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  onAnswer: () => {},
}

/** Filled = carries a background colour; ghost = does not. */
const isFilled = (el: HTMLElement) => /\bbg-sky-|\bbg-red-6/.test(el.className)

describe('the host-key dialog on a changed key', () => {
  it('gives the filled primary to Reject, not to accepting', () => {
    render(<HostKeyPrompt {...props} status="changed" />)
    const reject = screen.getByRole('button', { name: 'Reject' })
    const accept = screen.getByRole('button', { name: 'Accept anyway' })
    expect(isFilled(reject)).toBe(true)
    expect(isFilled(accept)).toBe(false)
  })

  /** Muscle memory goes to the last button, so the safe one has to be there. */
  it('puts Reject in the trailing position', () => {
    render(<HostKeyPrompt {...props} status="changed" />)
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter(Boolean)
    expect(labels).toEqual(['Accept anyway', 'Reject'])
  })

  it('still answers true only when accepting is actually clicked', () => {
    const onAnswer = vi.fn()
    render(<HostKeyPrompt {...props} status="changed" onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onAnswer).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Accept anyway' }))
    expect(onAnswer).toHaveBeenLastCalledWith(true)
  })

  it('shows the superseded fingerprint alongside the offered one', () => {
    render(<HostKeyPrompt {...props} status="changed" />)
    expect(screen.getByText(props.storedFingerprint)).toBeTruthy()
    expect(screen.getByText(props.fingerprint)).toBeTruthy()
  })
})

/**
 * A known host offering a key type nothing is pinned for. This used to render
 * as the first-connection prompt, which is exactly the prompt a man in the
 * middle without the host's key would want the user to see.
 */
describe('the host-key dialog on a new key type from a known host', () => {
  const known = ['ssh-ed25519 SHA256:cccccccccccccccccccccccccccccccccccccccccccc']

  it('is not worded as a first connection', () => {
    render(
      <HostKeyPrompt {...props} status="newKeyType" storedFingerprint={null} knownKeys={known} />,
    )
    expect(screen.queryByText('Unknown host')).toBeNull()
    expect(screen.getByText('Unfamiliar key from a known host')).toBeTruthy()
  })

  it('shows the keys already on record beside the offered one', () => {
    render(
      <HostKeyPrompt {...props} status="newKeyType" storedFingerprint={null} knownKeys={known} />,
    )
    expect(screen.getByText(known[0])).toBeTruthy()
    expect(screen.getByText(props.fingerprint)).toBeTruthy()
  })

  it('gives the filled trailing slot to Reject, as on a changed key', () => {
    render(
      <HostKeyPrompt {...props} status="newKeyType" storedFingerprint={null} knownKeys={known} />,
    )
    const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Accept anyway', 'Reject'])
    expect(isFilled(screen.getByRole('button', { name: 'Reject' }))).toBe(true)
  })
})

describe('the host-key dialog on a first connection', () => {
  /** Unchanged on purpose. First-connect TOFU is routine and accepting is the
   *  expected answer; friction here is how people are trained to click through
   *  the changed-key dialog, which is the one that matters. */
  it('keeps the ordinary arrangement, with accepting as the primary', () => {
    render(<HostKeyPrompt {...props} status="unknown" storedFingerprint={null} />)
    const reject = screen.getByRole('button', { name: 'Reject' })
    const accept = screen.getByRole('button', { name: 'Accept & connect' })
    expect(isFilled(accept)).toBe(true)
    expect(isFilled(reject)).toBe(false)

    const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Reject', 'Accept & connect'])
  })

  it('answers false on reject and true on accept', () => {
    const onAnswer = vi.fn()
    render(
      <HostKeyPrompt {...props} status="unknown" storedFingerprint={null} onAnswer={onAnswer} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept & connect' }))
    expect(onAnswer).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onAnswer).toHaveBeenLastCalledWith(false)
  })
})
