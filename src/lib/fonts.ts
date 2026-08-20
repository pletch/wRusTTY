import { invoke } from '@tauri-apps/api/core'

/** One installed family, and whether it is fixed-pitch. Mirrors `FontFamily`
 *  in `src-tauri/src/fonts.rs`. */
export interface InstalledFont {
  name: string
  monospace: boolean
}

/**
 * The families installed on this machine, monospaced ones first-class.
 *
 * Asked of Rust rather than of the webview on purpose: Local Font Access is
 * Chromium-only and permission-gated, and DirectWrite is already in the
 * process and resolving against the same system font collection the webview
 * will. The webview constrains where glyphs are *rasterized*, not what the
 * application may know about fonts.
 *
 * Returns an empty list if the command is unavailable — running under `vite
 * dev` in a plain browser, say — so a caller can treat "no enumeration" and
 * "no fonts" the same way and fall back to the curated stacks.
 */
export async function listInstalledFonts(): Promise<InstalledFont[]> {
  try {
    return await invoke<InstalledFont[]>('list_fonts')
  } catch {
    return []
  }
}

/**
 * A CSS family list built around one installed family, with the same symbol
 * tier the curated stacks carry.
 *
 * Quoting is unconditional: a bare family name with a space in it is not a
 * parse error in a CSS list, but `Courier New` and `"Courier New"` are
 * different productions and only the quoted one is guaranteed to survive the
 * round trip through `ctx.font`. A name containing a quote could not be
 * expressed at all, so it is dropped rather than allowed to break the stack.
 */
export function stackFor(family: string): string {
  const safe = family.replace(/["\\]/g, '')
  return `"${safe}", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace`
}
