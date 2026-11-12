// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TERMINAL_INPUT_LABEL } from '../lib/ghostty/GhosttyInputHandler'
import { clearSoftModifiers, takeSoftModifiers } from '../lib/softModifiers'
import { KeyRow } from './KeyRow'

/** A press and lift in place, the way a finger taps. */
function tap(el: Element) {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 10 })
  fireEvent.pointerUp(el, { clientX: 100, clientY: 10 })
}

/** A finger landing on `el` and dragging `dx` sideways before lifting. The row has
 * the pointer captured, so the rest goes to it: the key may be gone by then. */
function swipe(el: Element, dx: number, dy = 0) {
  const row = el.closest('[data-modal]')!
  fireEvent.pointerDown(el, { clientX: 100, clientY: 10 })
  fireEvent.pointerMove(row, { clientX: 100 + dx / 2, clientY: 10 + dy / 2 })
  fireEvent.pointerMove(row, { clientX: 100 + dx, clientY: 10 + dy })
  fireEvent.pointerUp(row, { clientX: 100 + dx, clientY: 10 + dy })
}

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
    clearSoftModifiers()
    vi.useRealTimers()
  })

  it('sends a key and its release on a tap, but nothing before the lift', () => {
    render(<KeyRow />)
    const esc = screen.getByLabelText('Escape')
    fireEvent.pointerDown(esc, { clientX: 100, clientY: 10 })
    expect(events).toEqual([])
    fireEvent.pointerUp(esc, { clientX: 100, clientY: 10 })
    expect(events).toEqual(['down:Escape', 'up:Escape'])
  })

  it('sends a held key once it has stayed put, and its release on letting go', () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    const esc = screen.getByLabelText('Escape')
    fireEvent.pointerDown(esc, { clientX: 100, clientY: 10 })
    vi.advanceTimersByTime(150)
    expect(events).toEqual(['down:Escape'])
    fireEvent.pointerUp(esc, { clientX: 100, clientY: 10 })
    expect(events).toEqual(['down:Escape', 'up:Escape'])
  })

  it('reaches the other pages by swiping left, and comes back around', () => {
    render(<KeyRow />)
    swipe(screen.getByLabelText('Escape'), -60)
    expect(screen.queryByLabelText('Escape')).toBeNull()
    expect(screen.getByLabelText('Page up')).toBeTruthy()
    swipe(screen.getByLabelText('Home'), -60)
    expect(screen.getByLabelText('F12')).toBeTruthy()
    swipe(screen.getByLabelText('F1'), -60)
    expect(screen.getByLabelText('Escape')).toBeTruthy()
    expect(events).toEqual([])
  })

  it('goes back a page by swiping right, wrapping from the first', () => {
    render(<KeyRow />)
    swipe(screen.getByLabelText('Escape'), 60)
    expect(screen.getByLabelText('F12')).toBeTruthy()
    swipe(screen.getByLabelText('F1'), 60)
    expect(screen.getByLabelText('Page up')).toBeTruthy()
  })

  it('turns one page per swipe, however far it goes', () => {
    render(<KeyRow />)
    swipe(screen.getByLabelText('Escape'), -300)
    expect(screen.getByLabelText('Page up')).toBeTruthy()
  })

  it('takes a small wobble as a tap', () => {
    render(<KeyRow />)
    swipe(screen.getByLabelText('Escape'), 8, 5)
    expect(events).toEqual(['down:Escape', 'up:Escape'])
  })

  it('drops a press dragged off the row', () => {
    render(<KeyRow />)
    swipe(screen.getByLabelText('Escape'), 0, -40)
    expect(events).toEqual([])
    expect(screen.getByLabelText('Escape')).toBeTruthy()
  })

  it("can't swipe once a held key has fired", () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    const esc = screen.getByLabelText('Escape')
    fireEvent.pointerDown(esc, { clientX: 100, clientY: 10 })
    vi.advanceTimersByTime(150)
    fireEvent.pointerMove(esc, { clientX: 20, clientY: 10 })
    fireEvent.pointerUp(esc, { clientX: 20, clientY: 10 })
    expect(screen.getByLabelText('Escape')).toBeTruthy()
    expect(events).toEqual(['down:Escape', 'up:Escape'])
  })

  it('lets a new press take over from one whose lift never came', () => {
    render(<KeyRow />)
    fireEvent.pointerDown(screen.getByLabelText('Escape'), {
      clientX: 100,
      clientY: 10,
    })
    tap(screen.getByLabelText('Pipe'))
    expect(events).toEqual(['text:|'])
  })

  describe('with motion allowed', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.stubGlobal('matchMedia', () => ({ matches: false }))
    })
    afterEach(() => vi.unstubAllGlobals())

    const track = () => screen.getByTestId('key-pages').previousElementSibling as HTMLElement

    it('follows the finger, then slides on to the next page', () => {
      render(<KeyRow />)
      const esc = screen.getByLabelText('Escape')
      const row = esc.closest('[data-modal]')!
      fireEvent.pointerDown(esc, { clientX: 100, clientY: 10 })
      fireEvent.pointerMove(row, { clientX: 60, clientY: 10 })
      expect(track().style.transform).toContain('-40px')
      fireEvent.pointerUp(row, { clientX: 60, clientY: 10 })
      expect(track().style.transition).toContain('transform')
      expect(screen.getByLabelText('Escape')).toBeTruthy()
      act(() => void vi.advanceTimersByTime(180))
      expect(screen.getByLabelText('Page up')).toBeTruthy()
      expect(track().style.transition).toBe('none')
    })

    it('slides back without turning when the finger returns', () => {
      render(<KeyRow />)
      const esc = screen.getByLabelText('Escape')
      const row = esc.closest('[data-modal]')!
      fireEvent.pointerDown(esc, { clientX: 100, clientY: 10 })
      fireEvent.pointerMove(row, { clientX: 60, clientY: 10 })
      fireEvent.pointerUp(row, { clientX: 95, clientY: 10 })
      act(() => void vi.advanceTimersByTime(180))
      expect(screen.getByLabelText('Escape')).toBeTruthy()
      expect(events).toEqual([])
    })

    it('ignores a press while the row is still sliding', () => {
      render(<KeyRow />)
      swipe(screen.getByLabelText('Escape'), -60)
      tap(screen.getByLabelText('Pipe'))
      expect(events).toEqual([])
    })
  })

  it('marks the current page', () => {
    render(<KeyRow />)
    const dots = () =>
      [...screen.getByTestId('key-pages').children].map((d) => d.hasAttribute('data-current'))
    expect(dots()).toEqual([true, false, false])
    swipe(screen.getByLabelText('Escape'), -60)
    expect(dots()).toEqual([false, true, false])
  })

  it('sends Ctrl-C as a key press with Ctrl held, for the encoder', () => {
    const seen: KeyboardEvent[] = []
    input.addEventListener('keydown', (e) => seen.push(e))
    render(<KeyRow />)
    swipe(screen.getByLabelText('Escape'), -60)
    tap(screen.getByLabelText('Control C'))
    expect(seen[0].key).toBe('c')
    expect(seen[0].code).toBe('KeyC')
    expect(seen[0].ctrlKey).toBe(true)
  })

  it('types a symbol as text', () => {
    render(<KeyRow />)
    tap(screen.getByLabelText('Pipe'))
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

  it('shows a modifier armed until tapped again a while later', () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    const ctrl = screen.getByLabelText('Control')
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    tap(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    expect(events).toEqual([])
    vi.advanceTimersByTime(1000)
    tap(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
  })

  it('locks a modifier on a quick second tap, and shows it differently', () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    const ctrl = screen.getByLabelText('Control')
    tap(ctrl)
    const armedLook = ctrl.className
    tap(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    expect(ctrl.className).not.toBe(armedLook)
    expect(takeSoftModifiers().ctrl).toBe(true)
    expect(takeSoftModifiers().ctrl).toBe(true)
  })

  it('shows a modifier disarmed once a key has used it', () => {
    render(<KeyRow />)
    const ctrl = screen.getByLabelText('Control')
    tap(ctrl)
    act(() => void takeSoftModifiers())
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
  })

  it('repeats a held arrow until released', () => {
    vi.useFakeTimers()
    render(<KeyRow />)
    const up = screen.getByLabelText('Up arrow')
    fireEvent.pointerDown(up, { clientX: 100, clientY: 10 })
    vi.advanceTimersByTime(150 + 400 + 60)
    fireEvent.pointerUp(up, { clientX: 100, clientY: 10 })
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
    tap(screen.getByLabelText('Escape'))
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
      tap(screen.getByLabelText('Pipe'))
      expect(state.textContent).toBe('ab|cd')
      expect(first.selectionStart).toBe(3)
      expect(events).toEqual([])
    })

    it('types a symbol into a password field', () => {
      setup()
      const password = screen.getByTestId('password') as HTMLInputElement
      password.focus()
      tap(screen.getByLabelText('Tilde'))
      expect(password.value).toBe('~')
    })

    it('moves the caret with the side arrows, stopping at the ends', () => {
      const { first } = setup()
      first.setSelectionRange(1, 1)
      const left = screen.getByLabelText('Left arrow')
      tap(left)
      expect(first.selectionStart).toBe(0)
      tap(left)
      expect(first.selectionStart).toBe(0)
      tap(screen.getByLabelText('Right arrow'))
      expect(first.selectionStart).toBe(1)
    })

    it('moves through the fields with Tab, skipping disabled ones and wrapping', () => {
      const { first } = setup()
      const tab = screen.getByLabelText('Tab')
      tap(tab)
      expect(document.activeElement).toBe(screen.getByTestId('password'))
      tap(tab)
      expect(document.activeElement).toBe(first)
    })

    it('never tabs into the terminal', () => {
      const { first } = setup()
      tap(screen.getByLabelText('Tab'))
      expect(document.activeElement).not.toBe(input)
      expect(first).toBeTruthy()
    })

    it('lets Escape reach what listens for it', () => {
      setup()
      const heard = vi.fn()
      window.addEventListener('keydown', heard)
      tap(screen.getByLabelText('Escape'))
      window.removeEventListener('keydown', heard)
      expect(heard).toHaveBeenCalledOnce()
      expect((heard.mock.calls[0][0] as KeyboardEvent).key).toBe('Escape')
    })

    it('does not move the caret when a field handles the key itself', () => {
      const { first } = setup()
      first.setSelectionRange(2, 2)
      first.addEventListener('keydown', (e) => e.preventDefault())
      tap(screen.getByLabelText('Left arrow'))
      expect(first.selectionStart).toBe(2)
    })

    it('does not arm Ctrl, which would land on the terminal later', () => {
      setup()
      const ctrl = screen.getByLabelText('Control')
      tap(ctrl)
      expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    })
  })

  it('reaches Escape listeners even with nothing focused', () => {
    render(<KeyRow />)
    input.blur()
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    tap(screen.getByLabelText('Escape'))
    window.removeEventListener('keydown', heard)
    expect(heard).toHaveBeenCalledOnce()
  })

  it('counts as part of a modal, so tapping it closes no menu', () => {
    const { container } = render(<KeyRow />)
    expect(container.querySelector('[data-modal]')).not.toBeNull()
  })
})
