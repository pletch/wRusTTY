import { describe, expect, it } from 'vitest'

import { translateBackspace } from './translateBackspace'

/**
 * DEL-to-BS translation, which moved from a string replace to a byte scan when
 * the engine's data channel became bytes.
 *
 * Two properties matter and neither is obvious from reading it. It must not
 * mutate what it is given — the same array goes to the wire *and* to the
 * broadcast fan-out, so an in-place edit would be applied twice or seen by a
 * consumer that did not ask for it. And it must be safe on a payload that is
 * not text at all, which is the whole reason the channel carries bytes: a
 * legacy mouse report past column 95 contains bytes above 0x7f.
 */

describe('translateBackspace', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b)

  it('returns the input untouched when the session never asked', () => {
    const input = bytes(0x61, 0x7f, 0x62)
    // The same array, not a copy: the overwhelmingly common case should cost
    // nothing at all.
    expect(translateBackspace(input, false)).toBe(input)
  })

  it('rewrites DEL to BS when it did', () => {
    expect([...translateBackspace(bytes(0x61, 0x7f, 0x62), true)]).toEqual([0x61, 0x08, 0x62])
  })

  it('leaves the caller s array alone', () => {
    const input = bytes(0x7f)
    const out = translateBackspace(input, true)
    expect([...out]).toEqual([0x08])
    // If this failed, a broadcast would translate bytes the wire had already
    // translated, and ^H would be sent where ^? was meant.
    expect([...input]).toEqual([0x7f])
    expect(out).not.toBe(input)
  })

  it('does not copy when there is nothing to change', () => {
    const input = bytes(0x61, 0x62)
    expect(translateBackspace(input, true)).toBe(input)
  })

  it('rewrites every occurrence', () => {
    expect([...translateBackspace(bytes(0x7f, 0x61, 0x7f), true)]).toEqual([0x08, 0x61, 0x08])
  })

  it('leaves a high byte in a mouse report alone', () => {
    // ESC [ M, button 0, column 101, row 2 — the legacy form, whose 0x85 is
    // not valid UTF-8 and which a string-based replace could not survive.
    const report = bytes(0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x22)
    expect([...translateBackspace(report, true)]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x22])
  })

  it('does not mistake a byte inside a UTF-8 sequence for DEL', () => {
    // 0x7f cannot appear as a continuation byte, so a bytewise scan is safe —
    // pinned because the string version was only safe by accident.
    const utf8 = new TextEncoder().encode('café 世界')
    expect([...translateBackspace(utf8, true)]).toEqual([...utf8])
  })

  it('handles an empty payload', () => {
    expect([...translateBackspace(bytes(), true)]).toEqual([])
  })
})
