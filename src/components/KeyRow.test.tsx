// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TERMINAL_INPUT_LABEL } from '../lib/ghostty/GhosttyInputHandler'
import { takeSoftModifiers } from '../lib/softModifiers'
import { KeyRow } from './KeyRow'

describe('KeyRow', () => {
  let input: HTMLTextAreaElement
  let events: string[]

  beforeEach(() => {
    input = document.createElement('textarea')
    input.setAttribute('aria-label', TERMINAL_INPUT_LABEL)
    document.body.appendChild(input)
    input.focus()
    events = []
    input.addEventListener('keydown', (e) => events.push(`down:${e.key}${e.repeat ? ':repeat' : ''}`))
    input.addEventListener('keyup', (e) => events.push(`up:${e.key}`))
    input.addEventListener('input', (e) => events.push(`text:${(e as InputEvent).data}`))
  })

  afterEach(() => {
    cleanup()
    input.remove()
    takeSoftModifiers()
    vi.useRealTimers()
  })

  it('sends a key to the focused terminal, and its release on letting go', () => {
    render(<KeyRow />)
    const esc = screen.getByLabelText('Escape')
    fireEvent.pointerDown(esc)
    expect(events).toEqual(['down:Escape'])
    fireEvent.pointerUp(esc)
    expect(events).toEqual(['down:Escape', 'up:Escape'])
  })

  it('types a symbol as text', () => {
    render(<KeyRow />)
    fireEvent.pointerDown(screen.getByLabelText('Pipe'))
    expect(events).toEqual(['text:|'])
  })

  it("doesn't take focus, which would close the keyboard", () => {
    render(<KeyRow />)
    const key = screen.getByLabelText('Tab')
    // `false` from fireEvent means the default, moving focus, was prevented.
    expect(fireEvent.pointerDown(key)).toBe(false)
    expect(fireEvent.mouseDown(key)).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('shows a modifier armed until tapped again', () => {
    render(<KeyRow />)
    const ctrl = screen.getByLabelText('Control')
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    fireEvent.pointerDown(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    expect(events).toEqual([])
    fireEvent.pointerDown(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows a modifier disarmed once a key has used it', () => {
    render(<KeyRow />)
    const ctrl = screen.getByLabelText('Control')
    fireEvent.pointerDown(ctrl)
    act(() => void takeSoftModifiers())
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
  })

  it('repeats a held arrow until released', () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    const up = screen.getByLabelText('Up arrow')
    fireEvent.pointerDown(up)
    vi.advanceTimersByTime(400 + 60)
    fireEvent.pointerUp(up)
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([
      'down:ArrowUp',
      'down:ArrowUp:repeat',
      'down:ArrowUp:repeat',
      'up:ArrowUp',
    ])
  })

  it("doesn't repeat Escape", () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    fireEvent.pointerDown(screen.getByLabelText('Escape'))
    vi.advanceTimersByTime(2000)
    expect(events).toEqual(['down:Escape'])
  })

  it('sends nothing to the terminal when something else has focus', () => {
    render(<KeyRow />)
    input.blur()
    fireEvent.pointerDown(screen.getByLabelText('Escape'))
    expect(events).toEqual([])
  })

  describe('in a dialog field', () => {
    /** A controlled field, as every field in the app's dialogs is. */
    function Field() {
      const [value, setValue] = useState('abcd')
      return (
        <form>
          <input data-testid="first" value={value} onChange={(e) => setValue(e.target.value)} />
          <input data-testid="password" type="password" defaultValue="" />
          <input data-testid="skipped" disabled />
          <output data-testid="state">{value}</output>
        </form>
      )
    }

    function setup() {
      render(
        <>
          <Field />
          <KeyRow />
        </>,
      )
      const first = screen.getByTestId('first') as HTMLInputElement
      first.focus()
      return { first, state: screen.getByTestId('state') }
    }

    it('types a symbol at the caret, and React hears it', () => {
      const { first, state } = setup()
      first.setSelectionRange(2, 2)
      fireEvent.pointerDown(screen.getByLabelText('Pipe'))
      expect(state.textContent).toBe('ab|cd')
      expect(first.selectionStart).toBe(3)
      expect(events).toEqual([])
    })

    it('types a symbol into a password field', () => {
      setup()
      const password = screen.getByTestId('password') as HTMLInputElement
      password.focus()
      fireEvent.pointerDown(screen.getByLabelText('Tilde'))
      expect(password.value).toBe('~')
    })

    it('moves the caret with the side arrows, stopping at the ends', () => {
      const { first } = setup()
      first.setSelectionRange(1, 1)
      const left = screen.getByLabelText('Left arrow')
      fireEvent.pointerDown(left)
      fireEvent.pointerUp(left)
      expect(first.selectionStart).toBe(0)
      fireEvent.pointerDown(left)
      fireEvent.pointerUp(left)
      expect(first.selectionStart).toBe(0)
      fireEvent.pointerDown(screen.getByLabelText('Right arrow'))
      expect(first.selectionStart).toBe(1)
    })

    it('moves through the fields with Tab, skipping disabled ones and wrapping', () => {
      const { first } = setup()
      const tab = screen.getByLabelText('Tab')
      fireEvent.pointerDown(tab)
      fireEvent.pointerUp(tab)
      expect(document.activeElement).toBe(screen.getByTestId('password'))
      fireEvent.pointerDown(tab)
      fireEvent.pointerUp(tab)
      expect(document.activeElement).toBe(first)
    })

    it('never tabs into the terminal', () => {
      const { first } = setup()
      fireEvent.pointerDown(screen.getByLabelText('Tab'))
      expect(document.activeElement).not.toBe(input)
      expect(first).toBeTruthy()
    })

    it('lets Escape reach what listens for it', () => {
      setup()
      const heard = vi.fn()
      window.addEventListener('keydown', heard)
      fireEvent.pointerDown(screen.getByLabelText('Escape'))
      window.removeEventListener('keydown', heard)
      expect(heard).toHaveBeenCalledOnce()
      expect((heard.mock.calls[0][0] as KeyboardEvent).key).toBe('Escape')
    })

    it('does not move the caret when a field handles the key itself', () => {
      const { first } = setup()
      first.setSelectionRange(2, 2)
      first.addEventListener('keydown', (e) => e.preventDefault())
      fireEvent.pointerDown(screen.getByLabelText('Left arrow'))
      expect(first.selectionStart).toBe(2)
    })

    it('does not arm Ctrl, which would land on the terminal later', () => {
      setup()
      const ctrl = screen.getByLabelText('Control')
      fireEvent.pointerDown(ctrl)
      expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    })
  })

  it('reaches Escape listeners even with nothing focused', () => {
    render(<KeyRow />)
    input.blur()
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    fireEvent.pointerDown(screen.getByLabelText('Escape'))
    window.removeEventListener('keydown', heard)
    expect(heard).toHaveBeenCalledOnce()
  })

  it('counts as part of a modal, so tapping it closes no menu', () => {
    const { container } = render(<KeyRow />)
    expect(container.querySelector('[data-modal]')).not.toBeNull()
  })
})
