// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { isCompactHeight, osUnlockButtonLabel, relaxTextEntry } from './platform'

describe('isCompactHeight', () => {
  it('is compact on a phone in landscape with its keyboard open', () => {
    expect(isCompactHeight(108, true)).toBe(true)
  })

  it('leaves the chrome alone with the keyboard closed, or in portrait with it open', () => {
    expect(isCompactHeight(360, true)).toBe(false)
    expect(isCompactHeight(450, true)).toBe(false)
  })

  it('never applies on desktop, however short the window', () => {
    expect(isCompactHeight(108, false)).toBe(false)
  })

  it('ignores a window with no size yet', () => {
    expect(isCompactHeight(0, true)).toBe(false)
  })
})

describe('osUnlockButtonLabel', () => {
  it('names what the platform actually uses', () => {
    expect(osUnlockButtonLabel(true)).toBe('Unlock with biometrics')
    expect(osUnlockButtonLabel(false)).toBe('Unlock with Windows sign-in')
  })
})

describe('relaxTextEntry', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function focused(html: string) {
    const root = document.createElement('div')
    relaxTextEntry(root)
    root.innerHTML = html
    document.body.appendChild(root)
    const el = root.firstElementChild as HTMLElement
    el.focus()
    return el
  }

  it('turns off capitals and corrections on a text field that takes focus', () => {
    const el = focused('<input type="text" />') as HTMLInputElement
    expect(el.getAttribute('autocapitalize')).toBe('none')
    expect(el.getAttribute('autocorrect')).toBe('off')
    expect(el.spellcheck).toBe(false)
  })

  it('covers a textarea, and a field added after it started', () => {
    expect(focused('<textarea></textarea>').getAttribute('autocapitalize')).toBe('none')
  })

  it('leaves everything else alone', () => {
    expect(focused('<button>go</button>').hasAttribute('autocapitalize')).toBe(false)
  })
})
