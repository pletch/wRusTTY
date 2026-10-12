/**
 * The host-key trust store, as something the user can see and edit, so a
 * reprovisioned host can be fixed without hand-editing `known_hosts` (or
 * clicking "accept" on a changed-key warning).
 */

import { invoke } from '@tauri-apps/api/core'

export interface KnownHostEntry {
  host: string
  port: number
  /** Null when the stored line will not parse. */
  algorithm: string | null
  /** SHA-256, in OpenSSH's `SHA256:…` form. Null for an unparseable line. */
  fingerprint: string | null
  /** The stored line, and the id `forgetHostKey` takes (unparseable entries
   *  have no fingerprint). */
  keyText: string
}

export function listKnownHosts() {
  return invoke<KnownHostEntry[]>('ssh_list_known_hosts')
}

export function forgetHostKey(host: string, port: number, keyText: string) {
  return invoke<boolean>('ssh_forget_host_key', { host, port, keyText })
}

/** Forgets every key held for one host, returning how many there were. */
export function forgetHost(host: string, port: number) {
  return invoke<number>('ssh_forget_host', { host, port })
}

/** One host, with every key stored for it. */
export interface KnownHostGroup {
  host: string
  port: number
  /** `host:port`, and the React key (a host may appear on two ports). */
  id: string
  keys: KnownHostEntry[]
}

/**
 * Groups the flat list by host and port, so a host with several key types
 * reads as one host and "forget this host" is one action. Keeps the backend's
 * order.
 */
export function groupByHost(entries: KnownHostEntry[]): KnownHostGroup[] {
  const groups = new Map<string, KnownHostGroup>()
  for (const entry of entries) {
    const id = `${entry.host}:${entry.port}`
    const group = groups.get(id)
    if (group) group.keys.push(entry)
    else groups.set(id, { host: entry.host, port: entry.port, id, keys: [entry] })
  }
  return [...groups.values()]
}

/**
 * How a host is labeled: the port only when it isn't 22, as SSH tools write
 * it.
 */
export function hostLabel(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`
}
