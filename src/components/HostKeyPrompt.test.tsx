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
