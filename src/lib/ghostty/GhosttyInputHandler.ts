/**
 * Keyboard input for the Ghostty engine.
 *
 * Input arrives through an offscreen textarea, since composed text (IME
 * input, dead keys) never appears as a keydown. Two paths: text the browser
 * composes arrives via `input`/`compositionend`; everything else goes to the
 * engine's encoder (`KeyEncoder.ts`), which picks the bytes and the protocol.
 * They can't double up: whatever keydown claims it cancels, and a canceled
 * keydown produces no input event. The encoder's null for a key with no
 * sequence is what lets the text path deliver it.
 */
import {
  legacyModifiedBytes,
  softModifierArmed,
  takeSoftModifiers,
  type SoftModifiers,
} from '../softModifiers'
import type { InputIntent } from '../terminalEngine'
import type { KeyEncoder } from './KeyEncoder'

/** The input's accessible name, which is how the key row finds the focused one. */
export const TERMINAL_INPUT_LABEL = 'Terminal input'

export class GhosttyInputHandler {
  private container: HTMLElement
  /** Focus lives here, not on the canvas. */
  readonly element: HTMLTextAreaElement
  private onData: (data: Uint8Array, intent: InputIntent) => void
  private encoder = new TextEncoder()
  /**
   * Null for the few milliseconds before the pane's WASM is up. Keys then
   * produce no sequence; text still goes out via `input`.
   */
  private keyEncoder: () => KeyEncoder | null
  private composing = false
  /**
   * Takes text that is a paste rather than typing, so it goes through the
   * host's paste guard. Returns false when nobody claimed it, and the text is
   * then sent as typed. See [`isPasteLike`].
   */
  pasteSink: ((text: string) => boolean) | null = null
  /** A key-row modifier took this composition's text; its result is stale. */
  private dropComposition = false

  constructor(
    container: HTMLElement,
    onData: (data: Uint8Array, intent: InputIntent) => void,
    keyEncoder: () => KeyEncoder | null = () => null
  ) {
    this.container = container
    this.onData = onData
    this.keyEncoder = keyEncoder

    const ta = document.createElement('textarea')
    ta.setAttribute('aria-label', TERMINAL_INPUT_LABEL)
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('autocapitalize', 'off')
    ta.spellcheck = false
    ta.tabIndex = 0
    // Invisible but present: a hidden or zero-sized element can't hold focus, and
    // the IME positions its candidate window against this box.
    const s = ta.style
    s.position = 'absolute'
    s.zIndex = '1'
    s.width = '1px'
    s.height = '1px'
    s.padding = '0'
    s.margin = '0'
    s.border = 'none'
    s.outline = 'none'
    s.resize = 'none'
    s.overflow = 'hidden'
    s.opacity = '0'
    s.background = 'transparent'
    s.color = 'transparent'
    s.caretColor = 'transparent'
    s.whiteSpace = 'nowrap'
    // It sits over the cursor cell, so clicks (including right-clicks) must pass
    // through to the terminal.
    s.pointerEvents = 'none'
    this.element = ta
    container.appendChild(ta)

    ta.addEventListener('keydown', this.handleKeyDown)
    // Releases matter only when a Kitty-protocol application asks; the encoder
    // returns null until then.
    ta.addEventListener('keyup', this.handleKeyUp)
    ta.addEventListener('compositionstart', this.handleCompositionStart)
    ta.addEventListener('compositionend', this.handleCompositionEnd)
    ta.addEventListener('input', this.handleInput)
    ta.addEventListener('blur', this.handleBlur)
  }

  focus() {
    this.element.focus({ preventScroll: true })
  }

  /**
   * Clears an in-flight IME composition. Switching to another Windows app fires
   * no `blur` (WebView2 keeps this the active element), so a composition can be
   * stranded, leaving `handleInput` dropping every printable key while
   * Enter and arrows still work. Called on a programmatic refocus.
   */
  cancelComposition() {
    this.composing = false
    this.element.value = ''
  }

  /**
   * Rebuilds the textarea's link to the OS input method. After window
   * deactivation WebView2 can leave it focused with a dead input context
   * (keydown fires, `input` doesn't); a blur and refocus re-establishes it.
   */
  resetForRefocus() {
    this.cancelComposition()
    this.element.blur()
    // Refocus a frame later: a blur and focus in one task can be coalesced away.
    requestAnimationFrame(() => this.element.focus({ preventScroll: true }))
  }

  private handleBlur = () => {
    // End any composition on blur too.
    this.cancelComposition()
  }

