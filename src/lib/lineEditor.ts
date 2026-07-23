

/** A minimal local line editor for serial's "Readline"/"Readline (hex)"
 * input modes — xterm.js has no line-editing of its own, so keystrokes are
 * normally sent to the wire one at a time as they're typed. This buffers
 * them locally instead (with basic editing and history, similar to a
 * shell's own readline) and only calls `onSubmit` once with the completed
 * line when Enter is pressed, so devices that expect a whole line at once
 * (or don't echo their own input) work as expected.
 *
 * Deliberately supports only the common case — insert/delete at cursor,
 * left/right/home/end movement, and history recall — not a full emacs-style
 * binding set (kill-line, word-jump, etc.), which real shells' readline
 * implementations have but nothing here needs to match exactly.
 */
export class LineEditor {
  private buffer: string[] = []
  private cursor = 0
  private history: string[] = []
  private historyIndex = -1
  private stash = ''
  private term: { write(data: string): void }
  private onSubmit: (line: string) => void

  constructor(term: { write(data: string): void }, onSubmit: (line: string) => void) {
    this.term = term
    this.onSubmit = onSubmit
  }

  /** Shows the prompt for a fresh, empty line — call once when readline
   * mode becomes active (e.g. right after connecting). */
  start() {
    this.buffer = []
    this.cursor = 0
    this.term.write('> ')
  }

  handleData(data: string) {
    switch (data) {
      case '\r':
      case '\n':
        this.submit()
        return
      case '\x7f':
      case '\x08':
        this.backspace()
        return
      case '\x1b[3~':
        this.deleteForward()
        return
      case '\x1b[D':
        this.moveLeft()
        return
      case '\x1b[C':
        this.moveRight()
        return
      case '\x1b[A':
        this.historyUp()
        return
      case '\x1b[B':
        this.historyDown()
        return
      case '\x1b[H':
      case '\x01':
        this.moveHome()
        return
      case '\x1b[F':
      case '\x05':
        this.moveEnd()
        return
      case '\x03':
        this.cancel()
        return
    }
    // Anything else recognizable as printable text (filters out other
    // escape sequences / control characters this editor doesn't handle,
    // rather than inserting their raw bytes into the composed line).
    for (const ch of data) {
      if (ch >= ' ' || ch === '\t') this.insert(ch)
    }
  }

  private redraw() {
    const line = this.buffer.join('')
    this.term.write(`\r\x1b[K> ${line}`)
    const back = this.buffer.length - this.cursor
    if (back > 0) this.term.write(`\x1b[${back}D`)
  }

  private insert(ch: string) {
    this.buffer.splice(this.cursor, 0, ch)
    this.cursor++
    this.redraw()
  }

  private backspace() {
    if (this.cursor === 0) return
    this.buffer.splice(this.cursor - 1, 1)
    this.cursor--
    this.redraw()
  }

  private deleteForward() {
    if (this.cursor >= this.buffer.length) return
    this.buffer.splice(this.cursor, 1)
    this.redraw()
  }

  private moveLeft() {
    if (this.cursor === 0) return
    this.cursor--
    this.redraw()
  }

  private moveRight() {
    if (this.cursor >= this.buffer.length) return
    this.cursor++
    this.redraw()
  }

  private moveHome() {
    this.cursor = 0
    this.redraw()
  }

  private moveEnd() {
    this.cursor = this.buffer.length
    this.redraw()
  }

  private historyUp() {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      this.stash = this.buffer.join('')
      this.historyIndex = this.history.length - 1
    } else if (this.historyIndex > 0) {
      this.historyIndex--
    }
    this.buffer = this.history[this.historyIndex].split('')
    this.cursor = this.buffer.length
    this.redraw()
  }

  private historyDown() {
    if (this.historyIndex === -1) return
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++
      this.buffer = this.history[this.historyIndex].split('')
    } else {
      this.historyIndex = -1
      this.buffer = this.stash.split('')
    }
    this.cursor = this.buffer.length
    this.redraw()
  }

  private cancel() {
    this.buffer = []
    this.cursor = 0
    this.historyIndex = -1
    this.term.write('\r\n> ')
  }

  private submit() {
    const line = this.buffer.join('')
    this.term.write('\r\n')
    if (line.length > 0) {
      this.history.push(line)
      if (this.history.length > 200) this.history.shift()
    }
    this.buffer = []
    this.cursor = 0
    this.historyIndex = -1
    this.onSubmit(line)
    this.term.write('> ')
  }
}

/** Parses a "Readline (hex)" line — whitespace-separated hex byte tokens,
 * each 1-2 hex digits, optionally "0x"-prefixed (e.g. "AA 0x1B FF") — into
 * raw bytes. Returns null if any token isn't valid hex, rather than
 * silently dropping or mis-sending part of the line. */
export function parseHexLine(line: string): Uint8Array | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  const bytes: number[] = []
  for (const raw of tokens) {
    const tok = raw.replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) return null
    bytes.push(parseInt(tok, 16))
  }
  return new Uint8Array(bytes)
}
