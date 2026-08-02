import { Channel, invoke } from '@tauri-apps/api/core'

export interface RemoteEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
  size: number
  modified: number | null
  /** Permission bits alone (`0o755`), never the raw mode — the type is already
   *  in `isDir`/`isSymlink`. Null if the server reported none, which some
   *  appliance SFTP servers do. */
  mode: number | null
  /** Owner and group *names*, when the server sends them. The protocol only
   *  guarantees numeric ids, and a bare `0` tells the user nothing. */
  owner: string | null
  group: string | null
}

export type SftpEvent =
  // An edit being saved: no progress and nothing to cancel, keyed by the edit.
  | { type: 'uploading'; editId: string; remotePath: string }
  | { type: 'uploaded'; editId: string; remotePath: string }
  | { type: 'uploadFailed'; editId: string; remotePath: string; error: string }
  // An editor this app launched has exited. Only ever sent when `externalEditor`
  // is set — the OS handler returns instantly and has nothing to report.
  // `stillWatching` means the command came back too fast to be believed (it is
  // missing its wait flag), so the watch was deliberately left alone.
  | { type: 'editorExited'; editId: string; remotePath: string; stillWatching: boolean }
  // The remote file changed under an edit and the save was *not* made. Nothing
  // has been written when this arrives; `saveEdit(editId, true)` is how the
  // user says to overwrite anyway.
  | {
      type: 'uploadConflict'
      editId: string
      remotePath: string
      remoteModified: number | null
    }
  // An explicit transfer, in either direction: a dropped file, a picked file,
  // a download. Direction is not on the wire — whatever started the transfer
  // already knows which way it goes, and it holds the id.
  //
  // `transferStarted` arrives only when the *backend* is the one that learned
  // the total: a download, or an upload from a local path. A dropped file is
  // sized by the webview before the transfer exists.
  | { type: 'transferStarted'; transferId: string; remotePath: string; total: number }
  | { type: 'transferProgress'; transferId: string; transferred: number }
  // Which file a *folder* transfer is on. Never sent for a single file, which
  // `transferStarted` already named. `index` is 1-based: it is shown as "3 of 57".
  | { type: 'transferFile'; transferId: string; name: string; index: number; count: number }
  // Something worth knowing about a transfer that still succeeded — so far only
  // the symlinks a recursive copy passed over.
  | { type: 'transferNote'; transferId: string; note: string }
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

/**
 * Downloads a remote file to a temp copy, opens it, and watches it for saves.
 *
 * `editorCommand` is the `externalEditor` setting. Empty hands the file to
 * Windows, which returns immediately and can never say when the user is done —
 * so the watch has to be dismissed by hand. A command that blocks
 * (`code --wait`) reports back through `editorExited`, and the watch ends
 * itself.
 */
export function editFile(
  sessionId: string,
  remotePath: string,
  editorCommand: string,
  channel: Channel<SftpEvent>,
) {
  return invoke<string>('sftp_edit_file', { sessionId, remotePath, editorCommand, channel })
}

/** Every edit still being watched for this session, authoritative. Watches
 * outlive the panel that opened them, so this is what the "watching" markers
 * have to be rendered from — the panel's own memory of what it opened
 * forgets watches that are still running (and still uploading on save). */
export function listEdits(sessionId: string) {
  return invoke<ActiveEdit[]>('sftp_list_edits', { sessionId })
}

/**
 * Saves a watched edit on demand — the answer to a conflict prompt.
 *
 * `force` is the user saying "overwrite it anyway" having been told what they
 * would be overwriting. Without it this re-runs the same mtime check the
 * watcher does, which makes it a plain "try that save again" after a failure.
 *
 * Takes a channel because watches outlive the panel that started them: the
 * panel asking is not necessarily the one that opened the file, and the reply
 * has to reach whoever is listening now.
 */
