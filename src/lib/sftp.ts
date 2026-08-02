import { Channel, invoke } from '@tauri-apps/api/core'

export interface RemoteEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
  size: number
  modified: number | null
}

export type SftpEvent =
  // An edit being saved: no progress and nothing to cancel, keyed by the edit.
  | { type: 'uploading'; editId: string; remotePath: string }
  | { type: 'uploaded'; editId: string; remotePath: string }
  | { type: 'uploadFailed'; editId: string; remotePath: string; error: string }
  // An explicit upload. `transferStarted` is the only place the id appears —
  // a cancel button has to exist from the moment the transfer does, so the id
  // cannot wait for the command's promise to resolve.
  | { type: 'transferStarted'; transferId: string; remotePath: string; total: number }
  | { type: 'transferProgress'; transferId: string; sent: number }
  | { type: 'transferDone'; transferId: string; remotePath: string }
  | { type: 'transferCancelled'; transferId: string }
  | { type: 'transferFailed'; transferId: string; remotePath: string; error: string }

export function listDir(sessionId: string, path: string) {
  return invoke<RemoteEntry[]>('sftp_list_dir', { sessionId, path })
}

export function canonicalize(sessionId: string, path: string) {
  return invoke<string>('sftp_canonicalize', { sessionId, path })
}

export interface ActiveEdit {
  editId: string
  remotePath: string
}

export function editFile(sessionId: string, remotePath: string, channel: Channel<SftpEvent>) {
  return invoke<string>('sftp_edit_file', { sessionId, remotePath, channel })
}

/** Every edit still being watched for this session, authoritative. Watches
 * outlive the panel that opened them, so this is what the "watching" markers
 * have to be rendered from — the panel's own memory of what it opened
 * forgets watches that are still running (and still uploading on save). */
export function listEdits(sessionId: string) {
  return invoke<ActiveEdit[]>('sftp_list_edits', { sessionId })
}

export function stopWatching(editId: string) {
  return invoke<void>('sftp_stop_watching', { editId })
}

/** Whether something is already at `path`. Advisory — it is stale the moment
 *  it is answered, and `upload` re-checks under its own `overwrite` flag. It
 *  exists so the question can be asked *before* a transfer spends a minute
 *  pushing bytes, not after. */
export function exists(sessionId: string, path: string) {
  return invoke<boolean>('sftp_exists', { sessionId, path })
}

/**
 * Starts an upload into `remoteDir` and returns its transfer id.
 *
 * The bytes follow in `uploadChunk` calls rather than being handed over here:
 * a dropped file reaches the webview as a `File` with no path on it — Tauri's
 * native drag-drop, which would give a path, is off because it breaks the
 * HTML5 drag events tab dragging uses — so the only route to the backend is
 * IPC, and streaming it keeps a large file from being held whole on either
 * side.
 *
 * Nothing at the destination is touched until the whole file has arrived: the
 * transfer lands under a `.wrustty-part` name and is renamed into place only
 * on success.
 */
export function uploadBegin(
  sessionId: string,
  remoteDir: string,
  name: string,
  overwrite: boolean,
  channel: Channel<SftpEvent>,
) {
  return invoke<string>('sftp_upload_begin', { sessionId, remoteDir, name, overwrite, channel })
}

/**
 * One slice of the file.
 *
 * Sent as the request's raw body with the transfer id in a header, because an
 * ordinary command argument would be serialized as a JSON array of numbers —
 * about a megabyte of text per quarter-megabyte chunk, built, sent and parsed.
 *
 * Rejects once the transfer is over, which is how a cancelled upload stops the
 * loop feeding it.
 */
export function uploadChunk(transferId: string, chunk: Uint8Array) {
  return invoke<void>('sftp_upload_chunk', chunk, { headers: { 'transfer-id': transferId } })
}

/** No more chunks. The backend closes the file and reports the outcome on the
 *  channel. */
export function uploadFinish(transferId: string) {
  return invoke<void>('sftp_upload_finish', { transferId })
}

/** Asks a running upload to stop. It stops between chunks, so this is bounded
 *  by one round trip rather than by what is left of the file. */
export function cancelUpload(transferId: string) {
  return invoke<void>('sftp_cancel_upload', { transferId })
}
