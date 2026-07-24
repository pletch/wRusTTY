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
 * So printable text is taken from `input`/`compositionend`, and keydown is left
 * to handle only what has no textual form — control combinations, named keys,
 * and Alt-modified keys, which Windows does not deliver as input at all. The
 * two paths cannot double up: whatever keydown claims, it also cancels, and a
 * cancelled keydown produces no input event.
 */
export class GhosttyInputHandler {
  private container: HTMLElement
  /** Focus lives here, not on the canvas — see the note above. */
  readonly element: HTMLTextAreaElement
  private onData: (data: Uint8Array) => void
  private encoder = new TextEncoder()
  private isAppCursorKeys: () => boolean
  private backspaceBehavior: 'delete' | 'backspace' = 'delete'
  private composing = false

  constructor(
    container: HTMLElement,
    onData: (data: Uint8Array) => void,
    isAppCursorKeys: () => boolean = () => false
  ) {
    this.container = container
    this.onData = onData
    this.isAppCursorKeys = isAppCursorKeys

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
    this.element = ta
    container.appendChild(ta)

    ta.addEventListener('keydown', this.handleKeyDown)
    ta.addEventListener('compositionstart', this.handleCompositionStart)
    ta.addEventListener('compositionend', this.handleCompositionEnd)
    ta.addEventListener('input', this.handleInput)
  }

  setBackspaceBehavior(behavior: 'delete' | 'backspace') {
    this.backspaceBehavior = behavior
  }

  focus() {
    this.element.focus({ preventScroll: true })
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
    this.element.removeEventListener('compositionstart', this.handleCompositionStart)
    this.element.removeEventListener('compositionend', this.handleCompositionEnd)
    this.element.removeEventListener('input', this.handleInput)
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

  private handleKeyDown = (e: KeyboardEvent) => {
    // Avoid interfering with browser shortcuts
    if (e.metaKey && e.key !== 'v' && e.key !== 'c') return;

    // A key that is feeding an IME belongs to the composition, not to us. 229
    // is the placeholder keycode browsers report while one is active, and some
    // of them omit isComposing on the first key of a composition.
    if (e.isComposing || e.keyCode === 229) return;

    let seq = '';
    const alt = e.altKey ? '\x1b' : '';

    // Calculate modifier mask for CSI sequences (1 + Shift*1 + Alt*2 + Ctrl*4)
    let modifier = 1;
    if (e.shiftKey) modifier += 1;
    if (e.altKey) modifier += 2;
    if (e.ctrlKey) modifier += 4;
    const modStr = modifier > 1 ? `;${modifier}` : '';

    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.length === 1) {
      // Basic ctrl mapping (a-z, [, ], \, ^, _)
      const k = e.key.toLowerCase();
      if (k >= 'a' && k <= 'z') {
        seq = String.fromCharCode(k.charCodeAt(0) - 96);
      } else if (k === '[') seq = '\x1b';
      else if (k === '\\') seq = '\x1c';
      else if (k === ']') seq = '\x1d';
      else if (k === '^') seq = '\x1e';
      else if (k === '_') seq = '\x1f';
      else if (k === ' ') seq = '\x00';
    } else {
      const appCursor = this.isAppCursorKeys() && modifier === 1;
      switch (e.key) {
        case 'Enter': seq = alt + '\r'; break;
        case 'Backspace':
          seq = alt + (this.backspaceBehavior === 'delete' ? '\x7f' : '\x08');
          break;
        case 'Tab':
          if (e.shiftKey) seq = '\x1b[Z';
          else seq = alt + '\t';
          break;
        case 'Escape': seq = '\x1b'; break;
        case 'ArrowUp': seq = modifier > 1 ? `\x1b[1${modStr}A` : (appCursor ? '\x1bOA' : '\x1b[A'); break;
        case 'ArrowDown': seq = modifier > 1 ? `\x1b[1${modStr}B` : (appCursor ? '\x1bOB' : '\x1b[B'); break;
        case 'ArrowRight': seq = modifier > 1 ? `\x1b[1${modStr}C` : (appCursor ? '\x1bOC' : '\x1b[C'); break;
        case 'ArrowLeft': seq = modifier > 1 ? `\x1b[1${modStr}D` : (appCursor ? '\x1bOD' : '\x1b[D'); break;
        case 'Home': seq = modifier > 1 ? `\x1b[1${modStr}H` : (appCursor ? '\x1bOH' : '\x1b[H'); break;
        case 'End': seq = modifier > 1 ? `\x1b[1${modStr}F` : (appCursor ? '\x1bOF' : '\x1b[F'); break;
        case 'PageUp': seq = `\x1b[5${modStr}~`; break;
        case 'PageDown': seq = `\x1b[6${modStr}~`; break;
        case 'Insert': seq = `\x1b[2${modStr}~`; break;
        case 'Delete': seq = `\x1b[3${modStr}~`; break;
        case 'F1': seq = modifier > 1 ? `\x1b[1${modStr}P` : '\x1bOP'; break;
        case 'F2': seq = modifier > 1 ? `\x1b[1${modStr}Q` : '\x1bOQ'; break;
        case 'F3': seq = modifier > 1 ? `\x1b[1${modStr}R` : '\x1bOR'; break;
        case 'F4': seq = modifier > 1 ? `\x1b[1${modStr}S` : '\x1bOS'; break;
        case 'F5': seq = `\x1b[15${modStr}~`; break;
        case 'F6': seq = `\x1b[17${modStr}~`; break;
        case 'F7': seq = `\x1b[18${modStr}~`; break;
        case 'F8': seq = `\x1b[19${modStr}~`; break;
        case 'F9': seq = `\x1b[20${modStr}~`; break;
        case 'F10': seq = `\x1b[21${modStr}~`; break;
        case 'F11': seq = `\x1b[23${modStr}~`; break;
        case 'F12': seq = `\x1b[24${modStr}~`; break;
        default:
          // Alt-modified printable keys only. Windows does not deliver these as
          // text input, so keydown is the only place they exist — but plain
          // printable keys are deliberately left alone, because taking them
          // here is what stopped composed characters from ever arriving.
          if (e.key.length === 1 && e.altKey && !e.ctrlKey && !e.metaKey) {
            seq = alt + e.key;
          }
      }
    }

    if (seq) {
      e.preventDefault();
      e.stopPropagation();
      this.onData(this.encoder.encode(seq));
    }
  };
}
