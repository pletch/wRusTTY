// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SudoPrompt } from './SudoPrompt'

afterEach(cleanup)

/**
 * This dialog collects a *different secret* from the one that got the session
 * connected, and it is the only thing standing between the user and typing
 * their SSH password into sudo (or the reverse). So what is pinned here is
 * mostly about what it says and how plainly it can be refused — not about
 * layout.
 */

const props = {
  remotePath: '/etc/nginx/nginx.conf',
  retry: false,
  onAnswer: () => {},
}

const input = () => document.querySelector('input') as HTMLInputElement

describe('the sudo dialog', () => {
  it('masks the password', () => {
    render(<SudoPrompt {...props} />)
    expect(input().type).toBe('password')
  })

  it('names the file it is asking about', () => {
    // "Enter your password" with no object is exactly the prompt people type
    // any password into.
    render(<SudoPrompt {...props} />)
    expect(screen.getByText('/etc/nginx/nginx.conf')).toBeTruthy()
  })

  it('says this is not the SSH password', () => {
    // The session is already authenticated by the time this appears, and on
    // most hosts sudo wants a different credential. A dialog that let the two
    // be confused would collect the wrong one.
    render(<SudoPrompt {...props} />)
    expect(document.body.textContent).toContain('not the password for this SSH connection')
  })

  it('says a privileged helper will keep running, before the password is given', () => {
    // The standing privilege is the part actually being consented to, so it
    // belongs in the dialog rather than in a release note.
    render(<SudoPrompt {...props} />)
    expect(document.body.textContent).toContain('until you stop watching the file')
    expect(document.body.textContent).toContain('is not stored')
  })

  it('says nothing about a rejected password on the first ask', () => {
    render(<SudoPrompt {...props} />)
    expect(document.body.textContent).not.toContain('was not accepted')
  })

  it('says so on a retry', () => {
    // Otherwise a rejected password reappears as a blank field, which reads as
    // a dropped keystroke rather than a wrong answer.
    render(<SudoPrompt {...props} retry />)
    expect(document.body.textContent).toContain('That password was not accepted')
  })

  it('hands over what was typed', () => {
    const onAnswer = vi.fn()
    render(<SudoPrompt {...props} onAnswer={onAnswer} />)
    fireEvent.change(input(), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByText('Open as root'))
    expect(onAnswer).toHaveBeenCalledWith('hunter2')
  })

  it('cancels with null rather than an empty password', () => {
    // An empty string is an *answer*, and would spend one of sudo's attempts
    // on a guess the user never made.
    const onAnswer = vi.fn()
    render(<SudoPrompt {...props} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onAnswer).toHaveBeenCalledWith(null)
  })

  it('cancels on Escape', () => {
    const onAnswer = vi.fn()
    render(<SudoPrompt {...props} onAnswer={onAnswer} />)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(onAnswer).toHaveBeenCalledWith(null)
  })

  it('does not offer the password to a password manager', () => {
    // A saved entry here would be filled into the SSH dialog later, which is
    // the confusion this whole dialog is shaped to prevent.
    render(<SudoPrompt {...props} />)
    expect(input().getAttribute('autocomplete')).toBe('off')
  })
})
