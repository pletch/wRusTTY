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
 * Opens a path clicked in a local pane with its Windows association, or the
 * "Open with" picker. Programs and scripts are shown in Explorer instead of
 * run; local_open.rs owns resolution and every guard. `cwds` are candidate
 * bases for a relative path, best first.
 */
export function openLocalPath(path: string, cwds: string[]) {
  return invoke<LocalOpenOutcome>('open_local_path', { path, cwds })
}

/** Whether a local source runs WSL, whose Linux paths can't be opened as
 *  written. */
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
 * Which paths a pane's output can link, or null: POSIX for SSH (to the files
 * panel), Windows for a local shell (to file associations). Telnet, serial
 * and WSL have nowhere to send one.
 */
export function pathFlavorFor(source: ConnectionSource): PathFlavor | null {
  const transport = transportOf(source)
  if (transport === 'ssh') return 'posix'
  if ((transport === 'local' || transport === 'elevated') && !isWsl(source)) return 'windows'
  return null
}
