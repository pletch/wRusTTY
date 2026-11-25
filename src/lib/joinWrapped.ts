/**
 * "Paste as one line": joins a multi-line paste back into the one command it
 * probably was.
 *
 * The case this exists for is a long command copied out of Claude Code.
 * Claude Code wraps lines itself, then builds the clipboard from the cells it
 * drew and sends it over OSC 52, so every wrap arrives as a real newline. The
 * terminal's wrap flags are never involved. The user picks this option, since
 * only they know whether the newlines were meant. This module decides how
 * each break is joined:
 *
 * - A line ending in a continuation (`\` for POSIX shells, a backtick for
 *   PowerShell) drops it and joins with a space.
 * - A line that reaches the right edge of the pane that sent the copy was
 *   cut in the middle of a token, such as a long URL or path, so it joins
 *   with nothing in between.
 * - Every other break joins with one space, and the next line's indentation
 *   is dropped.
 *
 * The edge is only known for text that arrived over OSC 52. See
 * [`rememberRemoteCopy`].
 */

/**
 * How far short of the source pane's width the widest line can be and still
 * mark the edge. It covers a right margin in the program that drew the text.
 * If the widest line falls short by more than this, nothing was wrapped.
 */
const EDGE_SLACK = 6

/** The most recent OSC 52 write, from any pane. A copy made in one tab is
 *  usually pasted into another, so this is module state, not per pane. */
let lastRemoteCopy: { text: string; cols: number } | null = null

/** Records an OSC 52 write and the width of the pane it came from. */
export function rememberRemoteCopy(text: string, cols: number): void {
  lastRemoteCopy = text && cols > 0 ? { text: normalize(text), cols } : null
}

/**
 * The width of the pane that copied `text` over OSC 52, or null when the
 * clipboard no longer holds that copy. Trailing newlines are ignored, since
 * the paste path strips one.
 */
export function remoteCopyWidth(text: string): number | null {
  if (!lastRemoteCopy) return null
  return normalize(text) === lastRemoteCopy.text ? lastRemoteCopy.cols : null
}

/** For tests. */
export function forgetRemoteCopy(): void {
  lastRemoteCopy = null
}

function normalize(text: string): string {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '')
}

/**
 * Joins `text` into one line.
 *
 * @param sourceCols width of the pane the text was copied from, or null when
 *                   unknown. Without it, no break is treated as a mid-token
 *                   cut and every break becomes a space.
 */
export function joinWrapped(text: string, sourceCols: number | null): string {
  // Trailing whitespace is padding, never content: renderers pad rows and
  // some copies keep it.
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, ''))
  const edge = findEdge(lines, sourceCols)

  let out = lines[0].replace(/^\s+/, '')
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    const next = lines[i + 1].replace(/^\s+/, '')
    if (next === '') continue

    const continued = /(?:^|\s)[\\`]$/.exec(line)
    if (continued) {
      out = out.replace(/\s*[\\`]$/, '')
      out += (out === '' ? '' : ' ') + next
    } else if (edge !== null && displayWidth(line) >= edge && out !== '') {
      out += next
    } else {
      out += (out === '' ? '' : ' ') + next
    }
  }
  return out
}

/**
 * The column a full line ends at, or null when no line got close enough to
 * the source width to have wrapped.
 *
 * The widest line stands in for the edge, since a program may leave a right
 * margin. That only works when at least one line actually wrapped. A widest
 * line well short of the pane means none did.
 */
function findEdge(lines: string[], sourceCols: number | null): number | null {
  if (!sourceCols || lines.length < 2) return null
  // The last line can't have wrapped, since nothing follows it.
  let widest = 0
  for (let i = 0; i < lines.length - 1; i++) widest = Math.max(widest, displayWidth(lines[i]))
  if (widest > sourceCols || widest < sourceCols - EDGE_SLACK) return null
  return widest
}

/**
 * Terminal columns `s` takes, approximately: wide East Asian characters and
 * emoji count 2, combining marks and zero-width characters count 0.
 * Close enough to find a line that filled the pane, which is all this is
 * used for.
 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (isZeroWidth(cp)) continue
    w += isWide(cp) ? 2 : 1
  }
  return w
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space, joiners, marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x20d0 && cp <= 0x20ff) // combining marks for symbols
  )
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo extended A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B onward
  )
}
