/**
 * What a file dropped on a pane should do, or why it can't. A drop that
 * silently does nothing is worse than one refused out loud, since the user
 * believes the file arrived.
 */

/** Everything about a drop that decides whether it can be accepted. */
export interface DropState {
  /** SSH is the only transport with a file channel at all. */
  transport: 'ssh' | 'telnet' | 'serial' | 'local' | 'elevated'
  /** A live session id; a dropped connection can't send. */
  connected: boolean
  /** An upload is already running in this pane. */
  busy: boolean
  /** Any of the dropped items is a directory. */
  folder: boolean
  /** How many files came with the drop. */
  fileCount: number
}

export type DropVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Each refusal is a different thing to fix, so the first that applies is
 * the one reported.
 */
export function verdictForDrop(state: DropState): DropVerdict {
  if (state.transport !== 'ssh') {
    return {
      ok: false,
      reason: 'Files can only be sent over SSH — this pane is not an SSH session.',
    }
  }
  if (!state.connected) {
    return { ok: false, reason: 'Not connected — nothing to upload to.' }
  }
  if (state.busy) {
    return { ok: false, reason: 'One upload at a time — wait for the current one to finish.' }
  }
  // Before the file count: a folder also arrives as one item.
  if (state.folder) {
    return { ok: false, reason: 'Sending a folder is not supported yet — drop a file.' }
  }
  if (state.fileCount === 0) {
    return { ok: false, reason: 'Nothing usable in that drop.' }
  }
  if (state.fileCount > 1) {
    return { ok: false, reason: 'Drop one file at a time.' }
  }
  return { ok: true }
}
