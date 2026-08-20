import type { FontRange } from './settings'

/**
 * Turning the font settings into the four family strings the atlas rasterizes
 * with, plus the range table it consults before them.
 *
 * The interesting part is `fontFeatures`. Canvas 2D has no API for OpenType
 * feature tags — `fontVariantCaps` and `letterSpacing` exist, arbitrary tags
 * do not — so stylistic sets, character variants and slashed zeros look closed
 * off. They are not: `font-feature-settings` is a valid `@font-face`
 * *descriptor*, and Canvas resolves its font shorthand against document fonts.
 * Declare a face with the features baked in, hand the atlas its generated
 * name, and the features come through `fillText`.
 *
 * That was measured rather than assumed, and so were its two edges:
 *
 * - **Bold survives the wrapper.** A face declared `font-weight: 1 1000` and
 *   asked for bold renders pixel-identical to the family's own bold, with the
 *   features applied. So the body font can be wrapped once and cover both.
 * - **Italic does not.** Asking a wrapped face for italic renders the upright
 *   glyph when the wrapper declares `font-style: italic`, and something other
 *   than the family's real italic when it does not. So an *unset* italic slot
 *   is left unwrapped: it keeps rendering exactly as it always did, and the
 *   features simply do not reach it. Naming an italic face explicitly is what
 *   fixes that, because then the slot is a family we can wrap in its own
 *   right and ask for upright — no synthesis involved.
 */

/** What the atlas needs to pick a face for a given style and codepoint. */
export interface FontSelection {
  regular: string
  bold: string
  italic: string
  boldItalic: string
  /**
   * Whether each styled slot names a face directly. When it does, the CSS
   * weight/slant keyword must *not* also be emitted — asking a face that is
   * already italic for italic is what gets you a double slant, or an upright.
   */
  boldIsFace: boolean
  italicIsFace: boolean
  boldItalicIsFace: boolean
  /**
   * Whether bold-italic text still needs CSS to embolden it — true when the
   * bold-italic slot is an italic *face* being borrowed for it, which supplies
   * the slant and nothing else.
   *
   * Stated rather than inferred from the two families being equal: naming the
   * same face in both slots is a thing someone can do, and it would look
   * exactly like the borrowed case while meaning the opposite.
   */
  boldItalicNeedsWeight: boolean
  /** Sorted and non-overlapping, which is what `resolveRangeOverlaps` is for;
   *  `familyForCodepoint` is a binary search and means nothing otherwise. */
  ranges: ReadonlyArray<FontRange>
}

/** The subset of the settings this reads. */
export interface FontSettings {
  fontFamily: string
  fontFamilyBold: string
  fontFamilyItalic: string
  fontFamilyBoldItalic: string
  fontFeatures: string
  fontRanges: FontRange[]
}

/**
 * Generated faces, keyed by the family and feature string they were built
 * from. Registration is a document-level side effect and the faces are
 * immutable once added, so this is deliberately module scope rather than
 * per-pane: eight broadcast panes on the same font register one face, not
 * eight.
 */
const registered = new Map<string, string>()
let counter = 0

/**
 * Declares `family` again under a generated name, with `features` applied.
 *
 * `font-weight: 1 1000` is what keeps real bold reachable through the wrapper.
 * `font-style: normal` is deliberate and load-bearing: it says this face is
 * upright, so the caller must ask for upright and pick an italic *face* when
 * it wants slant, rather than asking this one to lean.
 */
function faceWithFeatures(family: string, features: string): string {
  const key = `${family}\u0000${features}`
  const existing = registered.get(key)
  if (existing) return existing

  const name = `wrustty-feat-${counter++}`
  try {
    const face = new FontFace(name, `local(${JSON.stringify(family)})`, {
      weight: '1 1000',
      style: 'normal',
      featureSettings: features,
    })
    // Added before it resolves: `load()` is a promise, the atlas rasterizes
    // synchronously, and a face that is still loading falls back for a frame
    // rather than failing. The engine redraws on the next write anyway.
    void face.load().then(
      (loaded) => document.fonts.add(loaded),
      () => {
        // A family the machine does not have. The generated name then resolves
        // to nothing, so fall back to naming the family directly — features
        // lost, glyphs correct, which is the right way round.
        registered.set(key, family)
      },
    )
    document.fonts.add(face)
  } catch {
    // FontFace rejects a malformed feature string by throwing. The setting is
    // free text, so this is a typo rather than an exceptional condition.
    registered.set(key, family)
    return family
  }
  registered.set(key, name)
  return name
}

