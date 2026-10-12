import { Channel, invoke } from '@tauri-apps/api/core'
import type { RemoteIdentity } from './fileMode'

export type { RemoteIdentity }

export interface RemoteEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
  size: number
  modified: number | null
  /** Permission bits only (`0o755`); null if the server reported none (some
   *  appliances). */
  mode: number | null
  /** Owner and group names. Always null in practice (SFTP v3 carries none);
   *  use `uid`/`gid`. */
  owner: string | null
  group: string | null
  /** Numeric owner and group, which SFTP v3 carries. */
  uid: number | null
  gid: number | null
}

export type SftpEvent =
  // Saving an edit: no progress, nothing to cancel.
  | { type: 'uploading'; editId: string; remotePath: string }
  | { type: 'uploaded'; editId: string; remotePath: string }
  | { type: 'uploadFailed'; editId: string; remotePath: string; error: string }
  // An editor this app launched exited (only with `externalEditor` set).
  // `stillWatching`: it returned too fast (missing its wait flag), so the
  // watch was kept.
  | { type: 'editorExited'; editId: string; remotePath: string; stillWatching: boolean }
  // The remote file changed under an edit and the save was not made;
  // `saveEdit(editId, true)` overwrites anyway.
  | {
      type: 'uploadConflict'
      editId: string
      remotePath: string
      remoteModified: number | null
    }
  // An explicit transfer in either direction; the caller knows which.
  // `transferStarted` arrives only when the backend learned the total (a
  // download, or an upload from a local path).
  | { type: 'transferStarted'; transferId: string; remotePath: string; total: number }
  | { type: 'transferProgress'; transferId: string; transferred: number }
  // Which file a folder transfer is on (1-based `index`).
  | { type: 'transferFile'; transferId: string; name: string; index: number; count: number }
  // A note about a transfer that still succeeded (e.g. skipped symlinks).
  | { type: 'transferNote'; transferId: string; note: string }
  | { type: 'transferDone'; transferId: string; remotePath: string }
  | { type: 'transferCancelled'; transferId: string }
  | { type: 'transferFailed'; transferId: string; remotePath: string; error: string }
  /** The connection dropped and the transfer is waiting to resume; not a
   *  failure. See `TransferInterrupted` in sftp.rs. */
  | { type: 'transferInterrupted'; transferId: string }
  /** The session came back and the transfer resumed under the same id. */
  | { type: 'transferResumed'; transferId: string }
  /** Opening a file as root needs the host's sudo password (not the SSH
   *  credential). Answer once with `respondSudoPrompt`. */
  | { type: 'sudoPrompt'; requestId: string; remotePath: string; retry: boolean }

/**
 * Who the host says this session is connected as; cache it per session. Lets
 * the panel send files that clearly need root straight to sudo. A host that
 * won't answer returns empty fields, and nothing is predicted.
 */
export function remoteIdentity(sessionId: string) {
  return invoke<RemoteIdentity>('sftp_remote_identity', { sessionId })
}

export function listDir(sessionId: string, path: string) {
  return invoke<RemoteEntry[]>('sftp_list_dir', { sessionId, path })
}

export function canonicalize(sessionId: string, path: string) {
  return invoke<string>('sftp_canonicalize', { sessionId, path })
}

export interface ActiveEdit {
  editId: string
  remotePath: string
  /** A root helper is running on the host for this edit until the watch ends;
   *  shown so the user knows. */
  elevated: boolean
}

/**
 * Downloads a remote file to a temp copy, opens it, and watches it for saves.
 *
 * `editorCommand` is the `externalEditor` setting. Empty uses the OS handler,
 * whose watch must be dismissed by hand; a blocking command (`code --wait`)
 * ends the watch itself via `editorExited`.
 *
 * `elevate` opens the file as root, once the mode bits or an actual refusal
 * show it's needed.
 */
export function editFile(
  sessionId: string,
  remotePath: string,
  editorCommand: string,
  channel: Channel<SftpEvent>,
  elevate = false,
) {
  return invoke<string>('sftp_edit_file', {
    sessionId,
    remotePath,
    editorCommand,
    elevate,
    channel,
  })
}

/**
 * Answers a `sudoPrompt`, or cancels with `null`. The password authenticates
 * the one `sudo` call that starts the edit's helper and isn't kept anywhere.
 */
export function respondSudoPrompt(requestId: string, password: string | null) {
  return invoke<void>('sftp_respond_sudo_prompt', { requestId, password })
}

/** Every edit still being watched for this session. Watches outlive the panel,
 * so render the "watching" markers from this. */
export function listEdits(sessionId: string) {
  return invoke<ActiveEdit[]>('sftp_list_edits', { sessionId })
}

