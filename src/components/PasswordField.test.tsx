// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PasswordField } from './PasswordField'

describe('PasswordField', () => {
  afterEach(cleanup)

  function field(value = 'hunter2') {
    const onChange = vi.fn()
    render(<PasswordField value={value} onChange={onChange} placeholder="master password" />)
    return { input: screen.getByPlaceholderText('master password') as HTMLInputElement, onChange }
  }

  it('starts hidden', () => {
    expect(field().input.type).toBe('password')
  })

  it('shows and hides what was typed, without changing it', () => {
    const { input, onChange } = field()
    fireEvent.click(screen.getByLabelText('Show password'))
    expect(input.type).toBe('text')
    expect(input.value).toBe('hunter2')
    fireEvent.click(screen.getByLabelText('Hide password'))
    expect(input.type).toBe('password')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps out anything that would change or learn the text once shown', () => {
    const { input } = field()
    fireEvent.click(screen.getByLabelText('Show password'))
    expect(input.getAttribute('autocapitalize')).toBe('none')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })

  it('reports typing', () => {
    const { input, onChange } = field('')
    fireEvent.change(input, { target: { value: 'a' } })
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it("doesn't submit the form it sits in, or take focus", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <PasswordField value="x" onChange={() => {}} />
      </form>,
    )
    const toggle = screen.getByLabelText('Show password')
    expect(fireEvent.mouseDown(toggle)).toBe(false)
    fireEvent.click(toggle)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
