import { describe, expect, it } from 'vitest'

import { translateBackspace } from './translateBackspace'

/**
 * DEL-to-BS translation over bytes. It mustn't mutate its input (the same
 * array goes to the wire and to the broadcast fan-out), and it must be safe
 * on non-text payloads (a legacy mouse report past column 95 has bytes above
 * 0x7f).
 */

describe('translateBackspace', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b)

  it('returns the input untouched when the session never asked', () => {
    const input = bytes(0x61, 0x7f, 0x62)
    // The same array, not a copy: the common case costs nothing.
    expect(translateBackspace(input, false)).toBe(input)
  })

  it('rewrites DEL to BS when it did', () => {
    expect([...translateBackspace(bytes(0x61, 0x7f, 0x62), true)]).toEqual([0x61, 0x08, 0x62])
  })

  it('leaves the caller s array alone', () => {
    const input = bytes(0x7f)
    const out = translateBackspace(input, true)
    expect([...out]).toEqual([0x08])
    // Otherwise a broadcast would translate already-translated bytes.
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
    // ESC [ M, button 0, column 101, row 2: the legacy form, whose 0x85 isn't
    // valid UTF-8.
    const report = bytes(0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x22)
    expect([...translateBackspace(report, true)]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x22])
  })

  it('does not mistake a byte inside a UTF-8 sequence for DEL', () => {
    // 0x7f can't be a UTF-8 continuation byte, so a bytewise scan is safe.
    const utf8 = new TextEncoder().encode('café 世界')
    expect([...translateBackspace(utf8, true)]).toEqual([...utf8])
  })

  it('handles an empty payload', () => {
    expect([...translateBackspace(bytes(), true)]).toEqual([])
  })
})
