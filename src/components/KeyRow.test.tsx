// @vitest-environment jsdom
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

  it('sends nothing when something else has focus', () => {
    render(<KeyRow />)
    input.blur()
    fireEvent.pointerDown(screen.getByLabelText('Escape'))
    expect(events).toEqual([])
  })
})
