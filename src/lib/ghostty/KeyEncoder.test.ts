import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { KeyEncoder } from './KeyEncoder'
import { createTerminal, instantiateGhosttyWasm, writeString, type GhosttyWasm } from './wasmBindings'

/**
 * The key encoder, against the binary that ships.
 *
 * This is the suite that replaced a hand-rolled keyboard table, so what it is
 * really asserting is that the replacement covers the ground the table did and
 * the ground it missed. The sequences below are not invented here — they are
 * what the protocols specify and what Ghostty produces — so a failure means
 * either the DOM-to-`GhosttyKeyEvent` mapping has drifted or the pinned binary
 * has changed its mind, and both are worth stopping for.
 *
 * The Kitty cases matter most. Nothing in this app decides to speak that
 * protocol: the far end asks with `CSI > flags u`, and these tests ask the
 * same way, through the terminal, which is the only route a real session has.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, 'vendor/ghostty-vt.wasm')

/** A `KeyboardEvent` as far as `KeyEncoder` is concerned — no DOM needed. */
function key(
  code: string,
  init: {
    key?: string
    type?: 'keydown' | 'keyup'
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
    meta?: boolean
    repeat?: boolean
    altGraph?: boolean
    numLock?: boolean
  } = {},
): KeyboardEvent {
  const state: Record<string, boolean> = {
    AltGraph: init.altGraph ?? false,
    CapsLock: false,
    NumLock: init.numLock ?? false,
  }
  return {
    code,
    key: init.key ?? code,
    type: init.type ?? 'keydown',
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    metaKey: init.meta ?? false,
    repeat: init.repeat ?? false,
    isComposing: false,
    getModifierState: (name: string) => state[name] ?? false,
  } as unknown as KeyboardEvent
}