/** The first family in a CSS list, unquoted — what `local()` needs. */
function headFamily(stack: string): string {
  const named = stack.match(/"([^"]+)"|'([^']+)'|^([^,]+)/)
  return (named?.[1] ?? named?.[2] ?? named?.[3] ?? stack).trim()
}

/**
 * A family string for one slot: the configured stack, wrapped so features
 * apply when there are any. The wrapper names only the head of the stack —
 * `local()` takes one family — so the *whole* configured stack is kept behind
 * it as fallback.
 *
 * Behind it rather than only its tail, because the generated name resolving to
 * nothing is a real outcome: the face is added before `load()` settles, so a
 * family the machine turns out not to have leaves the atlas holding a name no
 * face answers to. With the original stack still in the list that costs the
 * features and nothing else, instead of dropping to the webview default.
 */
function slot(stack: string, features: string): string {
  if (!features.trim()) return stack
  const head = headFamily(stack)
  if (!head) return stack
  const generated = faceWithFeatures(head, features)
  if (generated === head) return stack
  return `"${generated}", ${stack}`
}

export function buildFontSelection(s: FontSettings): FontSelection {
  const features = s.fontFeatures ?? ''
  const base = slot(s.fontFamily, features)

  const boldIsFace = s.fontFamilyBold.trim() !== ''
  const italicIsFace = s.fontFamilyItalic.trim() !== ''
  const boldItalicIsFace = s.fontFamilyBoldItalic.trim() !== ''

  return {
    regular: base,
    bold: boldIsFace ? slot(s.fontFamilyBold, features) : base,
    // The unwrapped stack when the slot is unset — see the note at the top of
    // this file. Features are given up rather than italic.
    italic: italicIsFace ? slot(s.fontFamilyItalic, features) : s.fontFamily,
    boldItalic: boldItalicIsFace
      ? slot(s.fontFamilyBoldItalic, features)
      : italicIsFace
        ? slot(s.fontFamilyItalic, features)
        : s.fontFamily,
    boldIsFace,
    italicIsFace,
    // A bold-italic slot is a face; so is falling back to the italic face and
    // letting CSS supply the weight, which is why this tracks the italic slot
    // when the bold-italic one is unset.
    boldItalicIsFace: boldItalicIsFace || italicIsFace,
    boldItalicNeedsWeight: !boldItalicIsFace && italicIsFace,
    ranges: s.fontRanges ?? [],
  }
}

/**
 * The family pinned to this codepoint, or null for "use the style's own".
 *
 * Binary search rather than a scan: this is called once per uncached glyph,
 * which is rare, but the table is user-supplied and nothing stops someone
 * pasting in a hundred ranges.
 */
export function familyForCodepoint(
  ranges: ReadonlyArray<FontRange>,
  cp: number,
): string | null {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (cp < r.lo) hi = mid - 1
    else if (cp > r.hi) lo = mid + 1
    else return r.family
  }
  return null
}

/**
 * The ranges that can actually be looked up, and the entries that cannot.
 *
 * `familyForCodepoint` binary-searches, which only means anything over a table
 * whose entries do not overlap: where two of them claim the same codepoint,
 * which one the search lands on is an accident of where the table happens to
 * split. The same character would then resolve to one face or the other for no
 * reason visible to whoever wrote the table, and adding an unrelated range
 * further down could change the answer.
 *
 * So an entry overlapping one already kept is set aside whole rather than
 * clipped to fit. A range that quietly covers less than it says is the harder
 * thing to notice, and the caller can say out loud that it was ignored.
 *
 * Ordered by where each range starts and then by the wider one first, so which
 * entry wins is a property of the table rather than of the order it was typed.
 */