  /**
   * Parks the input box on the cursor cell, where the IME puts its candidate
   * window.
   */
  setCursorPosition(left: number, top: number) {
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  dispose() {
    this.element.removeEventListener('keydown', this.handleKeyDown)
    this.element.removeEventListener('keyup', this.handleKeyUp)
    this.element.removeEventListener('compositionstart', this.handleCompositionStart)
    this.element.removeEventListener('compositionend', this.handleCompositionEnd)
    this.element.removeEventListener('input', this.handleInput)
    this.element.removeEventListener('blur', this.handleBlur)
    if (this.element.parentNode === this.container) {
      this.container.removeChild(this.element)
    }
  }

  private send(text: string) {
    if (text) this.onData(this.encoder.encode(text), { kind: 'text' })
  }

  /** Sends `text`, unless it's a paste and the host took it. */
  private deliver(text: string, inputType: string | null) {
    if (isPasteLike(text, inputType) && this.pasteSink?.(text)) return
    this.send(text)
  }

  private handleCompositionStart = () => {
    this.composing = true
  }

  private handleCompositionEnd = (e: CompositionEvent) => {
    this.composing = false
    if (!this.dropComposition) this.deliver(e.data, null)
    this.element.value = ''
  }

  /**
   * The key after an armed Ctrl or Alt, typed on the soft keyboard. It can't wait
   * for the composition to finish: a keyboard composing a word wouldn't deliver
   * the `c` of Ctrl+C until the next space.
   */
  private sendModified(char: string, mods: SoftModifiers, composing: boolean) {
    const key = /^[A-Z]$/.test(char) ? char.toLowerCase() : char
    const event = new KeyboardEvent('keydown', { key, ctrlKey: mods.ctrl, altKey: mods.alt })
    this.onData(this.keyEncoder()?.encode(event) ?? legacyModifiedBytes(key, mods), { kind: 'key', event })
    this.element.value = ''
    if (!composing) return
    // End the composition, or the keyboard keeps building on the character just
    // sent and everything typed next is lost with it.
    this.dropComposition = true
    this.resetForRefocus()
    requestAnimationFrame(() => {
      this.dropComposition = false
    })
  }

  private handleInput = (e: Event) => {
    const ie = e as InputEvent
    if (softModifierArmed() && ie.data) {
      const char = [...ie.data].pop()!
      this.sendModified(char, takeSoftModifiers(), this.composing || ie.isComposing)
      return
    }
    // Mid-composition input is the preedit being revised, not text to send.
    if (this.composing || ie.isComposing) return
    // The composed result arrives via compositionend and again here; skip this
    // one.
    if (ie.inputType === 'insertCompositionText') {
      this.element.value = ''
      return
    }
    // A native paste carries its text in `dataTransfer`, or only in the box's
    // value, rather than in `data`.
    const text =
      typeof ie.data === 'string'
        ? ie.data
        : PASTE_INPUT_TYPES.has(ie.inputType)
          ? ie.dataTransfer?.getData('text/plain') || this.element.value
          : null
    if (text) this.deliver(text, ie.inputType)
    // Clear it so a stale value doesn't reach the next composition.
    this.element.value = ''
  }

  /**
   * Whether this event is the engine's to encode. Refused:
   *
   * - **An event the app already claimed.** In-app bindings (copy, paste,
   *   search, mark mode, tab shortcuts in `App.tsx`) run on a capture listener
   *   and call `preventDefault`. The encoder maps Ctrl+Shift+C to `^C`, so this
   *   check is what keeps those bindings off the wire.
   * - **A Super chord**, which belongs to the OS.
   * - **An IME's key**: keycode 229, since some browsers omit `isComposing` on
   *   a composition's first key.
   */
  private isOurs(e: KeyboardEvent): boolean {
    if (e.defaultPrevented) return false
    if (e.metaKey) return false
    if (e.isComposing || e.keyCode === 229) return false
    return true
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.isOurs(e)) return
    const event = softModifierArmed() ? withSoftModifiers(e) : e
    const bytes = this.keyEncoder()?.encode(event)
    // No sequence: a bare modifier, or a character the browser is about to
    // deliver as text. Leave the event alone so that text arrives.
    if (!bytes) return
    e.preventDefault()
    e.stopPropagation()
    this.onData(bytes, { kind: 'key', event })
  }

  /**
   * Key releases, which encode to nothing unless a Kitty-protocol application
   * asked for them; the encoder tracks that flag. Never canceled: a release
   * has no default worth suppressing, and canceling can confuse IMEs.
   */
  private handleKeyUp = (e: KeyboardEvent) => {
    if (!this.isOurs(e)) return
    const bytes = this.keyEncoder()?.encode(e)
    if (bytes) this.onData(bytes, { kind: 'key', event: e })
  }
}

/** Input types the browser uses for text that was pasted or dropped. */
const PASTE_INPUT_TYPES = new Set(['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop'])

/**
 * Whether text arriving in the input box is a paste, which must go through
 * the paste guard rather than out as keystrokes.
 *
 * The browser says so for a native paste. A keyboard's clipboard panel
 * (Gboard's chip, for one) usually doesn't: it commits the text as if typed.
 * So text with a line break inside it counts too, since typing never produces
 * one mid-text. A lone or trailing line break doesn't count: some keyboards
 * send Enter that way, and it has to stay a Return.
 */
export function isPasteLike(text: string, inputType: string | null): boolean {
  if (inputType !== null && PASTE_INPUT_TYPES.has(inputType)) return true
  return /[\r\n]/.test(text.replace(/[\r\n]+$/, ''))
}

/** A key event with the armed key-row modifiers added, disarming them. */
function withSoftModifiers(e: KeyboardEvent): KeyboardEvent {
  const mods = takeSoftModifiers()
  return new KeyboardEvent(e.type, {
    key: e.key,
    code: e.code,
    repeat: e.repeat,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey || mods.ctrl,
    altKey: e.altKey || mods.alt,
  })
}