export function saveEdit(editId: string, force: boolean, channel: Channel<SftpEvent>) {
  return invoke<void>('sftp_save_edit', { editId, force, channel })
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

/**
 * Uploads a file the user picked from a dialog, by path.
 *
 * The route for anyone who would rather not drag — and the cheaper one. A
 * dropped file arrives as a `File` with no path on it, so `uploadBegin` has to
 * push its bytes through IPC a chunk at a time; a picked file has a path, so
 * the backend opens it and the webview never touches a byte. Same destination
 * guarantees either way.
 *
 * The remote name comes from the path's own basename, so ask `exists` about
 * that before calling this with `overwrite`.
 */
export function uploadPath(
  sessionId: string,
  remoteDir: string,
  localPath: string,
  overwrite: boolean,
  channel: Channel<SftpEvent>,
) {
  return invoke<string>('sftp_upload_path', {
    sessionId,
    remoteDir,
    localPath,
    overwrite,
    channel,
  })
}

/**
 * Streams a remote file to `localPath` and returns the transfer id.
 *
 * Asymmetric with the drop upload on purpose: a save dialog hands over a real
 * local path, so nothing crosses IPC in this direction — the backend reads the
 * SFTP stream and writes straight to disk. There is no chunk call to make.
 *
 * `localPath` is not written until the whole file has arrived: the download
 * lands beside it under `.wrustty-part` and is renamed over it only on success,
 * so a failed download over an existing file costs nothing.
 *
 * Total size arrives on the channel as `transferStarted` — only the backend can
 * know it, and it comes before the first chunk so a progress bar never has to
 * begin life as a spinner.
 */
export function downloadBegin(
  sessionId: string,
  remotePath: string,
  localPath: string,
  channel: Channel<SftpEvent>,
) {
  return invoke<string>('sftp_download_begin', { sessionId, remotePath, localPath, channel })
}

/** Asks a running transfer to stop, either direction. It stops between chunks,
 *  so this is bounded by one round trip rather than by what is left of the
 *  file. */
export function cancelTransfer(transferId: string) {
  return invoke<void>('sftp_cancel_transfer', { transferId })
}

/**
 * Renames an entry within its own directory, returning the new full path.
 *
 * Cannot move anything: the destination is built from the source's parent plus
 * `newName`, which is rejected if it carries a separator. A rename that quietly
 * turns out to be a move is how a user loses track of a file.
 *
 * Rejects if something is already called `newName`, because SFTP v3's rename
 * does not replace and servers report that badly.
 */
export function rename(sessionId: string, path: string, newName: string) {
  return invoke<string>('sftp_rename', { sessionId, path, newName })
}

/**
 * Deletes a file, or an empty directory.
 *
 * Whether it is a directory is decided by the backend, not by what the listing
 * last said. A non-empty directory is refused — SFTP has no recursive delete,
 * and growing one implicitly out of a menu item is far too sharp an edge.
 */
export function remove(sessionId: string, path: string, recursive = false) {
  return invoke<void>('sftp_remove', { sessionId, path, recursive })
}

/** What a directory holds, so a delete confirmation can say what it is about to
 *  remove. "Are you sure" is worth almost nothing; "341 files in 27
 *  directories" is worth a great deal — but only before the user answers. */
export interface TreeCount {
  files: number
  dirs: number
  bytes: number
  /** Symlinks, which a recursive copy skips and a recursive delete unlinks
   *  without following. */
  links: number
}

export function countTree(sessionId: string, path: string) {
  return invoke<TreeCount>('sftp_count_tree', { sessionId, path })
}

/** Sets the permission bits on a remote path. `mode` is a number — parse the
 *  user's octal with `parseOctal` so display and input agree on what a mode is. */
export function chmod(sessionId: string, path: string, mode: number) {
  return invoke<void>('sftp_chmod', { sessionId, path, mode })
}

/** Creates a directory inside `parent`, returning its full path. */
export function mkdir(sessionId: string, parent: string, name: string) {
  return invoke<string>('sftp_mkdir', { sessionId, parent, name })
}
