/**
 * Frontend half of the recent-command store (src-tauri/src/command_history.rs,
 * docs/AUTOCOMPLETE_PLAN.md). Ranking, redaction and frecency live in Rust, and
 * the webview never holds a host's history: only the few strings about to be
 * shown cross over, which is why `suggest` is a round trip.
 */

import { invoke } from '@tauri-apps/api/core'
import type { ConnectionSource } from './connection'
import { profileSubtitle, type SessionProfile } from './profiles'
import { familyForShellId, recordsHistory, shellFamily, shellIdFor } from './local'

/** Where an entry came from. Matches `HistorySource` in the Rust module. */
export type HistorySource = 'harvest' | 'integration' | 'screen'

export interface HistoryEntry {
  command: string
  /** Distinct sightings; one entry per command, not a log of runs. */
  count: number
  /** Times accepted from a suggestion; weighted above a sighting. */
  accepted: number
  /** Epoch ms of the most recent sighting. */
  lastUsed: number
  source: HistorySource
  /** Directory it was last run in, when the host reports one (OSC 7). */
  cwd: string | null
}

export interface HostHistory {
  host: string
  entries: HistoryEntry[]
  /** Commands never to suggest on this host, newest first. */
  blocked: string[]
}

/**
 * The key a session's history is filed under. Opaque to the backend, which
 * only compares it. Includes the username (root's history shouldn't be offered
 * at tim's prompt) and the port (two ports can be two machines behind a NAT).
 */
export function historyKey(opts: {
  protocol: string
  host: string
  port?: number | null
  username?: string | null
}): string {
  const user = opts.username ? `${opts.username}@` : ''
  const port = opts.port ? `:${opts.port}` : ''
  return `${opts.protocol}://${user}${opts.host}${port}`
}

/**
 * The key for a live pane, from the connection it was opened with.
 *
 * A saved session files under its profile id rather than its host, so the
 * history survives the host being renamed, re-addressed or moved. The same box
 * reached ad hoc keeps a separate history; under-sharing is the safe direction.
 *
 * `savedProfile` is the saved session this pane was opened from, if any. When
 * its credential can't be used, the pane connects as plain `ssh`; that still
 * files under the profile while it points where the stored profile does
 * (editing the host in the form makes it a different machine).
 */
export function historyKeyForSource(
  source: ConnectionSource,
  savedProfile?: SessionProfile | null,
): string | null {
  if (savedProfile && pointsAtProfile(source, savedProfile)) {
    return `profile://${savedProfile.id}`
  }
  switch (source.protocol) {
    case 'ssh':
      return historyKey({
        protocol: 'ssh',
        host: source.config.host,
        port: source.config.port,
        username: source.config.username,
      })
    case 'telnet':
      return historyKey({
        protocol: 'telnet',
        host: source.config.host,
        port: source.config.port,
      })
    case 'serial':
      return historyKey({ protocol: 'serial', host: source.config.portName })
    // Both profile forms carry only an id; the host or COM port is resolved
    // backend-side.
    case 'sshProfile':
      return `profile://${source.profileId}`
    case 'serialProfile':
      return `profile://${source.profileId}`
    // Null means "records nothing" (decision 2 of docs/LOCAL_SHELL_PLAN.md). The
    // split is by shell family: PowerShell and CMD are an autocomplete non-goal
    // (their echo model defeats screen scraping, and PSReadLine already predicts),
    // while WSL and Git Bash record like any bash host.
    case 'local':
      return recordsHistory(shellFamily(source.config))
        ? `local://${shellIdFor(source.config)}`
        : null
    // Decision 6 of docs/ELEVATED_TABS_PLAN.md: what an administrator typed must
    // not come back as a suggestion in an ordinary tab.
    case 'elevated':
      return null
    // A saved local shell files under its profile id, like other saved sessions.
    case 'localProfile': {
      const family = familyForShellId(source.shellId)
      // No id means a hand-typed path of unknown family; declining to record beats
      // a history full of half-redrawn PowerShell buffers.
      if (!family || !recordsHistory(family)) return null
      return `profile://${source.profileId}`
    }
  }
}

