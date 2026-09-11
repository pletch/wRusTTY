import type { LocalConfig } from '../lib/local'
import { shellIdFor } from '../lib/local'
import { CommandPromptIcon, GitIcon, LinuxIcon, type IconProps } from './ShellIcons'

/**
 * Which icon a local session gets, and where it comes from.
 *
 * Split from `ShellIcons.tsx` so that file exports only components — a module
 * mixing components with plain functions loses fast refresh, and the lint says
 * so.
 */

export type ShellIcon = (props: IconProps) => React.ReactElement

/** Where a shell's icon comes from.
 *
 * `installed` is the Microsoft shells: their icons are read from their own
 * executables on this machine rather than bundled, because Microsoft's
 * trademark terms rule out distributing its logos. `fallback` is drawn while
 * that read is in flight and wherever it cannot happen.
 *
 * `bundled` is everything whose mark may be redistributed. */
export type ShellGlyph =
  | { kind: 'installed'; shellId: string; fallback: ShellIcon }
  | { kind: 'bundled'; icon: ShellIcon }

/** The glyph for a detected shell id, or null when nothing fits and the caller
 *  should fall back to the generic local icon. */
export function glyphForShellId(shellId: string): ShellGlyph | null {
  if (shellId === 'pwsh' || shellId === 'powershell' || shellId === 'cmd') {
    return { kind: 'installed', shellId, fallback: CommandPromptIcon }
  }
  if (shellId === 'git-bash') return { kind: 'bundled', icon: GitIcon }
  // Every distro shares one glyph deliberately. Mapping each name to its own
  // mark would be an open-ended set — and a distro this app has never heard of
  // would still be Linux.
  if (shellId.startsWith('wsl:') || shellId === 'wsl') return { kind: 'bundled', icon: LinuxIcon }
  // Anything else keeps the generic local icon. A hand-typed shell is most
  // often a bash, but "most often" is not enough to put someone's trademark on
  // a binary this app has not identified.
  return null
}

/** The same question for an ad-hoc session, which has a command rather than a
 *  detected id. */
export function glyphForShell(config: LocalConfig): ShellGlyph | null {
  return glyphForShellId(shellIdFor(config))
}
