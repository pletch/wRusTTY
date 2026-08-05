/**
 * Keyboard input for the Ghostty engine.
 *
 * Input arrives through an offscreen textarea rather than straight off the
 * canvas. A canvas can take focus and report keydown, which is enough for
 * control keys, and that is all this used to do — but it is not enough for
 * text. Anything composed rather than typed outright never appears as a
 * keydown: an IME sends `keyCode: 229` placeholders and delivers the real
 * characters through composition events, and a dead key on an international
 * layout reports `key: "Dead"` and then hands the accented character over the
 * same way. Both were dropped on the floor.
 *
 * So there are two paths, and this file is the arbitration between them. Text
 * that the browser composes arrives through `input`/`compositionend`;
 * everything else is handed to the engine's own key encoder
 * (`KeyEncoder.ts`), which decides both what bytes a key produces and which
 * protocol — legacy, `modifyOtherKeys`, or Kitty — it produces them in. The
 * two paths cannot double up: whatever keydown claims, it also cancels, and a
 * cancelled keydown produces no input event.
 *
 * The encoder decides *whether* it claims a key, too. It answers null for a
 * key that has no sequence, and that null is what lets the browser's text
 * path deliver characters keydown has no business inventing.
 */
import type { KeyEncoder } from './KeyEncoder'

export class GhosttyInputHandler {
  private container: HTMLElement
  /** Focus lives here, not on the canvas — see the note above. */
  readonly element: HTMLTextAreaElement
  private onData: (data: Uint8Array) => void
  private encoder = new TextEncoder()
  /**
   * Null until the pane's WASM instance is up, which is a few milliseconds
   * after mount. Keys pressed in that window produce no sequence — text still
   * goes out through the `input` path, since nothing cancels it — and the
   * alternative was a queue whose only customer is somebody typing Ctrl+C at
   * a terminal that has not drawn yet.
   */
  private keyEncoder: () => KeyEncoder | null
  private composing = false

