/**
 * What a file dropped on a pane should do — or why it cannot.
 *
 * The rules are the feature. Sending a file is the easy half; the half that
 * decides whether this is safe to have is knowing when *not* to, and saying so
 * rather than appearing to work. A drop that silently does nothing is worse
 * than one that is refused out loud, because the user walks away believing the
 * file arrived.
 *
 * Extracted from the pane so the rules can be read and tested in one place
 * instead of inferred from a drag handler.
 */

/** Everything about a drop that decides whether it can be accepted. */
export interface DropState {
  /** SSH is the only transport with a file channel at all. */
  transport: 'ssh' | 'telnet' | 'serial'
  /** A live session id — a pane whose connection has dropped cannot send. */
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
 * The order matters: each refusal below is a *different* thing to fix, and the
 * first true one is the one worth telling the user about. Reporting "drop one
 * file at a time" to someone on a serial console would send them off solving
 * the wrong problem.
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
  // Before the file count, because a folder drop also arrives as one item and
  // "drop one file at a time" would be a baffling thing to be told about it.
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
