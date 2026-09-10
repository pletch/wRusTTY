import type { LocalConfig } from '../lib/local'
import { shellIdFor } from '../lib/local'
import {
  CommandPromptIcon,
  GitIcon,
  LinuxIcon,
  PowerShellIcon,
  type IconProps,
} from './ShellIcons'

/**
 * Which shell icon a local session gets.
 *
 * Split from `ShellIcons.tsx` so that file exports only components — a module
 * mixing components with plain functions loses fast refresh, and the lint says
 * so.
 */

export type ShellIcon = (props: IconProps) => React.ReactElement

/** The icon for a detected shell id, or null when nothing fits and the
 *  caller should fall back to the generic local icon. */
export function iconForShellId(shellId: string): ShellIcon | null {
  if (shellId === 'pwsh' || shellId === 'powershell') return PowerShellIcon
  if (shellId === 'cmd') return CommandPromptIcon
  if (shellId === 'git-bash') return GitIcon
  // Every distro shares one glyph deliberately. Mapping each name to its own
  // mark would be an open-ended set — and a distro this app has never heard of
  // would still be Linux.
  if (shellId.startsWith('wsl:') || shellId === 'wsl') return LinuxIcon
  // Anything else keeps the generic local icon. A hand-typed shell is most
  // often a bash, but "most often" is not enough to stamp someone's trademark
  // on a binary this app has not identified.
  return null
}

/** The same question for an ad-hoc session, which has a command rather than a
 *  detected id. */
export function iconForShell(config: LocalConfig): ShellIcon | null {
  return iconForShellId(shellIdFor(config))
}
