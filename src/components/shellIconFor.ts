import type { LocalConfig } from '../lib/local'
import { shellIdFor } from '../lib/local'
import { CommandPromptIcon, GitIcon, LinuxIcon, type IconProps } from './ShellIcons'

/**
 * Which icon a local session gets. Separate from `ShellIcons.tsx` so that
 * file exports only components (needed for fast refresh).
 */

export type ShellIcon = (props: IconProps) => React.ReactElement

/** Where a shell's icon comes from: `installed` (Microsoft shells, read from
 * their executables; see `ShellIcons.tsx`), `fallback` while that read is
 * pending or impossible, and `bundled` for redistributable marks. */
export type ShellGlyph =
  | { kind: 'installed'; shellId: string; fallback: ShellIcon }
  | { kind: 'bundled'; icon: ShellIcon }

/** The glyph for a detected shell id, or null for the generic local icon. */
export function glyphForShellId(shellId: string): ShellGlyph | null {
  if (shellId === 'pwsh' || shellId === 'powershell' || shellId === 'cmd') {
    return { kind: 'installed', shellId, fallback: CommandPromptIcon }
  }
  if (shellId === 'git-bash') return { kind: 'bundled', icon: GitIcon }
  // Every distro shares one glyph; an unknown distro is still Linux.
  if (shellId.startsWith('wsl:') || shellId === 'wsl') return { kind: 'bundled', icon: LinuxIcon }
  // Anything else gets the generic icon: no trademark on an unidentified
  // binary.
  return null
}

/** The same for an ad hoc session, from its command. */
export function glyphForShell(config: LocalConfig): ShellGlyph | null {
  return glyphForShellId(shellIdFor(config))
}
