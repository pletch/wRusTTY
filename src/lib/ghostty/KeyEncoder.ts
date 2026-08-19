/**
 * Keyboard encoding, done by the engine rather than by us.
 *
 * ## Why this exists
 *
 * `GhosttyInputHandler` used to carry its own table: a modifier mask, a switch
 * over named keys, SS3 for application cursor mode. It was about ninety lines
 * and it was wrong in ways that are invisible until someone hits them —
 * Ctrl+Alt+letter and Ctrl+Shift+anything fell between its two branches and
 * produced *nothing at all*; there was no Ctrl+digit and no Ctrl+Space; and
 * Shift+Enter, Ctrl+Enter and Ctrl+Tab were indistinguishable from the
 * unmodified key, which is the exact thing modern TUIs ask for the Kitty
 * keyboard protocol in order to tell apart. `KeyEncoder.test.ts` pins each of
 * those, against the binary rather than against a belief about it.
 *
 * None of that is unusual. Legacy xterm encoding, xterm's `modifyOtherKeys`
 * and the Kitty protocol are three overlapping specifications, and the far
 * end switches between them at runtime with sequences nobody's hand-rolled
 * table is watching for. Ghostty implements all three and reads its own
 * terminal state to decide which applies, so this is a wrapper, not a port.
 *
 * ## Which protocol is in force
 *
 * Not our decision, and not a setting. `setopt_from_terminal` reads the modes
 * the *application* has set — DECCKM, DECKPAM, `modifyOtherKeys`, and the
 * Kitty flag stack pushed with `CSI > flags u` — and applies them to the
 * encoder. So a pane speaks the Kitty protocol from the moment something in
 * it asks to, for as long as it asks, and drops back to legacy encoding when
 * that program exits and pops its flags. It is re-read per keystroke because
 * that push can arrive between any two of them, and it costs a handful of
 * loads against a keyboard's ~10 events a second.
 *
 * One of those modes looks inert and is not. **Application keypad mode does
 * nothing until the application also clears DEC 1035**, which defaults to on
 * and hard-disables the keypad mode whenever it is set — xterm's modern
 * default, and upstream's. `ESC =` alone therefore changes no numpad output,
 * which reads exactly like an unimplemented mode. It is implemented;
 * `KeyEncoder.test.ts` pins the whole keypad both ways round.
 *
 * ## What still has to be decided here
 *
 * The DOM does not describe a key event the way the encoder wants one:
 *
 * - **The physical key** is `KeyboardEvent.code`, which is the same W3C
 *   vocabulary `GhosttyKey` is built from — a lookup (see `keyAbi.ts`). An
 *   event injected rather than typed can carry no `code` at all, and
 *   `keyFor` falls back to `key` for those; the note there says why.
 * - **The text** is `KeyboardEvent.key`, but only when it is a single
 *   character. The header is explicit that this must be the character
 *   *before* any Ctrl/Meta transformation and must never be a C0 control, so
 *   `Enter`, `Tab` and friends pass no text and let the encoder work from the
 *   logical key.
 * - **The unshifted codepoint** is only knowable when Shift is not down. On a
 *   non-US layout the browser will not say what the key would have produced
 *   unshifted, and guessing from `code` assumes a US keyboard — so it is left
 *   at zero, which costs the Kitty protocol's alternate-key reporting and
 *   nothing else.
 * - **Modifier sides** (left vs right Ctrl) are not knowable either:
 *   `location` describes the key that was pressed, not which Shift is being
 *   held while some other key is. Upstream expects platforms that can't say.
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
 * Room for one encoded key. The longest thing the encoder produces is a Kitty
 * report carrying associated text, which is still well under this; the
 * `OUT_OF_SPACE` path below is what makes the number a starting point rather
 * than a limit, so it does not have to be argued about.
 */
const BUF_BYTES = 128

/** UTF-8 for one key's text. A grapheme, not a paste — 16 bytes is generous. */
const UTF8_BYTES = 16

/**
 * A `code` we don't recognise, or one that produces text through a route
 * keydown cannot see. Encoding these would be worse than declining: the
 * encoder would fall back to the logical key and send *something*, where
 * declining lets the browser's own text path deliver the real character.
 */
