/**
 * The font families shipped inside the app (JetBrains Mono, Fira Code and
 * Monaspace Neon), so a fresh machine has ligature-capable faces without an
 * install. A `url()` `@font-face` lands in `document.fonts`, which Canvas 2D
 * resolves against, so the atlas needs no changes. Registered from TypeScript
 * (not index.css) because the feature wrappers in `fontStack.ts` need the asset
 * URLs at runtime.
 *
 * Shipped: JetBrains Mono regular, bold and both italics; Fira Code regular and
 * bold (it has no italics); and Monaspace Neon as one variable file (weights
 * 200-800 plus `wdth`/`slnt`), from which 400 and 700 are instanced (measured
 * to advance identically). Monaspace's italics come via the `slnt` axis, not a
 * face. Other weights are left out to keep the installer small.
 *
 * All are SIL OFL 1.1 with `OFL.txt` alongside. Monaspace has a Reserved Font
 * Name, so its file must ship unmodified: never subset it.
 */

import jetBrainsRegular from '../assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?url'
import jetBrainsBold from '../assets/fonts/jetbrains-mono/JetBrainsMono-Bold.woff2?url'
import jetBrainsItalic from '../assets/fonts/jetbrains-mono/JetBrainsMono-Italic.woff2?url'
import jetBrainsBoldItalic from '../assets/fonts/jetbrains-mono/JetBrainsMono-BoldItalic.woff2?url'
import firaRegular from '../assets/fonts/fira-code/FiraCode-Regular.woff2?url'
import firaBold from '../assets/fonts/fira-code/FiraCode-Bold.woff2?url'
import monaspaceNeon from '../assets/fonts/monaspace-neon/MonaspaceNeon-Var.woff2?url'

/** One shipped face: the file, and the descriptors that select it. */
export interface BundledFace {
  /** The hashed asset URL Vite emits; same-origin, so it satisfies the CSP (a
   *  `data:` URI wouldn't). */
  url: string
  /** The weight this file is requested at (and declared as, if static). */
  weight: number
  /** For a variable file, the `font-weight` range it's declared with, so bold is
   *  instanced from the same file rather than synthesized. */
  weightRange?: string
  style: 'normal' | 'italic'
}

/** The `font-weight` descriptor: the axis if there is one, else the weight. */
export function weightDescriptor(face: BundledFace): string {
  return face.weightRange ?? String(face.weight)
}

/**
 * Features a shipped family needs by default, used only when the features field
 * is empty (anything typed replaces it entirely). Monaspace keeps its coding
 * ligatures in ten stylistic sets that are off by default. `calt` is omitted:
 * it's on by default and drives texture healing (which also needs the
 * Ligatures toggle).
 */
export const BUNDLED_DEFAULT_FEATURES: Readonly<Record<string, string>> = {
  'Monaspace Neon': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map((n) => `"ss${String(n).padStart(2, '0')}" 1`)
    .join(', '),
}

/** Default features for `family`, or empty. */
export function bundledDefaultFeatures(family: string): string {
  const wanted = familyKey(family)
  for (const [name, features] of Object.entries(BUNDLED_DEFAULT_FEATURES)) {
    if (name.toLowerCase() === wanted) return features
  }
  return ''
}

/** Keyed by the real family name, so an installed copy resolves the same glyphs
 *  and older settings keep working. */
export const BUNDLED_FONTS: Readonly<Record<string, ReadonlyArray<BundledFace>>> = {
  'JetBrains Mono': [
    { url: jetBrainsRegular, weight: 400, style: 'normal' },
    { url: jetBrainsBold, weight: 700, style: 'normal' },
    { url: jetBrainsItalic, weight: 400, style: 'italic' },
    { url: jetBrainsBoldItalic, weight: 700, style: 'italic' },
  ],
  // Uprights only.
  'Fira Code': [
    { url: firaRegular, weight: 400, style: 'normal' },
    { url: firaBold, weight: 700, style: 'normal' },
  ],
  // One variable file; bold is instanced from it at 700.
  'Monaspace Neon': [
    { url: monaspaceNeon, weight: 400, weightRange: '200 800', style: 'normal' },
  ],
}

/** The shipped faces for `family` (case-insensitive), or null. */
export function bundledFaces(family: string): ReadonlyArray<BundledFace> | null {
  const wanted = familyKey(family)
  for (const [name, faces] of Object.entries(BUNDLED_FONTS)) {
    if (name.toLowerCase() === wanted) return faces
  }
  return null
}

/** Whether this bundled family has no italic face (for the settings dialog). */
export function bundledLacksItalic(family: string): boolean {
  const faces = bundledFaces(family)
  return faces !== null && !faces.some((f) => f.style === 'italic')
}

let registered = false

/**
 * Declares every shipped face once per session, from the entry module so they
 * exist before anything uses them. Declared, not loaded:
 * `ensureBundledLoaded` fetches the families a configuration names.
 * `document.fonts.check` reports declared-but-unfetched faces as absent, so
 * `hasFamily` consults this table first.
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
        // The stacks keep a system tail, so only the shipped font is lost.
      }
    }
  }
}

/** Families whose fetch has started, with its promise. */
const loading = new Map<string, Promise<unknown>>()
/** Families whose fetch has finished. */
const settled = new Set<string>()

/** A family name as this module keys it. */
function familyKey(family: string): string {
  return family.trim().replace(/^["']|["']$/g, '').toLowerCase()
}

/**
 * Starts the fetch for `family` if it's bundled and not yet requested.
 * Explicit because `fillText` against an unloaded face draws the fallback.
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
      // The stack's system tail carries the text.
    }
  }
  const all = Promise.all(started)
  loading.set(key, all)
  void all.then(() => settled.add(key))
}

/**
 * Resolves once every bundled family named here has loaded, returning whether
 * any was still in flight (so the caller's measurements were of the fallback
 * face and must be redone). Installed families resolve immediately; shipped
 * ones arrive over a fetch. Starts the fetch if needed.
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
