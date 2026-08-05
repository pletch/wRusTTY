import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { encodePaste, hasPasteEncoder, pasteIsSafe } from './pasteEncode'
import { instantiateGhosttyWasm, type GhosttyWasm } from './wasmBindings'

/**
 * Paste encoding, against the binary that ships.
 *
 * The case this file exists for is the first one under "the breakout": what
 * this replaced concatenated the bracket sequences around the clipboard text
 * without looking at it, so text containing the *end* sequence closed the
 * bracket early and everything after it arrived as typing. At a shell prompt
 * that is a command the user never ran, and a clipboard is exactly where such
 * bytes come from.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, 'vendor/ghostty-vt.wasm')

const START = '\x1b[200~'
const END = '\x1b[201~'

describe('paste encoding', () => {
  let wasm: GhosttyWasm

  beforeAll(async () => {
    wasm = await instantiateGhosttyWasm(Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer)
  })

  const enc = (text: string, bracketed: boolean) =>
    new TextDecoder().decode(encodePaste(wasm, text, bracketed))

  it('is present in the shipped binary', () => {
    expect(hasPasteEncoder(wasm)).toBe(true)
  })

  describe('the breakout', () => {
    it('defuses a bracketed-paste terminator hidden in the text', () => {
      // The whole point. Pasted verbatim this ends the bracket after "a" and
      // runs `b` as a typed command; the escape becomes a space instead, so
      // the sequence arrives inert.
      expect(enc(`a${END}b`, true)).toBe(`${START}a [201~b${END}`)
      // And the payload contains exactly one terminator: the real one, at the
      // end. That is the invariant the old code broke.
      expect(enc(`a${END}b`, true).split(END)).toHaveLength(2)
    })

    it('defuses it even when nothing is bracketing the paste', () => {
      expect(enc(`a${END}b`, false)).toBe('a [201~b')
    })

    it('refuses to call such text safe, however few lines it has', () => {
      // One line, no newline, and completely ordinary to a line count — which
      // is what the confirmation prompt used to be based on.
      expect(pasteIsSafe(wasm, `rm -rf /${END}`)).toBe(false)
    })
  })

  describe('what it considers safe to send unasked', () => {
    it('accepts ordinary single-line text', () => {
      expect(pasteIsSafe(wasm, 'git status')).toBe(true)
      expect(pasteIsSafe(wasm, 'a\tb')).toBe(true)
      expect(pasteIsSafe(wasm, '')).toBe(true)
    })

    it('refuses anything carrying a newline, which is a Return', () => {
      expect(pasteIsSafe(wasm, 'one\ntwo')).toBe(false)
    })

    it('accepts a bare carriage return, which upstream does not treat as a line break', () => {
      // Pinned because it is surprising rather than because it is desirable:
      // the rule is upstream's, and a change to it should show up here.
      expect(pasteIsSafe(wasm, 'a\rb')).toBe(true)
    })
  })

  describe('bracketed', () => {
    it('wraps the text', () => {
      expect(enc('hello', true)).toBe(`${START}hello${END}`)
    })

    it('keeps newlines, which is what bracketing exists to make safe', () => {
      // The program is told a paste is happening and can decline to run it,
      // so the newlines themselves need no rewriting.
      expect(enc('a\nb', true)).toBe(`${START}a\nb${END}`)
    })

    it('replaces control bytes that would be interpreted', () => {
      expect(enc('a\x00b', true)).toBe(`${START}a b${END}`)
      expect(enc('a\x7fb', true)).toBe(`${START}a b${END}`)
      expect(enc('a\x1bb', true)).toBe(`${START}a b${END}`)
    })

    it('brackets an empty paste rather than sending nothing', () => {
      expect(enc('', true)).toBe(`${START}${END}`)
    })

    it('leaves UTF-8 alone', () => {
      expect(enc('café 世界', true)).toBe(`${START}café 世界${END}`)
    })
  })

  describe('not bracketed', () => {
    it('sends the text as itself', () => {
      expect(enc('hello', false)).toBe('hello')
    })

    it('turns newlines into carriage returns', () => {
      // What this replaced sent the newline raw. A PTY wants CR for Enter —
      // it is what the line discipline is waiting for.
      expect(enc('a\nb', false)).toBe('a\rb')
      expect(enc('a\r\nb', false)).toBe('a\r\rb')
    })

    it('sends nothing for an empty paste', () => {
      expect(enc('', false)).toBe('')
    })
  })

  it('handles a paste far larger than any buffer it starts with', () => {
    // Sized as data + 12 up front, so this should still be one call; the
    // OUT_OF_SPACE retry path is the safety net rather than the mechanism.
    const big = 'x'.repeat(300_000)
    expect(enc(big, true)).toBe(`${START}${big}${END}`)
  })

  it('does not let one paste corrupt the next', () => {
    // The input buffer is modified in place, so a wrapper that reused it
    // would encode the stripped remains of the previous paste.
    expect(enc(`a${END}b`, true)).toBe(`${START}a [201~b${END}`)
    expect(enc(`a${END}b`, true)).toBe(`${START}a [201~b${END}`)
    expect(enc('plain', true)).toBe(`${START}plain${END}`)
  })
})