describe('KeyEncoder', () => {
  let wasm: GhosttyWasm

  beforeAll(async () => {
    wasm = await instantiateGhosttyWasm(Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer)
  })

  /** A fresh terminal and encoder per test: keyboard flags are terminal state,
   *  and a pushed flag stack would otherwise leak into the next case. */
  function boot() {
    const term = createTerminal(wasm, 80, 24, { scrollbackLimit: 0, fgColor: 0, bgColor: 0, cursorColor: 0 })
    const encoder = KeyEncoder.create(wasm, term)
    if (!encoder) throw new Error('the shipped binary has no key encoder')
    const encode = (e: KeyboardEvent) => {
      const bytes = encoder.encode(e)
      return bytes === null ? null : new TextDecoder().decode(bytes)
    }
    return { term, encode, write: (s: string) => writeString(wasm, term, s) }
  }

  describe('legacy encoding, which is what a terminal does until asked otherwise', () => {
    it('sends printable text as itself', () => {
      const { encode } = boot()
      expect(encode(key('KeyA', { key: 'a' }))).toBe('a')
      expect(encode(key('Digit1', { key: '!', shift: true }))).toBe('!')
    })

    it('maps the control keys', () => {
      const { encode } = boot()
      expect(encode(key('Enter'))).toBe('\r')
      expect(encode(key('Tab'))).toBe('\t')
      expect(encode(key('Escape'))).toBe('\x1b')
      expect(encode(key('Backspace'))).toBe('\x7f')
      expect(encode(key('Tab', { shift: true }))).toBe('\x1b[Z')
    })

    it('maps ctrl chords, including the ones the old table had no branch for', () => {
      const { encode } = boot()
      expect(encode(key('KeyA', { key: 'a', ctrl: true }))).toBe('\x01')
      expect(encode(key('KeyC', { key: 'c', ctrl: true }))).toBe('\x03')
      // Ctrl+Space is NUL, and Ctrl+/ is 0x1f. Neither existed before.
      expect(encode(key('Space', { key: ' ', ctrl: true }))).toBe('\x00')
      expect(encode(key('Slash', { key: '/', ctrl: true }))).toBe('\x1f')
    })

    it('sends Ctrl+Alt and Ctrl+Shift chords, which used to send nothing at all', () => {
      const { encode } = boot()
      // The old table's ctrl branch required !alt && !shift and its default
      // branch required !ctrl, so both of these fell between them.
      expect(encode(key('KeyA', { key: 'a', ctrl: true, alt: true }))).toBe('\x1b\x01')
      // A chord with no legacy byte at all comes out in the `CSI u` form even
      // without the Kitty protocol. This one is worth knowing about beyond its
      // own sake: the app binds Ctrl+Shift+C to copy, and the binding's comment
      // used to say it "maps to no terminal sequence". It does now.
      expect(encode(key('KeyC', { key: 'C', ctrl: true, shift: true }))).toBe('\x1b[99;5u')
    })

    it('distinguishes the modified Enter and Tab that legacy bytes cannot', () => {
      const { encode } = boot()
      // These are the chords a hand-rolled table flattens: \r for all three
      // Enters, \t for both Tabs. Upstream reaches for xterm's `CSI 27;m;k~`
      // rather than losing them, with no protocol negotiation involved.
      expect(encode(key('Enter'))).toBe('\r')
      expect(encode(key('Enter', { shift: true }))).toBe('\x1b[27;2;13~')
      expect(encode(key('Enter', { ctrl: true }))).toBe('\x1b[27;5;13~')
      expect(encode(key('Tab', { ctrl: true }))).toBe('\x1b[27;5;9~')
    })

    it('prefixes Alt with ESC', () => {
      const { encode } = boot()
      expect(encode(key('KeyB', { key: 'b', alt: true }))).toBe('\x1bb')
    })

    it('encodes the arrows, and follows DECCKM when the far end sets it', () => {
      const { encode, write } = boot()
      expect(encode(key('ArrowUp'))).toBe('\x1b[A')
      expect(encode(key('ArrowUp', { ctrl: true }))).toBe('\x1b[1;5A')
      write('\x1b[?1h')
      expect(encode(key('ArrowUp'))).toBe('\x1bOA')
      write('\x1b[?1l')
      expect(encode(key('ArrowUp'))).toBe('\x1b[A')
    })

    it('encodes the function keys legacy encoding has room for', () => {
      const { encode } = boot()
      expect(encode(key('F1'))).toBe('\x1bOP')
      expect(encode(key('F5'))).toBe('\x1b[15~')
      // F13 and up have no legacy encoding at all — upstream declines rather
      // than inventing one. They become reportable under Kitty; see below.
      expect(encode(key('F13'))).toBeNull()
    })

    it('encodes the keypad either way Num Lock is set', () => {
      const { encode } = boot()
      // Num Lock on, so the keypad types digits and `key` is the digit.
      expect(encode(key('Numpad1', { key: '1', numLock: true }))).toBe('1')
      // Num Lock off, so it navigates. The DOM still says `Numpad1` and only
      // `key` changes, which is the pair `keyFor` exists to disambiguate —
      // without it this is null and the numpad does nothing at all.
      expect(encode(key('Numpad1', { key: 'End' }))).toBe('\x1b[F')
      expect(encode(key('Numpad9', { key: 'PageUp' }))).toBe('\x1b[5~')
      expect(encode(key('NumpadEnter', { key: 'Enter' }))).toBe('\r')
    })

    it('answers null for a bare modifier and for every key release', () => {
      const { encode } = boot()
      expect(encode(key('ShiftLeft', { key: 'Shift', shift: true }))).toBeNull()
      expect(encode(key('KeyA', { key: 'a', type: 'keyup' }))).toBeNull()
    })
  })

  describe('kitty keyboard protocol, entered the way a program enters it', () => {
    it('disambiguates once the far end pushes the flag', () => {
      const { encode, write } = boot()
      expect(encode(key('Escape'))).toBe('\x1b')
      write('\x1b[>1u')
      // The point of the mode: Escape stops being ambiguous with the start of
      // every other sequence.
      expect(encode(key('Escape'))).toBe('\x1b[27u')
    })

    it('reports keys legacy encoding has no form for', () => {
      const { encode, write } = boot()
      expect(encode(key('F13'))).toBeNull()
      write('\x1b[>1u')
      expect(encode(key('F13'))).toBe('\x1b[57376u')
    })

    it('gives the modified Enters a form of their own', () => {
      const { encode, write } = boot()
      expect(encode(key('Enter'))).toBe('\r')
      write('\x1b[>1u')
      // Unmodified Enter keeps its legacy byte even here: `disambiguate` only
      // claims the keys that had no unambiguous encoding, which is what makes
      // it safe for a program to turn on and leave on.
      expect(encode(key('Enter'))).toBe('\r')
      expect(encode(key('Enter', { shift: true }))).toBe('\x1b[13;2u')
      expect(encode(key('Enter', { ctrl: true }))).toBe('\x1b[13;5u')
    })

    it('reports releases only once the far end asks for them', () => {
      const { encode, write } = boot()
      write('\x1b[>1u')
      expect(encode(key('KeyA', { key: 'a', type: 'keyup' }))).toBeNull()
      write('\x1b[>3u')
      expect(encode(key('KeyA', { key: 'a', type: 'keyup' }))).toBe('\x1b[97;1:3u')
    })

    it('drops back to legacy when the program pops its flags', () => {
      const { encode, write } = boot()
      write('\x1b[>1u')
      expect(encode(key('Escape'))).toBe('\x1b[27u')
      write('\x1b[<u')
      expect(encode(key('Escape'))).toBe('\x1b')
    })
  })

  describe('what it declines to encode', () => {
    it('leaves a dead key to the composition that follows it', () => {
      const { encode } = boot()
      expect(encode(key('Quote', { key: 'Dead' }))).toBeNull()
    })

    it('leaves AltGr to the browser, which is producing text with it', () => {
      const { encode } = boot()
      // Windows reports AltGr as Ctrl+Alt; only the modifier state tells them
      // apart, and encoding this one would send a chord instead of the `@` the
      // layout is producing.
      expect(encode(key('KeyQ', { key: '@', ctrl: true, alt: true, altGraph: true }))).toBeNull()
    })

    it('ignores a key it has no name for', () => {
      const { encode } = boot()
      expect(encode(key('LaunchVendorThing', { key: 'Unidentified' }))).toBeNull()
    })
  })

  /**
   * Events with no `code` on them, which is what an injected virtual key looks
   * like: Chromium fills `code` in from the hardware scan code, so anything
   * synthesized without one — an on-screen keyboard, a KVM or remote-desktop
   * stack, `SendInput` without `KEYEVENTF_SCANCODE` — arrives with `code: ""`.
   *
   * This is here because it was found in the running app rather than reasoned
   * about: driving the real window through `SendInput` produced a pane where
   * every arrow, function key and control chord was dead while plain letters
   * still typed, because those reach the wire through the browser's text path
   * and need no encoding. The table this file's subject replaced keyed off
   * `key`, so the swap would have taken that away from those users silently.
   */
  describe('an event that carries no code, as injected keys do', () => {
    it('still encodes a named key', () => {
      const { encode } = boot()
      expect(encode(key('', { key: 'ArrowUp' }))).toBe('\x1b[A')
      expect(encode(key('', { key: 'F5' }))).toBe('\x1b[15~')
    })

    it('still encodes a control chord, which has no text path to fall back on', () => {
      const { encode } = boot()
      expect(encode(key('', { key: 'a', ctrl: true }))).toBe('\x01')
    })

    it('does not guess at punctuation, where the code depends on the layout', () => {
      const { encode } = boot()
      // `/` is `Slash` on a US keyboard and something else elsewhere. Declining
      // sends nothing; guessing would send a different key.
      expect(encode(key('', { key: '/', ctrl: true }))).toBeNull()
    })

    it('never lets the fallback override a code the keyboard did report', () => {
      const { encode } = boot()
      // `code` wins: this stays an arrow rather than becoming the letter the
      // fallback would have derived from `key`.
      expect(encode(key('ArrowUp', { key: 'x' }))).toBe('\x1b[A')
    })

    it('takes the control byte from the character, not the physical key', () => {
      const { encode } = boot()
      // Not the fallback's doing — it is what upstream does whenever both are
      // present, and it is what makes Ctrl+chords right on a layout where the
      // key at `KeyA` produces something else. Pinned because it is the
      // assumption the fallback above is built on top of.
      expect(encode(key('KeyA', { key: 'q', ctrl: true }))).toBe('\x11')
    })
  })
})
