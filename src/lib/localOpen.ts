import { invoke } from '@tauri-apps/api/core'
import { transportOf, type ConnectionSource } from './connection'
import type { PathFlavor } from './pathDetect'

/** What `open_local_path` did. Mirrors `OpenOutcome` in local_open.rs. */
export type LocalOpenOutcome =
  | { kind: 'opened'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'revealed'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'notFound' }

/**
 * Opens a path clicked in a local pane with whatever Windows associates with
 * it, or the "Open with" picker when nothing is. Programs and scripts are shown
 * in Explorer instead of run — see local_open.rs, which also owns resolving the
 * path and every guard on it.
 *
 * `cwds` are where a relative path might be relative to, best first.
 */
export function openLocalPath(path: string, cwds: string[]) {
  return invoke<LocalOpenOutcome>('open_local_path', { path, cwds })
}

/** Whether a local source runs WSL, whose output is full of Linux paths this
 *  machine cannot open as written. */
function isWsl(source: ConnectionSource): boolean {
  switch (source.protocol) {
    case 'local':
      return /(^|[\\/])wsl(\.exe)?$/i.test(source.config.command)
    case 'localProfile':
    case 'elevated':
      return source.shellId.startsWith('wsl')
    default:
      return false
  }
}

/**
 * Which paths a pane's output can link, or null for none.
 *
 * An SSH host's are POSIX, and go to its files panel. A local shell's are
 * Windows paths, and go to this machine's file associations. Nothing else has
 * anywhere to send a path: telnet and serial have no file channel, and WSL
 * prints paths inside a Linux filesystem.
 */
export function pathFlavorFor(source: ConnectionSource): PathFlavor | null {
  const transport = transportOf(source)
  if (transport === 'ssh') return 'posix'
  if ((transport === 'local' || transport === 'elevated') && !isWsl(source)) return 'windows'
  return null
}
