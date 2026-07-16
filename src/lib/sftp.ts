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

export function editFile(sessionId: string, remotePath: string, channel: Channel<SftpEvent>) {
  return invoke<string>('sftp_edit_file', { sessionId, remotePath, channel })
}

export function stopWatching(editId: string) {
  return invoke<void>('sftp_stop_watching', { editId })
}
