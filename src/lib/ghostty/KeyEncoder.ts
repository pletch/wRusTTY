/**
 * Keyboard encoding, done by the engine. Legacy xterm, `modifyOtherKeys` and
 * the Kitty protocol overlap and switch at runtime; Ghostty implements all
 * three, so this is a wrapper, not a port. `KeyEncoder.test.ts` pins the
 * results against the binary.
 *
 * ## Which protocol is in force
 *
 * Not a setting: `setopt_from_terminal` reads the modes the application set
 * (DECCKM, DECKPAM, `modifyOtherKeys`, the Kitty flag stack) per keystroke,
 * since a push can arrive between any two.
 *
 * Application keypad mode does nothing until the application also clears DEC
 * 1035, which defaults on (xterm's and upstream's default). So `ESC =` alone
 * changes no numpad output; that's correct, not unimplemented.
 *
 * ## What's decided here
 *
 * - **The physical key** is `KeyboardEvent.code`, the vocabulary `GhosttyKey`
 *   uses (see `keyAbi.ts`). An injected event without a `code` falls back to
 *   `key` in `keyFor`.
 * - **The text** is `KeyboardEvent.key` when it's a single character: before
 *   any Ctrl/Meta transformation and never a C0 control, so `Enter`, `Tab`
 *   and the like pass no text.
 * - **The unshifted codepoint** is only knowable without Shift; on non-US
 *   layouts it's left at zero, costing only Kitty's alternate-key reporting.
 * - **Modifier sides** (left vs right) aren't knowable, which upstream allows.
 */

import * as abi from './main/abi'
import {
  KEY_ACTION_PRESS,
  KEY_ACTION_RELEASE,
  KEY_ACTION_REPEAT,
  KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT,
  KEY_UNIDENTIFIED,
  MODS_ALT,
  MODS_CAPS_LOCK,
  MODS_CTRL,
  MODS_NUM_LOCK,
  MODS_SHIFT,
  MODS_SUPER,
  keyFor,
} from './main/keyAbi'
import type { GhosttyWasm } from './wasmBindings'

/**
 * Room for one encoded key; the `OUT_OF_SPACE` path below handles anything
 * longer.
 */
const BUF_BYTES = 128

/** UTF-8 for one key's text (a grapheme, not a paste). */
const UTF8_BYTES = 16

/**
 * Declines a `code` we don't recognize, or one producing text through a route
 * keydown can't see, so the browser's text path delivers the real character.
 */
function isEncodable(e: KeyboardEvent): boolean {
  // A dead key starts a composition; the character arrives via
  // `compositionend`. Encoding it would send the unaccented character first.
  if (e.key === 'Dead' || e.key === 'Unidentified') return false
  // AltGr: Windows reports it as Ctrl+Alt, but it produces text (German `@`,
  // Polish `ą`), so it belongs to the text path.
  if (e.getModifierState('AltGraph')) return false
  return keyFor(e.code, e.key) !== KEY_UNIDENTIFIED
}

/** The single character `key` names, or null for a named key or a C0. */
function textOf(e: KeyboardEvent): string | null {
  // Codepoints, not UTF-16 units.
  const chars = [...e.key]
  if (chars.length !== 1) return null
  const cp = chars[0].codePointAt(0)!
  if (cp < 0x20 || cp === 0x7f) return null
  return chars[0]
}

export class KeyEncoder {
  private readonly ex: abi.GhosttyMainExports
  private readonly term: number
  private readonly encoder: number
  private readonly event: number
  private readonly buf: number
  private readonly lenSlot: number
  private readonly utf8Buf: number
  private readonly encoderUtf8 = new TextEncoder()
  private view: DataView

  private constructor(ex: abi.GhosttyMainExports, term: number) {
    this.ex = ex
    this.term = term

    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_key_encoder_new(0, slot), 'key_encoder_new')
    this.view = new DataView(ex.memory.buffer)
    this.encoder = this.view.getUint32(slot, true)

    abi.expectOk(ex.ghostty_key_event_new(0, slot), 'key_event_new')
    this.view = new DataView(ex.memory.buffer)
    this.event = this.view.getUint32(slot, true)
    ex.ghostty_wasm_free_opaque(slot)

    this.buf = ex.ghostty_wasm_alloc(BUF_BYTES)
    this.utf8Buf = ex.ghostty_wasm_alloc(UTF8_BYTES)
    this.lenSlot = ex.ghostty_wasm_alloc(abi.USIZE_BYTES)

