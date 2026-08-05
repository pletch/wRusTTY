// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { GhosttyInputHandler } from './GhosttyInputHandler'
import type { KeyEncoder } from './KeyEncoder'

/**
 * Which of the two input paths gets each event.
 *
 * `KeyEncoder.test.ts` covers what a key encodes to; this covers whether the
 * encoder is asked at all, which is a different question with different ways
 * to be wrong. Both failures are quiet: a key handed to the encoder that
 * should have been left alone sends a sequence where the user meant to copy,
 * and a key left alone that should have been encoded types nothing.
 *
 * The encoder is stubbed here on purpose. Everything below is about the
 * arbitration, and pinning it against real sequences would make these tests
 * fail for reasons that have nothing to do with what they are checking.
 */

function harness(encode: (e: KeyboardEvent) => Uint8Array | null) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const sent: string[] = []
  const handler = new GhosttyInputHandler(
    container,
    (bytes) => sent.push(new TextDecoder().decode(bytes)),
    () => ({ encode }) as unknown as KeyEncoder,
  )
  const press = (init: KeyboardEventInit, type: 'keydown' | 'keyup' = 'keydown') => {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    handler.element.dispatchEvent(e)
    return e
  }
  return { handler, sent, press, container }
}

const SEQ = new TextEncoder().encode('\x1b[A')

describe('which path an event takes', () => {
  it('sends what the encoder returns, and cancels the event so no text follows', () => {
    const { sent, press } = harness(() => SEQ)
    const e = press({ key: 'ArrowUp', code: 'ArrowUp' })
    expect(sent).toEqual(['\x1b[A'])
    // The cancellation is half the mechanism: an uncancelled keydown produces
    // an `input` event, and the same key would arrive twice.
    expect(e.defaultPrevented).toBe(true)
  })

  it('leaves an event alone when the encoder has no sequence for it', () => {
    const { sent, press } = harness(() => null)
    const e = press({ key: 'a', code: 'KeyA' })
    expect(sent).toEqual([])
    // Uncancelled on purpose: this is what lets the browser deliver the
    // character through `input`, which is the only path a composed or
    // dead-keyed character has.
    expect(e.defaultPrevented).toBe(false)
  })

  it('never asks about an event the app has already claimed', () => {
    const encode = vi.fn(() => SEQ)
    const { sent, press, container } = harness(encode)
    // Every in-app binding does exactly this, from a capture listener above
    // the input element.
    container.addEventListener('keydown', (e) => e.preventDefault(), true)
    press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    expect(encode).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('never asks about a Super chord', () => {
    const encode = vi.fn(() => SEQ)
    const { sent, press } = harness(encode)
    press({ key: 'l', code: 'KeyL', metaKey: true })
    expect(encode).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('never asks about a key that is feeding an IME', () => {
    const encode = vi.fn(() => SEQ)
    const { sent, press } = harness(encode)
    press({ key: 'Process', code: 'KeyA', keyCode: 229 })
    press({ key: 'a', code: 'KeyA', isComposing: true })
    expect(encode).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('sends a key release only when the encoder gives one bytes', () => {
    const { sent, press } = harness((e) => (e.type === 'keyup' ? SEQ : null))
    const e = press({ key: 'a', code: 'KeyA' }, 'keyup')
    expect(sent).toEqual(['\x1b[A'])
    // Not cancelled: a release has no default action worth suppressing.
    expect(e.defaultPrevented).toBe(false)
  })

  it('drops key releases while the far end has not asked for them', () => {
    const { sent, press } = harness(() => null)
    press({ key: 'a', code: 'KeyA' }, 'keyup')
    expect(sent).toEqual([])
  })

  it('still delivers composed text, which never reaches the encoder', () => {
    const encode = vi.fn(() => null)
    const { sent, handler } = harness(encode)
    handler.element.dispatchEvent(new CompositionEvent('compositionend', { data: 'ü' }))
    expect(sent).toEqual(['ü'])
    expect(encode).not.toHaveBeenCalled()
  })

  it('encodes nothing at all before the core is up', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const sent: string[] = []
    // The engine hands back null until its WASM instance exists — a few
    // milliseconds after mount. Text still gets out through `input`; control
    // keys are lost, which is the documented cost of not queueing them.
    const handler = new GhosttyInputHandler(container, (b) => sent.push(String(b)), () => null)
    const e = new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', cancelable: true })
    handler.element.dispatchEvent(e)
    expect(sent).toEqual([])
    expect(e.defaultPrevented).toBe(false)
  })
})
