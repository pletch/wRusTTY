import { Channel, invoke } from '@tauri-apps/api/core'

export interface RemoteEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
  size: number
  modified: number | null
}

export type SftpEvent =
  | { type: 'uploading'; editId: string; remotePath: string }
  | { type: 'uploaded'; editId: string; remotePath: string }
  | { type: 'uploadFailed'; editId: string; remotePath: string; error: string }

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