/**
 * Saves a watched edit on demand: `force` overwrites after a conflict;
 * otherwise it re-runs the conflict check (a retry). Takes a channel because
 * watches outlive the panel that started them.
 */
export function saveEdit(editId: string, force: boolean, channel: Channel<SftpEvent>) {
  return invoke<void>('sftp_save_edit', { editId, force, channel })
}

/**
 * Makes an open edit save through root (e.g. an `/etc` file that opened fine
 * but whose save was refused). The local copy is untouched. Doesn't save: call
 * `saveEdit` afterward so the conflict check still runs.
 */
export function elevateEdit(editId: string, channel: Channel<SftpEvent>) {
  return invoke<void>('sftp_elevate_edit', { editId, channel })
}

export function stopWatching(editId: string) {
  return invoke<void>('sftp_stop_watching', { editId })
}

/** Whether something exists at `path`, to ask before a transfer starts.
 *  Advisory; `upload` re-checks. */
export function exists(sessionId: string, path: string) {
  return invoke<boolean>('sftp_exists', { sessionId, path })
}

/**
 * Starts an upload of a dropped file into `remoteDir`; the bytes follow via
 * `uploadChunk` (a dropped `File` has no path, since Tauri's native drag-drop
 * is off). The file lands under a `.wrustty-part` name and is renamed into
 * place only on success.
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
 * One slice of the file, as the raw request body with the transfer id in a
 * header (a JSON number array would be ~4x larger). Rejects once the transfer
 * is over, which stops the feeding loop on cancel.
 */
export function uploadChunk(transferId: string, chunk: Uint8Array) {
  return invoke<void>('sftp_upload_chunk', chunk, { headers: { 'transfer-id': transferId } })
}

/** No more chunks; the outcome arrives on the channel. */
export function uploadFinish(transferId: string) {
  return invoke<void>('sftp_upload_finish', { transferId })
}

/**
 * Uploads a file or folder picked in a dialog, by path; the backend reads it
 * directly. Same staging as `uploadBegin`. The remote name is the path's
 * basename, so check `exists` for that before passing `overwrite`.
 */
export function uploadPath(
  sessionId: string,
  remoteDir: string,
  localPath: string,
  overwrite: boolean,
  resume: boolean,
  channel: Channel<SftpEvent>,
) {
  return invoke<string>('sftp_upload_path', {
    sessionId,
    remoteDir,
    localPath,
    overwrite,
    resume,
    channel,
  })
}

/**
 * Streams a remote file or folder to `localPath` and returns the transfer id.
 * The backend writes straight to disk, staged as `.wrustty-part` and renamed
 * into place on success.
 *
 * `resume` skips destination files that already look copied (same size, not
 * older); folders only, set by Retry. The total arrives as `transferStarted`.
 */
export function downloadBegin(
  sessionId: string,
  remotePath: string,
  localPath: string,
  resume: boolean,
  channel: Channel<SftpEvent>,
) {
  return invoke<string>('sftp_download_begin', {
    sessionId,
    remotePath,
    localPath,
    resume,
    channel,
  })
}

/** Asks a running transfer to stop (between chunks). */
export function cancelTransfer(transferId: string) {
  return invoke<void>('sftp_cancel_transfer', { transferId })
}

/**
 * Renames an entry within its own directory, returning the new full path. Never
 * a move (separators are rejected). Rejects if `newName` exists, since SFTP v3
 * rename doesn't replace.
 */
export function rename(sessionId: string, path: string, newName: string) {
  return invoke<string>('sftp_rename', { sessionId, path, newName })
}

/**
 * Deletes a file or directory (the backend checks which). Without `recursive`,
 * a non-empty directory is refused.
 */
export function remove(sessionId: string, path: string, recursive = false) {
  return invoke<void>('sftp_remove', { sessionId, path, recursive })
}

/** What a directory holds, for a specific delete confirmation. */
export interface TreeCount {
  files: number
  dirs: number
  bytes: number
  /** Symlinks: skipped by recursive copy, unlinked (not followed) by delete. */
  links: number
}

export function countTree(sessionId: string, path: string) {
  return invoke<TreeCount>('sftp_count_tree', { sessionId, path })
}

/** Sets the permission bits on a remote path; parse octal input with
 *  `parseOctal`. */
export function chmod(sessionId: string, path: string, mode: number) {
  return invoke<void>('sftp_chmod', { sessionId, path, mode })
}

/** Creates a directory inside `parent`, returning its full path. */
export function mkdir(sessionId: string, parent: string, name: string) {
  return invoke<string>('sftp_mkdir', { sessionId, parent, name })
}
