import type { FontRange } from './settings'
import {
  bundledDefaultFeatures,
  bundledFaces,
  ensureBundledLoaded,
  weightDescriptor,
} from './bundledFonts'

/**
 * Turns the font settings into the four family strings the atlas rasterizes
 * with, plus the codepoint range table it checks first.
 *
 * Canvas 2D has no API for OpenType feature tags, but `font-feature-settings`
 * and `font-variation-settings` are valid `@font-face` descriptors, and Canvas
 * resolves its font shorthand against document fonts. So a face is declared
 * with the features baked in and the atlas is handed its generated name.
 *
 * Measured edges: bold survives the wrapper (a face declared
 * `font-weight: 1 1000` renders the family's real bold), italic doesn't. So an
 * unset italic slot is left unwrapped (no features, but the real italic); a
 * named italic face is wrapped in its own right.
 */

/** What the atlas needs to pick a face for a given style and codepoint. */
export interface FontSelection {
  regular: string
  bold: string
  italic: string
  boldItalic: string
  /**
   * Whether each styled slot names a face directly. Then the CSS weight/slant
   * keyword must not also be emitted (double slant, or upright).
   */
  boldIsFace: boolean
  italicIsFace: boolean
  boldItalicIsFace: boolean
  /**
   * Whether bold-italic text still needs CSS to embolden it: true when the slot
   * borrows the italic face. Stated explicitly, since naming the same face in
   * both slots looks identical but means the opposite.
   */
  boldItalicNeedsWeight: boolean
  /** Sorted and non-overlapping (see `resolveRangeOverlaps`) for
   *  `familyForCodepoint`'s binary search. */
  ranges: ReadonlyArray<FontRange>
  /** CSS numeric weights for regular and bold text, emitted unless the slot
   *  already names a face of that weight. */
  weight: number
  boldWeight: number
  /** Cell height as a multiple of the font size, and pixels added to the cell
   *  width; they rebuild the same renderer, so they ride along. */
  lineHeight: number
  letterSpacing: number
}

/** The subset of the settings this reads. */
export interface FontSettings {
  fontFamily: string
  fontFamilyBold: string
  fontFamilyItalic: string
  fontFamilyBoldItalic: string
  fontFeatures: string
  fontVariations: string
  fontRanges: FontRange[]
  fontWeight: number
  fontWeightBold: number
  lineHeightPercent: number
  letterSpacing: number
}

/**
 * Generated faces, keyed by family, features and axes. Module scope, since
 * registration is document-wide: panes on the same font share one face.
 */
const registered = new Map<string, string>()
let counter = 0

/**
 * Declares `family` again under a generated name with `features` and `axes`.
 * `font-weight: 1 1000` keeps real bold reachable; `font-style: normal` means
 * italic must come from an italic face, not from this one leaning.
 */
function faceWithDescriptors(family: string, features: string, axes: string): string {
  const key = `${family}\u0000${features}\u0000${axes}`
  const existing = registered.get(key)
  if (existing) return existing

  const name = `wrustty-feat-${counter++}`
  try {
    // Only the descriptors asked for; empty isn't treated as absent everywhere.
    const descriptors: FontFaceDescriptors = { weight: '1 1000', style: 'normal' }
    if (features) descriptors.featureSettings = features
    // Not in the DOM typings yet, but supported.
    if (axes) (descriptors as { variationSettings?: string }).variationSettings = axes

    // A bundled family isn't installed, so `local()` can't reach it; point at
    // its shipped files instead, one entry per weight (or the real axis for a
    // variable font). Uprights only, as above.
    const bundled = (bundledFaces(family) ?? []).filter((f) => f.style === 'normal')
    const sources = bundled.length
      ? bundled.map((f) => ({ src: `url(${JSON.stringify(f.url)})`, weight: weightDescriptor(f) }))
      : [{ src: `local(${JSON.stringify(family)})`, weight: '1 1000' }]

    for (const source of sources) {
      const face = new FontFace(name, source.src, { ...descriptors, weight: source.weight })
      // Added before it loads: the atlas rasterizes synchronously, so a loading
      // face falls back for a frame and the next write redraws.
      void face.load().then(
        (loaded) => document.fonts.add(loaded),
        () => {
          // The machine lacks the family: name it directly (features lost,
          // glyphs correct). A bundled family falls back to its plain face.
          registered.set(key, family)
        },
      )
      document.fonts.add(face)
    }
  } catch {
    // The constructor doesn't throw on malformed descriptors (they read back
    // as `normal`); this guards against it being unavailable. Name the family
    // directly.
    registered.set(key, family)
    return family
  }
  registered.set(key, name)
  return name
}

/** The first family in a CSS list, unquoted (what `local()` needs). */
export function headFamily(stack: string): string {
  const named = stack.match(/"([^"]+)"|'([^']+)'|^([^,]+)/)
  return (named?.[1] ?? named?.[2] ?? named?.[3] ?? stack).trim()
}

