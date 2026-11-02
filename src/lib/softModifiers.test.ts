// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { GhosttyInputHandler, TERMINAL_INPUT_LABEL } from './ghostty/GhosttyInputHandler'
import { KeyEncoder } from './ghostty/KeyEncoder'
import { createTerminal, instantiateGhosttyWasm, writeString } from './ghostty/wasmBindings'
import {
  legacyModifiedBytes,
  softModifiers,
  takeSoftModifiers,
  toggleSoftModifier,
} from './softModifiers'

/**
 * The key row's Ctrl and Alt, through the real input handler and the encoder in
 * the shipped binary. Soft keyboards send text with no key codes, so what's
 * pinned is that a bare character plus a modifier still makes the right bytes.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, 'ghostty/vendor/ghostty-vt.wasm')

function typed(data: string, composing = false): InputEvent {
  return new InputEvent('input', {
    data,
    inputType: composing ? 'insertCompositionText' : 'insertText',
    isComposing: composing,
  })
}

describe('soft modifiers', () => {
  let encoder: KeyEncoder
  let terminalWrite: (s: string) => void

  beforeAll(async () => {
    const wasm = await instantiateGhosttyWasm(Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer)
    const term = createTerminal(wasm, 80, 24, {
      scrollbackLimit: 1024 * 1024,
      fgColor: 0,
      bgColor: 0,
      cursorColor: 0,
    })
    encoder = KeyEncoder.create(wasm, term)!
    terminalWrite = (s) => writeString(wasm, term, s)
  })

  afterEach(() => {
    takeSoftModifiers()
    terminalWrite('\x1bc')
  })

  function handler() {
    const sent: number[][] = []
    const h = new GhosttyInputHandler(document.body, (d) => sent.push([...d]), () => encoder)
    return { h, sent, el: h.element }
  }

  it('leaves plain typing alone', () => {
    const { h, sent, el } = handler()
    el.dispatchEvent(typed('c'))
    expect(sent).toEqual([[0x63]])
    h.dispose()
  })

  it('turns the next typed character into Ctrl+C, once', () => {
    const { h, sent, el } = handler()
    toggleSoftModifier('ctrl')
    el.dispatchEvent(typed('c'))
    el.dispatchEvent(typed('c'))
    expect(sent).toEqual([[0x03], [0x63]])
    expect(softModifiers().ctrl).toBe(false)
    h.dispose()
  })

  it('treats an auto-capitalized letter as the same key', () => {
    const { h, sent, el } = handler()
    toggleSoftModifier('ctrl')
    el.dispatchEvent(typed('C'))
    expect(sent).toEqual([[0x03]])
    h.dispose()
  })

  it('prefixes Alt with an escape', () => {
    const { h, sent, el } = handler()
    toggleSoftModifier('alt')
    el.dispatchEvent(typed('b'))
    expect(sent).toEqual([[0x1b, 0x62]])
    h.dispose()
  })

  it('does not wait for a composing keyboard to finish the word', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    const { h, sent, el } = handler()
    el.dispatchEvent(new CompositionEvent('compositionstart'))
    toggleSoftModifier('ctrl')
    el.dispatchEvent(typed('c', true))
    expect(sent).toEqual([[0x03]])
    vi.unstubAllGlobals()
    h.dispose()
  })

  it('does not send the composition a modifier already took', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    const { h, sent, el } = handler()
    el.dispatchEvent(new CompositionEvent('compositionstart'))
    toggleSoftModifier('ctrl')
    el.dispatchEvent(typed('c', true))
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'c' }))
    expect(sent).toEqual([[0x03]])
    // Once that's over, the next composition goes through as normal.
    for (const frame of frames) frame(0)
    el.dispatchEvent(new CompositionEvent('compositionstart'))
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'ls' }))
    expect(sent).toEqual([[0x03], [0x6c, 0x73]])
    vi.unstubAllGlobals()
    h.dispose()
  })

  it('adds the modifier to a key from the key row', () => {
    const { h, sent, el } = handler()
    toggleSoftModifier('ctrl')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', cancelable: true }))
    expect(String.fromCharCode(...sent[0])).toBe('\x1b[1;5D')
    expect(softModifiers().ctrl).toBe(false)
    h.dispose()
  })

  it('sends Escape, Tab and arrows like physical keys', () => {
    const { h, sent, el } = handler()
    for (const key of ['Escape', 'Tab', 'ArrowUp']) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, cancelable: true }))
    }
    expect(sent.map((s) => String.fromCharCode(...s))).toEqual(['\x1b', '\t', '\x1b[A'])
    h.dispose()
  })

  it('follows the mode a full-screen program set', () => {
    // Why these go through the encoder rather than a table of sequences: vim asks
    // for application cursor keys, and a fixed `ESC [ A` would be wrong.
    terminalWrite('\x1b[?1h')
    const { h, sent, el } = handler()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', cancelable: true }))
    expect(String.fromCharCode(...sent[0])).toBe('\x1bOA')
    h.dispose()
  })

  it('names the input the way the key row looks for it', () => {
    const { h, el } = handler()
    expect(el.getAttribute('aria-label')).toBe(TERMINAL_INPUT_LABEL)
    h.dispose()
  })
})

describe('legacyModifiedBytes', () => {
  const bytes = (char: string, ctrl: boolean, alt = false) => [...legacyModifiedBytes(char, { ctrl, alt })]

  it('maps Ctrl onto the control characters', () => {
    expect(bytes('c', true)).toEqual([0x03])
    expect(bytes('[', true)).toEqual([0x1b])
    expect(bytes('?', true)).toEqual([0x7f])
    expect(bytes(' ', true)).toEqual([0x00])
  })

  it('leaves a character with no control form as it is', () => {
    expect(bytes('1', true)).toEqual([0x31])
  })

  it('combines Ctrl and Alt', () => {
    expect(bytes('c', true, true)).toEqual([0x1b, 0x03])
  })
})
