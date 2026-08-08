// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AuthPrompt } from './AuthPrompt'

afterEach(cleanup)

/**
 * Keyboard-interactive auth puts the *server's* questions on screen, so the
 * things worth pinning here are the ones where guessing instead of relaying
 * would be a real failure: masking what the server called a secret, answering
 * in the order asked, and saying which host is asking.
 */

const props = {
  name: '',
  instructions: '',
  fields: [{ prompt: 'Password: ', echo: false }],
  host: 'bastion.example.net',
  port: 22,
  isJump: false,
  onAnswer: () => {},
}

const inputs = () => Array.from(document.querySelectorAll('input'))

describe('the interactive auth dialog', () => {
  it('masks a field the server marked as a secret, and shows one it did not', () => {
    render(
      <AuthPrompt
        {...props}
        fields={[
          { prompt: 'Password: ', echo: false },
          { prompt: 'Verification code: ', echo: true },
        ]}
      />,
    )
    // The server is the only thing that knows which of these is a secret; a
    // visible one-time code is fine and a visible password is not.
    expect(inputs()[0].type).toBe('password')
    expect(inputs()[1].type).toBe('text')
  })

  it('renders the server prompts verbatim rather than rewording them', () => {
    render(<AuthPrompt {...props} fields={[{ prompt: 'Duo passcode or option: ', echo: false }]} />)
    expect(screen.getByText('Duo passcode or option:')).toBeTruthy()
  })

  it('answers in the order the fields were asked', () => {
    const onAnswer = vi.fn()
    render(
      <AuthPrompt
        {...props}
        fields={[
          { prompt: 'Password: ', echo: false },
          { prompt: 'Code: ', echo: false },
        ]}
        onAnswer={onAnswer}
      />,
    )
    fireEvent.change(inputs()[0], { target: { value: 'hunter2' } })
    fireEvent.change(inputs()[1], { target: { value: '123456' } })
    fireEvent.click(screen.getByText('Submit'))
    // Reversing these submits the password as the one-time code, which the
    // server counts as a failed attempt against a limited budget.
    expect(onAnswer).toHaveBeenCalledWith(['hunter2', '123456'])
  })

  it('sends one empty answer per field rather than a short list', () => {
    const onAnswer = vi.fn()
    render(
      <AuthPrompt
        {...props}
        fields={[
          { prompt: 'a', echo: true },
          { prompt: 'b', echo: true },
        ]}
        onAnswer={onAnswer}
      />,
    )
    fireEvent.click(screen.getByText('Submit'))
    // The response count must match the prompt count — the protocol requires
    // it, and a mismatched round is a protocol error, not a wrong password.
    expect(onAnswer).toHaveBeenCalledWith(['', ''])
  })

  it('cancels with null rather than with blank answers', () => {
    const onAnswer = vi.fn()
    render(<AuthPrompt {...props} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByText('Cancel'))
    // Blanks are a *wrong* answer and burn one of the server's limited
    // attempts; null abandons the connection instead.
    expect(onAnswer).toHaveBeenCalledWith(null)
  })

  it('cancels on Escape', () => {
    const onAnswer = vi.fn()
    render(<AuthPrompt {...props} onAnswer={onAnswer} />)
    fireEvent.keyDown(inputs()[0], { key: 'Escape' })
    expect(onAnswer).toHaveBeenCalledWith(null)
  })

  it('says which hop is asking', () => {
    // A jumped connection authenticates twice with prompts that can be
    // word-for-word identical. Without this the target's password gets typed
    // into the bastion.
    const { container } = render(<AuthPrompt {...props} isJump />)
    expect(container.textContent).toContain('Jump host')
    expect(container.textContent).toContain('bastion.example.net:22')

    cleanup()
    const direct = render(<AuthPrompt {...props} isJump={false} />)
    expect(direct.container.textContent).toContain('Server')
    expect(direct.container.textContent).not.toContain('Jump host')
  })

  it('falls back to its own heading when the server supplies none', () => {
    render(<AuthPrompt {...props} name="" />)
    expect(screen.getByText('Authentication required')).toBeTruthy()
  })

  it('uses the server heading and instructions when they are there', () => {
    const { container } = render(
      <AuthPrompt {...props} name="Duo two-factor login" instructions="Enter a passcode." />,
    )
    expect(screen.getByText('Duo two-factor login')).toBeTruthy()
    expect(container.textContent).toContain('Enter a passcode.')
  })

  it('focuses its first field, so the answer does not go to the terminal behind it', () => {
    render(<AuthPrompt {...props} />)
    expect(document.activeElement).toBe(inputs()[0])
  })
})