export function resolveRangeOverlaps(ranges: ReadonlyArray<FontRange>): {
  kept: FontRange[]
  ignored: number[]
} {
  const order = ranges.map((_, i) => i)
  order.sort((a, b) => ranges[a].lo - ranges[b].lo || ranges[b].hi - ranges[a].hi)
  const kept: FontRange[] = []
  const ignored: number[] = []
  let claimed = -1
  for (const i of order) {
    const r = ranges[i]
    if (r.lo <= claimed) {
      ignored.push(i)
      continue
    }
    kept.push(r)
    claimed = r.hi
  }
  return { kept, ignored }
}

/**
 * Whether the feature string and the ligature toggle are asking for opposite
 * things, and which way round.
 *
 * They can, because they work at different levels and neither can see the
 * other. The toggle decides whether a run of operators is handed to `fillText`
 * in one call — shaping cannot happen at all unless it is. The feature string
 * reaches the face itself, and turning `calt` off there stops the substitution
 * even when the run does arrive whole. So:
 *
 * - `features-win`: the toggle is on and a feature switches the substitution
 *   off. Ligatures do not appear, and the toggle looks broken.
 * - `toggle-wins`: a feature asks for ligatures while the toggle is off. The
 *   run is never assembled, so the feature has nothing to act on.
 *
 * Neither is a bug — each is the lower level doing what it was told — but
 * either one looks like one, which is why the settings dialog says so.
 */
export type LigatureConflict = 'features-win' | 'toggle-wins' | null

/** The tags a face forms operator ligatures through. `liga` and `clig` are
 *  the standard ones, `calt` is what the programming faces actually use, and
 *  `dlig` is where a few of them put the more opinionated shapes. */
const LIGATURE_TAGS = ['calt', 'liga', 'clig', 'dlig']

export function ligatureConflict(features: string, ligatures: boolean): LigatureConflict {
  let switchedOff = false
  let switchedOn = false
  for (const tag of LIGATURE_TAGS) {
    // `"calt" 0`, `"calt" off`, and the bare `"calt"` which means on.
    const m = features.match(new RegExp(`["']${tag}["']\\s*(\\d+|on|off)?`, 'i'))
    if (!m) continue
    const value = (m[1] ?? '1').toLowerCase()
    if (value === '0' || value === 'off') switchedOff = true
    else switchedOn = true
  }
  if (ligatures && switchedOff) return 'features-win'
  if (!ligatures && switchedOn) return 'toggle-wins'
  return null
}

/** A codepoint written the way the Unicode charts write it, which is how
 *  anyone looking a range up will have seen it. */
export function formatCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * A codepoint typed by hand, or null if it is not one yet.
 *
 * Always hex, with the `U+` and `0x` prefixes accepted and ignored: every
 * table anyone would copy a range out of is written in hex, and a field that
 * guessed between bases would read `1000` as two different characters
 * depending on how it felt.
 */
export function parseCodepoint(text: string): number | null {
  const cleaned = text.trim().replace(/^(?:U\+|0x)/i, '')
  if (!/^[0-9a-f]{1,6}$/i.test(cleaned)) return null
  const cp = parseInt(cleaned, 16)
  return cp <= 0x10ffff ? cp : null
}

/** Whether two range tables say the same thing. Both are in the order they
 *  were typed, and a reordering is a change, so this compares position by
 *  position rather than as sets. */
export function sameRanges(a: ReadonlyArray<FontRange>, b: ReadonlyArray<FontRange>): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.lo === b[i].lo && r.hi === b[i].hi && r.family === b[i].family)
  )
}

/** A selection that names one stack for everything — the shape every caller
 *  had before per-style faces existed, and what the bench engine still wants. */
export function plainSelection(family: string): FontSelection {
  return {
    regular: family,
    bold: family,
    italic: family,
    boldItalic: family,
    boldIsFace: false,
    italicIsFace: false,
    boldItalicIsFace: false,
    boldItalicNeedsWeight: false,
    ranges: [],
  }
}
