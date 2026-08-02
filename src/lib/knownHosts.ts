/**
 * The host-key trust store, as something the user can see and edit.
 *
 * The prompt that *writes* this store has always existed; nothing could read it
 * back. That left one failure with no way out inside the app: a host that is
 * legitimately reprovisioned offers a new key, the prompt says the key changed
 * and may be an attack, and the only fix is to hand-edit `known_hosts` — which
 * is exactly the moment a user is most likely to click "accept" on a warning
 * they should be reading.
 */

import { invoke } from '@tauri-apps/api/core'

export interface KnownHostEntry {
  host: string
  port: number
  /** Null when the stored line will not parse. */
  algorithm: string | null
  /** SHA-256, in OpenSSH's `SHA256:…` form. Null for an unparseable line. */
  fingerprint: string | null
  /** The stored line itself, and the identifier `forgetHostKey` takes — a
   *  fingerprint would be the natural id and does not exist for the entries
   *  that most need deleting. */
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
  /** `host:port`, and the React key — a host may appear on two ports. */
  id: string
  keys: KnownHostEntry[]
}

/**
 * Groups the flat list by host and port.
 *
 * A host offers a different key per algorithm, so the flat list shows the same
 * hostname two or three times over — which reads as duplicates rather than as
 * "this host has an Ed25519 and an RSA key". Grouping is also what makes
 * "forget this host" expressible as one action instead of three clicks that can
 * be abandoned halfway.
 *
 * Order is preserved from the backend, which sorts; this only has to be stable,
 * not to sort again.
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
 * How a host is labelled in the list.
 *
 * The port is shown only when it is not 22, the way every SSH tool writes it:
 * `example.com` and `example.com:2222` are both unambiguous, while
 * `example.com:22` is noise on every row for a distinction that almost never
 * applies.
 */
export function hostLabel(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`
}
