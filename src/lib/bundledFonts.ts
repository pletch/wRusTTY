/**
 * The two families that ship inside the app instead of being asked of the
 * machine.
 *
 * Everything else in the font path resolves against the system font
 * collection: `list_fonts` enumerates it natively (see `src-tauri/src/fonts.rs`),
 * the curated stacks name faces Windows happens to have, and
 * `faceWithDescriptors` reaches them through `local()`. That leaves the two
 * fonts people actually ask for by name — JetBrains Mono and Fira Code —
 * behind an install step, and leaves a fresh machine with no ligature-capable
 * face at all beyond Cascadia Code.
 *
 * A bundled face needs nothing from the system: an `@font-face` with a `url()`
 * source lands in `document.fonts`, and Canvas 2D resolves its font shorthand
 * against exactly that set, which is the same door `fontStack.ts` already
 * walks through for the feature wrappers. So the atlas rasterizes from these
 * with no change to how it names a family.
 *
 * Registered from TypeScript rather than declared in `index.css` on purpose:
 * the wrapper faces need the asset URL at *runtime* to build their own `src`
 * (a wrapper's `src` takes `local()` or `url()`, and there is no way to say
 * "the family I just declared in CSS"), and one table that both the plain
 * registration and the wrapper read is one place for the URLs to be right.
 *
 * ## What is shipped, and what is not
 *
 * Four faces of JetBrains Mono — regular, bold, and both italics — two of Fira
 * Code, and one file for Monaspace Neon.
 *
 * *One* file, because Monaspace ships as a variable font: a single ~500 KB
 * woff2 carries every weight from 200 to 800 plus the `wdth` and `slnt` axes,
 * where the static cut of the same family would be ~450 KB per face. So it is
 * declared across the weight axis and the browser instances 400 and 700 out of
 * it — measured, and the two advance identically, which is what the cell
 * requires. The same file answers `fontVariations`, since axes reach a face
 * through the descriptor either way.
 *
 * Two of the three have no italic *face*. Fira Code ships uprights only, a
 * decision of its authors rather than a gap in this selection. Monaspace has
 * italics, but reaches them through the `slnt` axis rather than through a
 * separate file, and axes are configured for the whole terminal rather than
 * per style slot — so there is nothing here for the italic slot to name.
 * Either way the answer is the same: name an italic family in the per-style
 * slots, which the settings dialog says when one of them is chosen.
 *
 * The other weights the static families ship (Thin through ExtraBold, Fira's
 * Light and Retina) are left out. The terminal draws two weights, and each
 * unused face is ~100 KB of installer for a weight nothing asks for. Someone
 * who wants Fira Code Light installs Fira Code.
 *
 * All three are SIL OFL 1.1, which permits bundling in software; the license
 * text travels with the fonts, one `OFL.txt` per family directory. Monaspace
 * carries a Reserved Font Name covering "Monaspace" and its five subfamilies,
 * which is why its file is shipped byte-for-byte as published: the OFL allows
 * the bundling and forbids a *modified* version keeping the name, so this
 * family in particular must never be subset to save space. The other two have
 * no Reserved Font Name.
 */

import jetBrainsRegular from '../assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?url'
import jetBrainsBold from '../assets/fonts/jetbrains-mono/JetBrainsMono-Bold.woff2?url'
import jetBrainsItalic from '../assets/fonts/jetbrains-mono/JetBrainsMono-Italic.woff2?url'
import jetBrainsBoldItalic from '../assets/fonts/jetbrains-mono/JetBrainsMono-BoldItalic.woff2?url'
import firaRegular from '../assets/fonts/fira-code/FiraCode-Regular.woff2?url'
import firaBold from '../assets/fonts/fira-code/FiraCode-Bold.woff2?url'
import monaspaceNeon from '../assets/fonts/monaspace-neon/MonaspaceNeon-Var.woff2?url'

/** One shipped face: the file, and the two descriptors that decide when the
 *  browser picks it out of its family. */
export interface BundledFace {
  /** The hashed asset URL Vite emits. Same-origin, so it satisfies the app's
   *  CSP without a `font-src` of its own — which a `data:` URI would not. */
  url: string
  /** A weight this file is asked for by name — what the fetch is started at,
   *  and what a static file is declared as. */
  weight: number
  /** For a variable file, the `font-weight` descriptor it is declared with:
   *  the whole axis, so the browser instances bold out of the same file rather
   *  than emboldening the one weight it was told about. */
  weightRange?: string
  style: 'normal' | 'italic'
}

