import type { Link, LinkKind } from './LinkController'

/**
 * Opening a link with the keyboard.
 *
 * Every link on screen gets a short label painted over its first cells; typing
 * a label opens that link; Escape leaves. kitty's `hints` kitten and
 * Alacritty's hints are the same idea, and both exist for the same reason:
 * a click gesture cannot be made to work while a full-screen program owns the
 * mouse, and there is nothing to click with on a machine being driven from the
 * keyboard alone.
 *
 * The sibling of `MarkModeController`, deliberately: a mode that takes the
 * keyboard only while it is on, draws its own state, gives everything back on
 * a single Escape, and tells the frontend so the mode never surprises anyone.
 * Read that file alongside this one — the shape is the same because the
 * problem is.
 *
 * Hints are snapshotted on entry, in **absolute** buffer coordinates. That is
 * what lets output keep arriving underneath the mode: a labelled link keeps
 * pointing at the same text as the screen scrolls, rather than the labels
 * being reshuffled — or the mode dropped — every time a line lands.
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
 * Home row first, then the rest of the keyboard in rough reachability order.
 * Two-character labels are drawn from the same alphabet, so 26 links are
 * one keystroke each and 676 are two.
 */
const ALPHABET = 'asdfghjklqwertyuiopzxcvbnm'

export interface HintModeHost {
  /** Every link with a cell on screen. */
  linksInViewport(): Link[]
  /** The absolute rows currently on screen, `bottom` inclusive. */
  viewport(): { top: number; bottom: number }
  cols(): number
  /** Hand the renderer the labels to paint, or null for none. Also marks the
   *  view dirty. */
  setHints(hints: Hint[] | null): void
  /** Open a link. The engine's own path, so the scheme check that guards
   *  Ctrl+click guards this too — and a path goes where a Ctrl+clicked path
   *  goes. */
  openLink(url: string, kind: LinkKind): void
  /** The mode turned on or off, for the pane's indicator. */
  notifyMode(active: boolean): void
}

export class HintModeController {
  private active = false
  private hints: Hint[] = []
  /** The label being typed. Only ever a prefix of some hint's label — a
   *  keystroke that would make it anything else is dropped rather than
   *  resetting, so a typo costs one key instead of the whole label. */
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
   * Enters the mode, labelling whatever is on screen.
   *
   * Deliberately enters even when there is nothing to label: the indicator
   * appearing with no labels under it says "there are no links here", which is
   * an answer. A chord that silently does nothing is indistinguishable from a
   * binding that is broken.
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

  /** The mode has to yield to anything that takes over — a mouse press, a
   *  teardown — or the keyboard stays captured behind labels nobody can see
   *  the point of any more. */
  cancel(): void {
    this.exit()
  }

  /**
   * Offers a key to the mode. Returns true if it was consumed, in which case
   * the caller must stop it going any further.
   *
   * Anything with Ctrl, Alt or Meta that this does not name is passed through,
   * so the app's own shortcuts keep working — including the chord that opened
   * the mode, which is therefore also the chord that closes it. Plain
   * printable keys are swallowed whether or not they name a label: typing is
   * what the mode suspends, and letting a stray keystroke reach the shell
   * while the user believes they are picking a link is how a mode like this
   * does damage.
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
      // Left before opening, so the pane is back to normal whatever the opener
      // does — including failing.
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
   * Assigns a label to each link and works out where to paint it.
   *
   * The label goes over the link's first cells *that are on screen* — a link
   * chased in from above the viewport has a head nobody can see — and is
   * pulled back from the right margin when it would not otherwise fit, since a
   * label half off the edge names nothing.
   */
  private label(links: Link[]): Hint[] {
    const { top, bottom } = this.host.viewport()
    const cols = this.host.cols()
    const width = links.length > ALPHABET.length ? 2 : 1
    const out: Hint[] = []

    // More links than two characters of this alphabet can name is not a screen
    // anyone is picking a link off; the rest simply go unlabelled.
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