/** Whether a plain ssh/telnet source is the saved session's own endpoint. */
function pointsAtProfile(source: ConnectionSource, profile: SessionProfile): boolean {
  switch (source.protocol) {
    case 'ssh':
      return (
        profile.protocol === 'ssh' &&
        source.config.host === profile.host &&
        source.config.port === profile.port &&
        source.config.username === profile.username
      )
    case 'telnet':
      return (
        profile.protocol === 'telnet' &&
        source.config.host === profile.host &&
        source.config.port === profile.port
      )
    default:
      return false
  }
}

/**
 * How a history key reads in Settings: a title and where it points. Looked up
 * at render time so a renamed session shows its new name. A `profile://` key
 * whose session was deleted says so; its history outlives it on purpose.
 */
export function describeHistoryHost(
  key: string,
  profiles: ReadonlyMap<string, SessionProfile>,
): { title: string; detail: string | null } {
  const match = /^([a-z]+):\/\/(.*)$/.exec(key)
  if (!match) return { title: key, detail: null }
  const [, scheme, rest] = match
  if (scheme === 'profile') {
    const profile = profiles.get(rest)
    return profile
      ? { title: profile.label, detail: profileSubtitle(profile) }
      : { title: 'Deleted saved session', detail: null }
  }
  if (scheme === 'local') {
    return { title: rest.startsWith('wsl:') ? `WSL ${rest.slice(4)}` : rest, detail: 'local shell' }
  }
  return { title: rest, detail: scheme }
}

/** Folds a command into a host's history. Resolves false when the backend
 * refused it (empty, or apparently carrying a credential); that's expected,
 * not an error. */
export function recordCommand(opts: {
  host: string
  command: string
  cwd?: string | null
  source: HistorySource
}): Promise<boolean> {
  return invoke<boolean>('command_history_record', {
    host: opts.host,
    command: opts.command,
    cwd: opts.cwd ?? null,
    source: opts.source,
  })
}

/** Best completions of `typed`, best first; empty when nothing is worth
 * offering. */
export function suggestCommands(opts: {
  host: string
  typed: string
  cwd?: string | null
  limit?: number
}): Promise<string[]> {
  return invoke<string[]>('command_history_suggest', {
    host: opts.host,
    typed: opts.typed,
    cwd: opts.cwd ?? null,
    limit: opts.limit ?? 5,
  })
}

/** Reports that a suggestion was taken: the only signal it was right. */
export function recordAccepted(host: string, command: string): Promise<void> {
  return invoke('command_history_accepted', { host, command })
}

/** Everything stored, for the Settings list. */
export function listCommandHistory(): Promise<HostHistory[]> {
  return invoke<HostHistory[]>('command_history_list')
}

/** Drops one command, one host, or everything (`command` narrows `host`;
 * omitting `host` clears all). A single command is also blocked until allowed;
 * clearing a host or everything takes its blocks too. */
export function forgetCommandHistory(opts?: {
  host?: string
  command?: string
}): Promise<void> {
  return invoke('command_history_forget', {
    host: opts?.host ?? null,
    command: opts?.command ?? null,
  })
}

/** Lifts a never-suggest block. Restores nothing; the command is learned again
 * when next run or imported. */
export function allowCommandHistory(host: string, command: string): Promise<void> {
  return invoke('command_history_allow', { host, command })
}

/**
 * Imports a host's own shell history over one `exec` channel (SSH only).
 *
 * Only call this when autocomplete is on, the outer gate this side owns. The
 * inner gate (the harvest setting and the profile's override) is resolved in
 * Rust before any channel opens, so a refused import never reads the file.
 *
 * Resolves the number of commands newly added; zero covers every ordinary way
 * this comes to nothing.
 */
export function harvestRemoteHistory(opts: {
  sessionId: string
  host: string
  /** The global `autocompleteImportRemoteHistory` setting. */
  importGlobally: boolean
  /** The saved session this pane came from; the backend reads its override. */
  profileId?: string | null
}): Promise<number> {
  return invoke<number>('command_history_harvest', {
    sessionId: opts.sessionId,
    host: opts.host,
    importGlobally: opts.importGlobally,
    profileId: opts.profileId ?? null,
  })
}

/** Drops everything a Tier 1 harvest imported, keeping what was witnessed. */
export function forgetImportedHistory(): Promise<void> {
  return invoke('command_history_forget_imported')
}