/** The `font-weight` descriptor to declare a face with — the axis where there
 *  is one, the single weight otherwise. */
export function weightDescriptor(face: BundledFace): string {
  return face.weightRange ?? String(face.weight)
}

/**
 * OpenType features a shipped family needs before it does what it is known for,
 * applied only when nothing has been typed into the features field.
 *
 * Monaspace is the reason this exists. Its coding ligatures are not in `liga`
 * or `calt` where every other programming face keeps them — they are spread
 * across ten stylistic sets, all off by default, so the font renders `!=` and
 * `->` as plain characters no matter what the Ligatures toggle says. Bundling
 * a font that arrives looking like it does not work is not bundling it, and
 * these are the tags GitHub's own documentation tells you to turn on.
 *
 * Anything typed into the field replaces this entirely rather than merging
 * with it: a features string is a single value the browser parses as a whole,
 * and quietly appending to what someone wrote is how they end up unable to
 * turn one of these *off*.
 *
 * `calt` is deliberately absent. It is on by default in the font — it drives
 * texture healing, Monaspace's spacing fix for awkward letter pairs — and
 * naming it here would only be a way to get it wrong. What texture healing
 * does need is the Ligatures toggle, because a run of characters only reaches
 * the face as a run when that is on.
 */
export const BUNDLED_DEFAULT_FEATURES: Readonly<Record<string, string>> = {
  'Monaspace Neon': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map((n) => `"ss${String(n).padStart(2, '0')}" 1`)
    .join(', '),
}

/** The features `family` wants when the user has expressed no preference, or
 *  empty for a family that needs none. */
export function bundledDefaultFeatures(family: string): string {
  const wanted = familyKey(family)
  for (const [name, features] of Object.entries(BUNDLED_DEFAULT_FEATURES)) {
    if (name.toLowerCase() === wanted) return features
  }
  return ''
}

/** Keyed by the family name a stack refers to them by — the real one, so a
 *  machine that also has the font installed resolves the same glyphs either
 *  way, and a settings file written before this existed keeps working. */
export const BUNDLED_FONTS: Readonly<Record<string, ReadonlyArray<BundledFace>>> = {
  'JetBrains Mono': [
    { url: jetBrainsRegular, weight: 400, style: 'normal' },
    { url: jetBrainsBold, weight: 700, style: 'normal' },
    { url: jetBrainsItalic, weight: 400, style: 'italic' },
    { url: jetBrainsBoldItalic, weight: 700, style: 'italic' },
  ],
  // Uprights only — see the note above.
  'Fira Code': [
    { url: firaRegular, weight: 400, style: 'normal' },
    { url: firaBold, weight: 700, style: 'normal' },
  ],
  // One file across the whole weight axis. Asked for at 400; bold is the same
  // file instanced at 700, which is why no second entry appears here.
  'Monaspace Neon': [
    { url: monaspaceNeon, weight: 400, weightRange: '200 800', style: 'normal' },
  ],
}

/** The shipped faces for `family`, or null when it is not one of ours.
 *  Case-insensitive, because a CSS family name is. */
export function bundledFaces(family: string): ReadonlyArray<BundledFace> | null {
  const wanted = familyKey(family)
  for (const [name, faces] of Object.entries(BUNDLED_FONTS)) {
    if (name.toLowerCase() === wanted) return faces
  }
  return null
}

/** Whether this family has no italic face, so the atlas is about to ask for a
 *  slant nothing can supply. Asked by the settings dialog, which is the only
 *  place that can say so before it looks like a rendering fault. */
export function bundledLacksItalic(family: string): boolean {
  const faces = bundledFaces(family)
  return faces !== null && !faces.some((f) => f.style === 'italic')
}

let registered = false