    // The one option `setopt_from_terminal` can't derive (and resets anyway).
    // There's no option key on Windows; treating one as Alt is what a terminal
    // wants.
    const optSlot = ex.ghostty_wasm_alloc(1)
    new Uint8Array(ex.memory.buffer, optSlot, 1)[0] = 0
    ex.ghostty_key_encoder_setopt(this.encoder, KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT, optSlot)
    ex.ghostty_wasm_free(optSlot, 1)
  }

  /**
   * An encoder over a live terminal, or null when the binary has no key encoder
   * (only the v1.3.1 test oracle, `vendor-131/README.md`). Null keeps that build
   * usable for comparison suites.
   */
  static create(wasm: GhosttyWasm, term: number): KeyEncoder | null {
    const ex = wasm.instance.exports as unknown as abi.GhosttyMainExports
    if (typeof ex.ghostty_key_encoder_new !== 'function') return null
    return new KeyEncoder(ex, term)
  }

  /** Re-made only when linear memory growth has detached the previous one. */
  private dv(): DataView {
    if (this.view.buffer !== this.ex.memory.buffer) {
      this.view = new DataView(this.ex.memory.buffer)
    }
    return this.view
  }

  /**
   * The bytes a key event should send, or null for none. Null is ordinary: a
   * bare Shift press, or a release the far end didn't ask for. The caller uses
   * it to decide whether to consume the event (see `GhosttyInputHandler`).
   */
  encode(e: KeyboardEvent): Uint8Array | null {
    if (!isEncodable(e)) return null
    const { ex } = this

    // The application's modes as of this keystroke.
    ex.ghostty_key_encoder_setopt_from_terminal(this.encoder, this.term)

    ex.ghostty_key_event_set_action(
      this.event,
      e.type === 'keyup' ? KEY_ACTION_RELEASE : e.repeat ? KEY_ACTION_REPEAT : KEY_ACTION_PRESS,
    )
    ex.ghostty_key_event_set_key(this.event, keyFor(e.code, e.key))
    ex.ghostty_key_event_set_mods(this.event, modsOf(e))
    // Nothing consumes a modifier before the encoder (a translation layer like
    // macOS option-as-text would report it here).
    ex.ghostty_key_event_set_consumed_mods(this.event, 0)
    ex.ghostty_key_event_set_composing(this.event, e.isComposing ? 1 : 0)

    const text = textOf(e)
    if (text === null) {
      ex.ghostty_key_event_set_utf8(this.event, 0, 0)
      ex.ghostty_key_event_set_unshifted_codepoint(this.event, 0)
    } else {
      const written = this.encoderUtf8.encodeInto(
        text,
        new Uint8Array(ex.memory.buffer, this.utf8Buf, UTF8_BYTES),
      ).written
      ex.ghostty_key_event_set_utf8(this.event, this.utf8Buf, written)
      // Only meaningful unshifted; see the header.
      ex.ghostty_key_event_set_unshifted_codepoint(this.event, e.shiftKey ? 0 : text.codePointAt(0)!)
    }

    return this.run()
  }

  /**
   * The bytes Ctrl+A would send: `^A` under legacy encoding, a CSI sequence
   * under `modifyOtherKeys` or Kitty. Only compared between calls, by
   * `sessionModes.leftoverModeReset`. (Ctrl+Enter doesn't work as a probe: the
   * core's `modifyOtherKeys` leaves keys without text alone.)
   */
  probeProtocol(): string {
    const { ex } = this
    ex.ghostty_key_encoder_setopt_from_terminal(this.encoder, this.term)
    ex.ghostty_key_event_set_action(this.event, KEY_ACTION_PRESS)
    ex.ghostty_key_event_set_key(this.event, keyFor('KeyA', 'a'))
    ex.ghostty_key_event_set_mods(this.event, MODS_CTRL)
    ex.ghostty_key_event_set_consumed_mods(this.event, 0)
    ex.ghostty_key_event_set_composing(this.event, 0)
    new Uint8Array(ex.memory.buffer, this.utf8Buf, 1)[0] = 0x61
    ex.ghostty_key_event_set_utf8(this.event, this.utf8Buf, 1)
    ex.ghostty_key_event_set_unshifted_codepoint(this.event, 0x61)
    const out = this.run()
    return out ? String.fromCharCode(...out) : ''
  }

  /** `encode`, then the buffer dance the C API asks for. */
  private run(): Uint8Array | null {
    const { ex } = this
    let result = ex.ghostty_key_encoder_encode(
      this.encoder,
      this.event,
      this.buf,
      BUF_BYTES,
      this.lenSlot,
    )
    let len = this.dv().getUint32(this.lenSlot, true)

    if (result === abi.GHOSTTY_OUT_OF_SPACE) {
      // `len` is now the size required. The grown buffer isn't kept; no observed
      // sequence needs it.
      const big = ex.ghostty_wasm_alloc(len)
      try {
        result = ex.ghostty_key_encoder_encode(this.encoder, this.event, big, len, this.lenSlot)
        len = this.dv().getUint32(this.lenSlot, true)
        if (result !== abi.GHOSTTY_SUCCESS || len === 0) return null
        return new Uint8Array(ex.memory.buffer, big, len).slice()
      } finally {
        ex.ghostty_wasm_free(big, len)
      }
    }

    if (result !== abi.GHOSTTY_SUCCESS || len === 0) return null
    // Copied out: the next keystroke reuses the buffer, and memory can move.
    return new Uint8Array(ex.memory.buffer, this.buf, len).slice()
  }

  dispose(): void {
    const { ex } = this
    ex.ghostty_key_encoder_free(this.encoder)
    ex.ghostty_key_event_free(this.event)
    ex.ghostty_wasm_free(this.buf, BUF_BYTES)
    ex.ghostty_wasm_free(this.utf8Buf, UTF8_BYTES)
    ex.ghostty_wasm_free(this.lenSlot, abi.USIZE_BYTES)
  }
}

/**
 * `GhosttyMods` for a DOM event. Caps and Num Lock are included: Kitty reports
 * them, and DEC 1035 (`IGNORE_KEYPAD_WITH_NUMLOCK`) needs Num Lock.
 */
export function modsOf(e: KeyboardEvent): number {
  let mods = 0
  if (e.shiftKey) mods |= MODS_SHIFT
  if (e.ctrlKey) mods |= MODS_CTRL
  if (e.altKey) mods |= MODS_ALT
  if (e.metaKey) mods |= MODS_SUPER
  if (e.getModifierState('CapsLock')) mods |= MODS_CAPS_LOCK
  if (e.getModifierState('NumLock')) mods |= MODS_NUM_LOCK
  return mods
}
