/**
 * Frontend half of the recent-command store — see
 * src-tauri/src/command_history.rs and docs/AUTOCOMPLETE_PLAN.md.
 *
 * Thin on purpose. The ranking, the redaction and the frecency all live in
 * Rust, and this file deliberately never holds a host's history: the only
 * strings that cross into the webview are the handful about to be shown, plus
 * whatever the Settings list asks for when the user opens it. That is the
 * whole reason `suggest` is a round trip rather than a local filter over a
 * list fetched once.
 */

import { invoke } from '@tauri-apps/api/core'
import type { ConnectionSource } from './connection'

/** Where an entry came from. Matches `HistorySource` in the Rust module. */
export type HistorySource = 'harvest' | 'integration' | 'screen'

export interface HistoryEntry {
  command: string
  /** Distinct sightings — one entry per command, never a log of runs. */
  count: number
  /** Times it was accepted from a suggestion, which the ranking weighs above
   * a plain sighting. */
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
}

/**
 * The key a session's history is filed under.
 *
 * Opaque to the backend, which only ever compares it — so the scheme can
 * change here alone. Includes the username because "what tim runs on this box"
 * and "what root runs on this box" are different histories and suggesting one
 * at the other's prompt would be both wrong and, for root, mildly dangerous.
 * Port is included for the same reason a port is part of a known-hosts entry:
 * two ports on one address can be two different machines behind a NAT.
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
 * A saved session files under its **profile id** rather than its host. That is
 * deliberate, and it is the one place this scheme is not simply "the host":
 * a profile is the thing the user thinks of as "that machine", and it survives
 * the host being renamed, re-addressed or moved to a new port — all of which
 * would otherwise silently fork the history in two. The cost is that the same
 * box reached ad-hoc through the connect dialog keeps a separate history from
 * the saved session pointing at it. That is the right way round: merging them
 * would mean trusting a typed hostname to mean the same machine as a stored
 * one, and it is far better to under-share a history than to offer one host's
 * commands at another's prompt.
 */
export function historyKeyForSource(source: ConnectionSource): string | null {
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
    // Both profile forms carry only an id — for sshProfile because the host
    // lives in the saved profile, and for serialProfile because the COM port
    // is resolved backend-side at connect time and deliberately isn't here.
    case 'sshProfile':
      return `profile://${source.profileId}`
    case 'serialProfile':
      return `profile://${source.profileId}`
    // Null means "this pane records nothing", which is decision 2 of
    // docs/LOCAL_SHELL_PLAN.md applied where the source is chosen rather than
    // filtered afterwards: PowerShell and CMD are an autocomplete non-goal
    // (docs/TODO.md:406) because their prompt and echo model defeats the
    // screen-scraping path, and PSReadLine's own Predictive IntelliSense
    // already does the job better from inside the shell.
    //
    // It is null for *every* local shell only until shell detection lands.
    // WSL and Git Bash are ordinary bash hosts and should record like any
    // other; distinguishing them means classifying the command, which is
    // Phase 3/4 work. Under-recording is the safe direction to be wrong in.
    case 'local':
      return null
  }
}

/** Fold a command into a host's history. Resolves false when the backend
 * refused it — an empty line, or one that looked like it carried a
 * credential. Not an error: refusing is the expected outcome for a good
 * fraction of what gets offered. */
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

/** Best completions of `typed`, best first, or empty when there is nothing
 * worth offering. */
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

/** Report that a suggestion was taken, which the ranking weighs above a
 * sighting — it is the only signal that says the suggestion was *right*. */
export function recordAccepted(host: string, command: string): Promise<void> {
  return invoke('command_history_accepted', { host, command })
}

/** Everything stored, for the Settings list. */
export function listCommandHistory(): Promise<HostHistory[]> {
  return invoke<HostHistory[]>('command_history_list')
}

/** Drop one command, one host, or everything: `command` narrows `host`, and
 * omitting `host` clears the lot. */
export function forgetCommandHistory(opts?: {
  host?: string
  command?: string
}): Promise<void> {
  return invoke('command_history_forget', {
    host: opts?.host ?? null,
    command: opts?.command ?? null,
  })
}

/**
 * Import a host's own shell history over one `exec` channel, once.
 *
 * SSH only — it needs a second channel on the live connection, which telnet
 * and serial do not have.
 *
 * **Only call this when autocomplete itself is on.** That is the outer of the
 * two gates and the only one this side owns; the inner one — the harvest's own
 * setting, and the saved session's override of it — is resolved in Rust, where
 * the profile lives, and is checked before any channel is opened. Passing
 * `importGlobally: false` with no override therefore does nothing at all,
 * rather than doing it and discarding the answer: a read that happens and is
 * then thrown away has still read the file and still reached the host's logs.
 *
 * Resolves the number of commands newly added. Zero covers every ordinary way
 * this comes to nothing — the setting said no, the host has no readable
 * history, a restricted shell refused, an appliance ignored the command, or
 * everything in the file was already known.
 */
export function harvestRemoteHistory(opts: {
  sessionId: string
  host: string
  /** The global `autocompleteImportRemoteHistory` setting. */
  importGlobally: boolean
  /** The saved session this pane was opened from, when it came from one — the
   * backend reads its own override off it. */
  profileId?: string | null
}): Promise<number> {
  return invoke<number>('command_history_harvest', {
    sessionId: opts.sessionId,
    host: opts.host,
    importGlobally: opts.importGlobally,
    profileId: opts.profileId ?? null,
  })
}

/** Drop everything a Tier 1 harvest imported, leaving what was witnessed —
 * the other half of the harvest's separate consent. */
export function forgetImportedHistory(): Promise<void> {
  return invoke('command_history_forget_imported')
}
