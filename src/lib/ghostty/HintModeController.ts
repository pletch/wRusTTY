import type { Link, LinkKind } from './LinkController'

/**
 * Opening a link with the keyboard: every link on screen gets a short label;
 * typing one opens it; Escape leaves. Like kitty's `hints` kitten and
 * Alacritty's hints, for when a full-screen program owns the mouse.
 *
 * Shaped like `MarkModeController`: takes the keyboard only while on, draws
 * its own state, and leaves on one Escape. Hints are snapshotted in absolute
 * coordinates, so labels stay on their text as output scrolls.
 */

/** One label, and where it is painted. Absolute buffer coordinates. */
export interface Hint {
  label: string
  row: number
  col: number
  url: string
  kind: LinkKind
}

/**
 * Home row first, then by reachability. Two-character labels use the same
 * alphabet: 26 links take one keystroke, 676 two.
 */
const ALPHABET = 'asdfghjklqwertyuiopzxcvbnm'

export interface HintModeHost {
  /** Every link with a cell on screen. */
  linksInViewport(): Link[]
  /** The absolute rows currently on screen, `bottom` inclusive. */
  viewport(): { top: number; bottom: number }
  cols(): number
  /** Sets the labels to paint (or null) and marks the view dirty. */
  setHints(hints: Hint[] | null): void
  /** Opens a link via the engine's own path, with the same scheme check as
   *  Ctrl+click. */
  openLink(url: string, kind: LinkKind): void
  /** The mode turned on or off, for the pane's indicator. */
  notifyMode(active: boolean): void
}

export class HintModeController {
  private active = false
  private hints: Hint[] = []
  /** The label being typed, always a prefix of some hint's label; a keystroke
   *  that would break that is dropped, so a typo costs one key. */
  private typed = ''

  private readonly host: HintModeHost

  constructor(host: HintModeHost) {
    this.host = host
  }

  isActive(): boolean {
    return this.active
  }

  toggle(): void {
    if (this.active) this.exit()
    else this.enter()
  }

  /**
   * Enters the mode, labeling what's on screen. Enters even with nothing to
   * label: the indicator with no labels says "no links here", where a silent
   * no-op looks broken.
   */
  enter(): void {
    if (this.active) return
    this.active = true
    this.typed = ''
    this.hints = this.label(this.host.linksInViewport())
    this.paint()
    this.host.notifyMode(true)
  }

  exit(): void {
    if (!this.active) return
    this.active = false
    this.hints = []
    this.typed = ''
    this.host.setHints(null)
    this.host.notifyMode(false)
  }

  /** Yields to anything that takes over (a mouse press, teardown). */
  cancel(): void {
    this.exit()
  }

  /**
   * Offers a key to the mode. Returns true if consumed, in which case the
   * caller must stop it.
   *
   * Unnamed Ctrl/Alt/Meta combinations pass through, so the chord that opened
   * the mode also closes it. Plain printable keys are always swallowed, so
   * nothing reaches the shell by mistake.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false

    if (e.key === 'Escape') {
      this.exit()
      return true
    }
    if (e.key === 'Backspace') {
      this.typed = this.typed.slice(0, -1)
      this.paint()
      return true
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return false
    if (e.key.length !== 1) return false

    const ch = e.key.toLowerCase()
    if (!ALPHABET.includes(ch)) return true

    const next = this.typed + ch
    const exact = this.hints.find((h) => h.label === next)
    if (exact) {
      // Leave first, so the pane is normal whatever the opener does.
      this.exit()
      this.host.openLink(exact.url, exact.kind)
      return true
    }
    if (this.hints.some((h) => h.label.startsWith(next))) {
      this.typed = next
      this.paint()
    }
    return true
  }

  /** Labels still reachable from what has been typed. */
  private visible(): Hint[] {
    return this.typed === '' ? this.hints : this.hints.filter((h) => h.label.startsWith(this.typed))
  }

  private paint(): void {
    this.host.setHints(this.visible())
  }

  /**
   * Assigns labels and positions: over each link's first on-screen cells,
   * pulled back from the right margin if it wouldn't fit.
   */
  private label(links: Link[]): Hint[] {
    const { top, bottom } = this.host.viewport()
    const cols = this.host.cols()
    const width = links.length > ALPHABET.length ? 2 : 1
    const out: Hint[] = []

    // Beyond two characters' capacity, the rest go unlabeled.
    const capacity = width === 1 ? ALPHABET.length : ALPHABET.length * ALPHABET.length
    for (let i = 0; i < links.length && i < capacity; i++) {
      const link = links[i]
      const head = link.segments.find((s) => s.row >= top && s.row <= bottom)
      if (!head) continue
      const label =
        width === 1
          ? ALPHABET[i]
          : ALPHABET[Math.floor(i / ALPHABET.length)] + ALPHABET[i % ALPHABET.length]
      out.push({
        label,
        row: head.row,
        col: Math.max(0, Math.min(head.from, cols - label.length)),
        url: link.url,
        kind: link.kind,
      })
    }
    return out
  }
}