/**
 * A family string for one slot: the configured stack, preceded by a generated
 * face when there are features or axes. The whole stack stays behind it as
 * fallback, since the generated name may resolve to nothing.
 */
function slot(stack: string, features: string, axes: string): string {
  if (!features.trim() && !axes.trim()) return stack
  const head = headFamily(stack)
  if (!head) return stack
  const generated = faceWithDescriptors(head, features, axes)
  if (generated === head) return stack
  return `"${generated}", ${stack}`
}

export function buildFontSelection(s: FontSettings): FontSelection {
  // A shipped family's default features (e.g. Monaspace keeps ligatures in
  // stylistic sets) apply only when the field is empty.
  const features =
    (s.fontFeatures ?? '').trim() || bundledDefaultFeatures(headFamily(s.fontFamily))
  const axes = s.fontVariations ?? ''

  // Every font change passes here, so start loading any bundled face named;
  // `fillText` against an unloaded face draws the fallback.
  for (const stack of [s.fontFamily, s.fontFamilyBold, s.fontFamilyItalic, s.fontFamilyBoldItalic]) {
    if (stack.trim()) ensureBundledLoaded(headFamily(stack))
  }

  const base = slot(s.fontFamily, features, axes)

  const boldIsFace = s.fontFamilyBold.trim() !== ''
  const italicIsFace = s.fontFamilyItalic.trim() !== ''
  const boldItalicIsFace = s.fontFamilyBoldItalic.trim() !== ''

  return {
    regular: base,
    bold: boldIsFace ? slot(s.fontFamilyBold, features, axes) : base,
    // Unset: the unwrapped stack (see the top of this file).
    italic: italicIsFace ? slot(s.fontFamilyItalic, features, axes) : s.fontFamily,
    boldItalic: boldItalicIsFace
      ? slot(s.fontFamilyBoldItalic, features, axes)
      : italicIsFace
        ? slot(s.fontFamilyItalic, features, axes)
        : s.fontFamily,
    boldIsFace,
    italicIsFace,
    // Falling back to the italic face (with CSS weight) also counts as a face.
    boldItalicIsFace: boldItalicIsFace || italicIsFace,
    boldItalicNeedsWeight: !boldItalicIsFace && italicIsFace,
    ranges: s.fontRanges ?? [],
    weight: s.fontWeight,
    boldWeight: s.fontWeightBold,
    lineHeight: s.lineHeightPercent / 100,
    letterSpacing: s.letterSpacing,
  }
}

/**
 * The family pinned to this codepoint, or null. Binary search, since the table
 * is user-supplied and could be long.
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
 * Splits ranges into those that can be looked up and the indices of those that
 * can't. Overlapping entries would make the binary search's answer arbitrary,
 * so an entry overlapping one already kept is ignored whole (not clipped) and
 * reported. Ordered by start, then wider first, so the result doesn't depend on
 * typing order.
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
 * Whether the feature string and the ligature toggle conflict. The toggle
 * decides whether operator runs reach `fillText` together; the features control
 * substitution inside the face.
 *
 * - `features-win`: toggle on, but a feature disables the substitution.
 * - `toggle-wins`: a feature asks for ligatures, but the toggle is off.
 *
 * Neither is a bug, but both look like one, so the settings dialog says so.
 */
export type LigatureConflict = 'features-win' | 'toggle-wins' | null

/** Tags faces use for operator ligatures (`calt` for most programming fonts). */
const LIGATURE_TAGS = ['calt', 'liga', 'clig', 'dlig']

export function ligatureConflict(features: string, ligatures: boolean): LigatureConflict {
  let switchedOff = false
  let switchedOn = false
  for (const tag of LIGATURE_TAGS) {
    // `"calt" 0`, `"calt" off`, or bare `"calt"` (on).
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

/**
 * Whether this browser accepts `value` for `property`, or null if it can't be
 * asked. `FontFace` silently drops descriptors it can't parse, and
 * `CSS.supports` was measured to agree exactly with what survives (including
 * that one bad tag discards the whole list). Empty is valid (unset).
 */
export function descriptorIsValid(property: string, value: string): boolean | null {
  if (value.trim() === '') return true
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return null
  try {
    return CSS.supports(property, value)
  } catch {
    return null
  }
}

/** A codepoint in Unicode chart notation (`U+0041`). */
export function formatCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * A codepoint typed by hand (always hex; `U+` and `0x` prefixes allowed), or
 * null.
 */
export function parseCodepoint(text: string): number | null {
  const cleaned = text.trim().replace(/^(?:U\+|0x)/i, '')
  if (!/^[0-9a-f]{1,6}$/i.test(cleaned)) return null
  const cp = parseInt(cleaned, 16)
  return cp <= 0x10ffff ? cp : null
}

/** Whether two range tables are identical, position by position. */
export function sameRanges(a: ReadonlyArray<FontRange>, b: ReadonlyArray<FontRange>): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.lo === b[i].lo && r.hi === b[i].hi && r.family === b[i].family)
  )
}

/** A selection naming one stack for everything (used by the bench engine). */
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
    weight: 400,
    boldWeight: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
  }
}