  constructor(
    container: HTMLElement,
    onData: (data: Uint8Array) => void,
    keyEncoder: () => KeyEncoder | null = () => null
  ) {
    this.container = container
    this.onData = onData
    this.keyEncoder = keyEncoder

    const ta = document.createElement('textarea')
    ta.setAttribute('aria-label', 'Terminal input')
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('autocapitalize', 'off')
    ta.spellcheck = false
    ta.tabIndex = 0
    // Invisible but genuinely present: a display:none or zero-sized element
    // can't hold focus, and the IME's candidate window is positioned against
    // this box, so it has to sit where the cursor is (see setCursorPosition).
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
    // It sits over the canvas at the cursor cell, so without this a click that
    // happened to land on it would hit an invisible textarea instead of the
    // terminal — including a right-click, which would raise the webview's own
    // context menu over the pane's.
    s.pointerEvents = 'none'
    this.element = ta
    container.appendChild(ta)

    ta.addEventListener('keydown', this.handleKeyDown)
    // Releases matter only under the Kitty protocol, and only when the far end
    // has asked for them. Asking the encoder is how that is discovered: it
    // answers null for every release until an application sets the flag.
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
   * Clears any in-flight IME composition. A `compositionstart` can be stranded
   * with no matching `compositionend` — switching to another Windows app does
   * not fire `blur` and WebView2 keeps this textarea as the active element, so
   * the composition never closes. Left stuck, `composing` stays true and
   * `handleInput` drops every printable key as pre-edit; only keydown-handled
   * keys (Enter, arrows) still reach the wire — the tell for this wedge. The
   * engine calls this on a programmatic refocus (tab switch, window/app return).
   */
  cancelComposition() {
    this.composing = false
    this.element.value = ''
  }

  /**
   * Rebuilds the textarea's link to the OS input method. When the app window is
   * deactivated and reactivated, WebView2 can leave this element focused yet with
   * a dead input/IME context: keydown still fires (Enter, arrows work) but the
   * `input`/composition events that carry printable text no longer do. Blurring
   * and refocusing forces the input context to be re-established. Called on
   * window/app return; a plain focus() is not enough.
   */
  resetForRefocus() {
    this.cancelComposition()
    this.element.blur()
    // Defer the refocus a frame: a blur immediately followed by focus on the
    // same element within one task can be coalesced away, which would leave the
    // input context un-rebuilt. Letting the blur settle first is what makes the
    // rebuild actually happen.
    requestAnimationFrame(() => this.element.focus({ preventScroll: true }))
  }

  private handleBlur = () => {
    // When blur does fire (focus moving within the window), end any composition
    // too — the same strand can otherwise outlive the focus change.
    this.cancelComposition()
  }

  /**
   * Parks the input box on the cursor cell. Nothing is drawn there, but this is
   * where the IME puts its candidate window, and an IME anchored to the corner
   * of the pane while you type in the middle of it is disorienting.
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
    if (text) this.onData(this.encoder.encode(text))
  }

  private handleCompositionStart = () => {
    this.composing = true
  }

  private handleCompositionEnd = (e: CompositionEvent) => {
    this.composing = false
    this.send(e.data)
    this.element.value = ''
  }

  private handleInput = (e: Event) => {
    const ie = e as InputEvent
    // Mid-composition input is the preedit being revised, not text to send.
    if (this.composing || ie.isComposing) return
    // The composed result arrives once through compositionend and again here;
    // this is that second delivery.
    if (ie.inputType === 'insertCompositionText') {
      this.element.value = ''
      return
    }
    if (typeof ie.data === 'string') this.send(ie.data)
    // Left to accumulate, the box would eventually hold the whole session and
    // hand a stale value to the next composition.
    this.element.value = ''
  }

  /**
   * Whether this event is the engine's to encode at all.
   *
   * Three things get first refusal, and each is a case where sending bytes
   * would be actively wrong rather than merely unhelpful:
   *
   * - **An event the app already claimed.** Every in-app binding — copy,
   *   paste, search, mark mode, the tab shortcuts in `App.tsx` — runs on a
   *   capture listener above this element and calls `preventDefault`. Testing
   *   for that here is what keeps the two sets from having to know about each
   *   other. It matters more than it used to: those handlers were written
   *   against a keyboard that mapped Ctrl+Shift+C to nothing, and the encoder
   *   maps it to `^C`, so "consuming it costs nothing on the wire" is no
   *   longer true and this is what makes it true again.
   * - **A Super chord.** Win+L, Win+D and the rest belong to the OS, and a
   *   terminal that encoded them would be reporting keys the user never gave
   *   it.
   * - **An IME's key.** 229 is the placeholder keycode browsers report while
   *   a composition is active, and some omit `isComposing` on the first key
   *   of one.
   */
  private isOurs(e: KeyboardEvent): boolean {
    if (e.defaultPrevented) return false
    if (e.metaKey) return false
    if (e.isComposing || e.keyCode === 229) return false
    return true
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.isOurs(e)) return
    const bytes = this.keyEncoder()?.encode(e)
    // No sequence: a bare modifier, a key the encoder has no opinion on, or
    // one whose character the browser is about to deliver as text. Leaving the
    // event alone is what lets that text arrive — cancelling it here is
    // precisely what used to lose composed characters.
    if (!bytes) return
    e.preventDefault()
    e.stopPropagation()
    this.onData(bytes)
  }

  /**
   * Key releases, which encode to nothing at all unless the far end has asked
   * for them with the Kitty protocol's `report events` flag. There is no test
   * for that flag here on purpose: the encoder holds the terminal's state and
   * answers null while it is off, so this stays correct through an
   * application setting and clearing it mid-session.
   *
   * Not cancelled even when it does produce bytes — a release has no default
   * action worth suppressing, and cancelling one has been known to confuse
   * IMEs.
   */
  private handleKeyUp = (e: KeyboardEvent) => {
    if (!this.isOurs(e)) return
    const bytes = this.keyEncoder()?.encode(e)
    if (bytes) this.onData(bytes)
  }
}
