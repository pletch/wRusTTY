import type { ConnectionSource } from './connection'
import { blankLeaf } from './paneTree'
import type { Tab } from '../types'

/**
 * What Rust holds so a new webview can rebuild a pane whose session outlived the old
 * one. See `session_attach.rs`.
 */
export interface KeptDescriptor {
  source: ConnectionSource
  label: string
}

/**
 * A source with its secrets taken out. It sits in memory for the session's life, and
 * a reattached pane only needs it to know the transport and to label itself, since
 * the session is already authenticated.
 */
export function sourceForKeeping(source: ConnectionSource): ConnectionSource {
  if (source.protocol !== 'ssh') return source
  return {
    ...source,
    config: { ...source.config, auth: { type: 'KeyboardInteractive' }, jump: null },
  }
}

export function describeForKeeping(source: ConnectionSource, label: string): string {
  const descriptor: KeptDescriptor = { source: sourceForKeeping(source), label }
  return JSON.stringify(descriptor)
}

/** One tab per kept session, or none for a descriptor that can't be read. */
export function tabForKept(
  kept: { sessionId: string; descriptor: string },
  newTabId: () => string,
): Tab | null {
  let parsed: KeptDescriptor
  try {
    parsed = JSON.parse(kept.descriptor) as KeptDescriptor
  } catch {
    return null
  }
  if (!parsed?.source?.protocol) return null
  const leaf = {
    ...blankLeaf(),
    source: parsed.source,
    attachTo: kept.sessionId,
    initial: { label: parsed.label },
  }
  return { id: newTabId(), title: parsed.label, root: leaf, activePaneId: leaf.id } as Tab
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
