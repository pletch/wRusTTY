/**
 * The symbol a program puts at the front of its own title (OSC 0/2).
 *
 * Not an icon protocol — there isn't one. A program that wants to mark itself
 * in a tab strip has exactly one channel that survives SSH, and that is the
 * title string, so it writes a character the terminal's font happens to draw
 * in colour and the title carries it along. Claude Code leads with `✳`, which
 * Segoe UI Emoji renders as a white asterisk on a green square; that is the
 * whole of the "custom tab icon" Windows Terminal appears to show, sitting in
 * the title text beside the real profile icon rather than replacing it.
 *
 * So this is a *heuristic on a convention*, not a parser for a format, and it
 * is written to fail closed: an ordinary title must yield nothing at all.
 * `tim@build01: ~/src` and `vim README.md` are the common case, and a badge
 * for either would be noise on every tab in the strip.
 *
 * Pure — no state, no DOM. `TabBar.tsx` owns where the result is drawn.
 */

/**
 * Character classes a leading symbol is accepted from. Deliberately narrow:
 * anything a title plausibly *starts a sentence* with is excluded, which is
 * why letters, digits, quotes, brackets and the path characters are absent.
 *
 * - `Extended_Pictographic` is emoji proper, and covers `✳` U+2733 along with
 *   the hourglasses and check marks CLIs reach for.
 * - Geometric Shapes carries the spinner frames that are *not* emoji — the
 *   half-filled circles `◐◑◒◓` an animating program cycles through. Claude
 *   Code swaps its asterisk for these while it works, so leaving them out
 *   would make the badge vanish for exactly the seconds it means the most.
 * - Braille Patterns is the other spinner alphabet in wide use (`⠋⠙⠹`).
 * - Misc Symbols and Arrows rounds out the filled shapes that neither of the
 *   above claims.
 */
const BADGE_START =
  /^[\p{Extended_Pictographic}■-◿⠀-⣿⬀-⯿]/u

/**
 * Carved back out of `Extended_Pictographic`, which is drawn wider than the
 * intent here: `©` and `®` are typographic marks that occur in ordinary text
 * — a title lifted from a page footer or a licence banner can begin with one —
 * and neither is used anywhere as a status badge. They are the only two
 * characters in Latin-1 the accepted set reaches, so excluding them is what
 * makes "no badge from an ASCII title" true without qualification.
 *
 * The other pictographics that are technically punctuation stay in: `‼`, `⁉`
 * and `ℹ` are drawn as colour emoji and are only ever put at the front of a
 * title on purpose, which is exactly the convention this reads.
 */
const BADGE_EXCLUDE = /^[©®]/

/**
 * The first grapheme cluster, so a multi-codepoint emoji survives intact — a
 * ZWJ sequence or a flag sliced at its first codepoint renders as a different
 * character, not a truncated one. `Intl.Segmenter` is present in WebView2 and
 * in the Node the tests run on; the spread is a floor for anything older, and
 * costs only the joiners.
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
 * Asks for the colour form of a character that has one but does not default
 * to it.
 *
 * Most of the marks worth badging — `✳` U+2733 among them — are
 * `Extended_Pictographic` but `Emoji_Presentation: no`, meaning their default
 * form is a monochrome *text* glyph. Windows Terminal shows `✳` green anyway
 * because DirectWrite's fallback happens to reach Segoe UI Emoji; Blink
 * deliberately prefers a text font for these, so the same character in our own
 * tab strip would come out grey and look nothing like the thing the user
 * recognises from every other terminal. U+FE0F is the standard way to say
 * "the colour one", rather than betting on a fallback chain.
 *
 * Only for characters that actually have a colour form. The spinner frames are
 * Geometric Shapes and Braille — not emoji at all, with no colour form to ask
 * for — so they stay text glyphs and take the tab's own colour, which is what
 * Windows Terminal shows for them too.
 */
function withEmojiPresentation(grapheme: string): string {
  const cps = [...grapheme]
  // A selector already present is the program's own statement about how it
  // wants to be drawn — U+FE0F for colour, U+FE0E for text. Neither is ours to
  // overrule. Multi-codepoint clusters are left alone for the same reason a
  // selector has to sit against its base: appending to the end of a ZWJ
  // sequence would attach it to the wrong character.
  if (cps.length !== 1) return grapheme
  const base = cps[0]
  if (!/\p{Extended_Pictographic}/u.test(base)) return grapheme
  if (/\p{Emoji_Presentation}/u.test(base)) return grapheme
  return `${base}️`
}

/**
 * The badge for a remote-set title, or null when the title is an ordinary one.
 *
 * Leading whitespace is skipped rather than disqualifying: a program that
 * writes `" ✳ Building"` means the same thing as one that writes `"✳ Building"`,
 * and which of the two you get is not a property worth surfacing.
 */
export function titleBadge(title: string | null | undefined): string | null {
  if (!title) return null
  const trimmed = title.trimStart()
  if (trimmed === '') return null
  const first = firstGrapheme(trimmed)
  if (BADGE_EXCLUDE.test(first)) return null
  return BADGE_START.test(first) ? withEmojiPresentation(first) : null
}