/**
 * Declares every shipped face, once per session.
 *
 * Called from the entry module rather than lazily from the font path, so a
 * family is declared before anything reaches for it — the atlas included.
 *
 * Declared but not loaded. `FontFace` fetches on first use, so registration
 * costs six URLs and no bytes; `ensureBundledLoaded` starts the fetch for the
 * families a configuration actually names, which is what keeps a Fira Code
 * install out of the memory of someone using JetBrains Mono.
 *
 * The one thing that costs, and it was measured in the running app rather
 * than reasoned about: `document.fonts.check` answers "can this be drawn
 * right now", so a declared-but-unfetched face reads there as *absent*, and
 * the settings dialog reported a bundled font as not installed. Which is why
 * `hasFamily` consults this table before it asks the webview. `check` starts
 * telling the truth once the fetch lands, but a report that is wrong until
 * something happens to be loaded is not a report.
 */
export function registerBundledFonts(): void {
  if (registered) return
  registered = true
  if (typeof FontFace === 'undefined' || !document.fonts?.add) return
  for (const [family, faces] of Object.entries(BUNDLED_FONTS)) {
    for (const face of faces) {
      try {
        document.fonts.add(
          new FontFace(family, `url(${JSON.stringify(face.url)})`, {
            weight: weightDescriptor(face),
            style: face.style,
          }),
        )
      } catch {
        // A webview without `FontFace`, or one objecting to a descriptor.
        // The stacks all keep a system tail behind the bundled family, so
        // this costs the shipped font and not the text.
      }
    }
  }
}

/** Families whose fetch has been started, against the promise for it, so
 *  switching fonts back and forth does not re-ask for each one every time
 *  settings change — and so a caller can wait for one. */
const loading = new Map<string, Promise<unknown>>()
/** ...and the ones that have since arrived, which is the question
 *  `bundledSettled` actually answers. */
const settled = new Set<string>()

/** However a CSS stack spelled the family, as this module keys it. */
function familyKey(family: string): string {
  return family.trim().replace(/^["']|["']$/g, '').toLowerCase()
}

/**
 * Starts the fetch for `family` if it is one of ours and has not been asked
 * for yet.
 *
 * Canvas 2D is the reason this is explicit. `fillText` against a face that has
 * not loaded draws the fallback, and whether resolving a canvas font shorthand
 * kicks off the load at all is not something to depend on — so the load is
 * started from the one place that knows which families a configuration names.
 */
export function ensureBundledLoaded(family: string): void {
  const faces = bundledFaces(family)
  if (!faces) return
  const key = familyKey(family)
  if (loading.has(key)) return
  const quoted = `"${family.trim().replace(/["\\]/g, '')}"`
  const started: Promise<unknown>[] = []
  for (const face of faces) {
    const style = face.style === 'italic' ? 'italic ' : ''
    try {
      const p = document.fonts?.load?.(`${style}${face.weight} 16px ${quoted}`)
      if (p) started.push(p.catch(() => {}))
    } catch {
      // Nothing to do about it here; the stack's system tail carries the text.
    }
  }
  const all = Promise.all(started)
  loading.set(key, all)
  void all.then(() => settled.add(key))
}

/**
 * Resolves once every bundled family named here has arrived, answering whether
 * any of them was still in flight — that is, whether the caller has just
 * measured against a face that is about to change underneath it.
 *
 * This is what a bundled font costs, and it is the whole of what it costs. An
 * installed family is there the moment it is named: `local()` resolves against
 * a face already on the machine, so measuring the cell and rasterizing the
 * atlas the instant someone picks a font was always safe. A shipped family
 * arrives over a fetch, and until it does `measureText` reports the *fallback*
 * face. A cell derived from one face and filled with glyphs from another is
 * visible immediately — as columns spaced too far apart, or as glyphs squeezed
 * to fit, depending on which way the two advances differ.
 *
 * `GhosttyEngine` already guarded this shape of problem at construction, via
 * `document.fonts.ready`. Switching fonts later had no equivalent, and needed
 * none: until fonts shipped in the app, there was nothing asynchronous about
 * switching one.
 *
 * Starts the fetch itself rather than assuming someone else did, so a caller
 * that wants correct metrics gets them by asking for them.
 */
export async function bundledSettled(families: readonly string[]): Promise<boolean> {
  const waits: Promise<unknown>[] = []
  for (const family of families) {
    if (!bundledFaces(family)) continue
    ensureBundledLoaded(family)
    const key = familyKey(family)
    if (settled.has(key)) continue
    const pending = loading.get(key)
    if (pending) waits.push(pending)
  }
  if (waits.length === 0) return false
  await Promise.all(waits)
  return true
}
