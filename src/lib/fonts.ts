import { invoke } from '@tauri-apps/api/core'

/** One installed family, and whether it is fixed-pitch. Mirrors `FontFamily`
 *  in `src-tauri/src/fonts.rs`. */
export interface InstalledFont {
  name: string
  monospace: boolean
}

/**
 * The families installed on this machine, from Rust (see
 * `src-tauri/src/fonts.rs` for why). Empty when the command is unavailable
 * (a plain browser), so callers fall back to the curated stacks.
 */
export async function listInstalledFonts(): Promise<InstalledFont[]> {
  try {
    return await invoke<InstalledFont[]>('list_fonts')
  } catch {
    return []
  }
}

/**
 * A CSS family list around one installed family, with the curated stacks'
 * symbol tier. Always quoted, since only the quoted form reliably survives
 * `ctx.font`; a name containing a quote can't be expressed and is dropped.
 */
export function stackFor(family: string): string {
  const safe = family.replace(/["\\]/g, '')
  return `"${safe}", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace`
}