function isEncodable(e: KeyboardEvent): boolean {
  // A dead key is the first half of a composition. The character arrives later
  // through `compositionend`; the key itself has no sequence, and encoding it
  // by physical key would send the unaccented character now and the accented
  // one after.
  if (e.key === 'Dead' || e.key === 'Unidentified') return false
  // AltGr. Windows reports it as Ctrl+Alt, which is indistinguishable from a
  // real Ctrl+Alt chord except through this — and on the layouts where it
  // matters (a German `@`, a Polish `ą`) it is *producing text*, so it belongs
  // to the text path. Chromium implements the modifier state; a browser that
  // doesn't returns false and loses only the distinction we never had.
  if (e.getModifierState('AltGraph')) return false
  return keyFor(e.code, e.key) !== KEY_UNIDENTIFIED
}

/** The single character `key` names, or null for a named key or a C0. */
function textOf(e: KeyboardEvent): string | null {
  // Codepoints, not UTF-16 units: an astral character is one key's worth of
  // text and two units long.
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

    // The one option `setopt_from_terminal` cannot derive, and it resets this
    // to false on every call anyway. Set once for the record: there is no
    // option key on the platform this ships to, and treating a hypothetical
    // one as Alt is the behaviour a terminal wants.
    const optSlot = ex.ghostty_wasm_alloc(1)
    new Uint8Array(ex.memory.buffer, optSlot, 1)[0] = 0
    ex.ghostty_key_encoder_setopt(this.encoder, KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT, optSlot)
    ex.ghostty_wasm_free(optSlot, 1)
  }

  /**
   * An encoder over a live terminal, or null when the binary has no key
   * encoder in it.
   *
   * That is only ever the v1.3.1 build, which nothing in the app loads — it is
   * kept as the port's test oracle (`vendor-131/README.md`). Returning null
   * rather than throwing keeps that build usable for the suites that compare
   * against it, at the price of a pane with no control keys, which is a
   * trade only a test ever makes.
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
   * The bytes a key event should put on the wire, or null for a key that
   * produces none.
   *
   * Null is an ordinary answer, not a failure: a bare Shift press encodes to
   * nothing, and so does every key release unless the far end has asked for
   * release events through the Kitty protocol. The caller uses it to decide
   * whether to consume the event — see `GhosttyInputHandler`.
   */
  encode(e: KeyboardEvent): Uint8Array | null {
    if (!isEncodable(e)) return null
    const { ex } = this

    // The application's modes as of *this* keystroke; see the note above.
    ex.ghostty_key_encoder_setopt_from_terminal(this.encoder, this.term)

    ex.ghostty_key_event_set_action(
      this.event,
      e.type === 'keyup' ? KEY_ACTION_RELEASE : e.repeat ? KEY_ACTION_REPEAT : KEY_ACTION_PRESS,
    )
    ex.ghostty_key_event_set_key(this.event, keyFor(e.code, e.key))
    ex.ghostty_key_event_set_mods(this.event, modsOf(e))
    // Nothing here consumes a modifier before the encoder sees it — a
    // translation layer that did (macOS option-as-text) would report it here
    // so the encoder leaves it out of the sequence.
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
      // Only meaningful unshifted — see the header comment.
      ex.ghostty_key_event_set_unshifted_codepoint(this.event, e.shiftKey ? 0 : text.codePointAt(0)!)
    }

    return this.run()
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
      // `len` is now the size required. Nothing observed needs this — the
      // fixed buffer holds every sequence the protocols define — so the grown
      // buffer is not kept: paying an allocation on a keystroke that will
      // likely never happen again beats holding the memory for the pane's
      // life.
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
    // Copied out: the next keystroke writes over this buffer, and linear
    // memory can move under a view that outlives the call.
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
 * `GhosttyMods` for a DOM event.
 *
 * Caps and Num Lock are included because the Kitty protocol reports them and
 * because `IGNORE_KEYPAD_WITH_NUMLOCK` (DEC 1035) is a mode a far end can set;
 * without Num Lock the encoder cannot honour it.
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
