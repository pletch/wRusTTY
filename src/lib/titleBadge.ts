/**
 * The symbol a program puts at the front of its own title (OSC 0/2).
 *
 * There's no icon protocol; the title is the one channel that survives SSH,
 * so programs lead with a character fonts draw in color (Claude Code's `✳`).
 * A heuristic on that convention, written to fail closed: ordinary titles
 * (`dev@build01: ~/src`, `vim README.md`) yield nothing. Pure; `TabBar.tsx`
 * draws the result.
 */

/**
 * Character classes a leading symbol may come from. Excludes anything a title
 * might start a sentence with (letters, digits, quotes, brackets, paths).
 *
 * - `Extended_Pictographic`: emoji proper, including `✳` U+2733.
 * - Geometric Shapes: non-emoji spinner frames (`◐◑◒◓`), which Claude Code
 *   cycles while working.
 * - Braille Patterns: the other common spinner alphabet (`⠋⠙⠹`).
 * - Misc Symbols and Arrows: remaining filled shapes.
 */
const BADGE_START =
  /^[\p{Extended_Pictographic}■-◿⠀-⣿⬀-⯿]/u

/**
 * `©` and `®` carved back out: typographic marks that can start ordinary
 * titles, and the only Latin-1 characters the accepted set reaches. `‼`, `⁉`
 * and `ℹ` stay, since they're only ever leading on purpose.
 */
const BADGE_EXCLUDE = /^[©®]/

/**
 * The first grapheme cluster, so ZWJ sequences and flags survive intact.
 * `Intl.Segmenter` exists in WebView2 and Node; the spread is a fallback.
 */
function firstGrapheme(s: string): string {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const first = seg.segment(s)[Symbol.iterator]().next()
    if (!first.done) return first.value.segment
  }
  return [...s][0] ?? ''
}

/**
 * Requests the color form of a character that has one but doesn't default to
 * it (`✳` is `Emoji_Presentation: no`). Blink prefers a text font for these,
 * so without U+FE0F it renders gray. Spinner frames have no color form and
 * keep the tab's text color, as in Windows Terminal.
 */
function withEmojiPresentation(grapheme: string): string {
  const cps = [...grapheme]
  // An existing selector is the program's choice. Multi-codepoint clusters are
  // left alone; appending would attach to the wrong character.
  if (cps.length !== 1) return grapheme
  const base = cps[0]
  if (!/\p{Extended_Pictographic}/u.test(base)) return grapheme
  if (/\p{Emoji_Presentation}/u.test(base)) return grapheme
  return `${base}️`
}

/**
 * The badge for a remote-set title, or null for an ordinary one. Leading
 * whitespace is skipped.
 */
export function titleBadge(title: string | null | undefined): string | null {
  if (!title) return null
  const trimmed = title.trimStart()
  if (trimmed === '') return null
  const first = firstGrapheme(trimmed)
  if (BADGE_EXCLUDE.test(first)) return null
  return BADGE_START.test(first) ? withEmojiPresentation(first) : null
}
