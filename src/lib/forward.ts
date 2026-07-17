import { invoke } from '@tauri-apps/api/core'

export type ForwardSpec =
  | { type: 'local'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'remote'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'dynamic'; bindHost: string; bindPort: number }

// Matches src-tauri/src/ssh.rs's NON_LOOPBACK_BIND_ERROR — recognized by
// callers to prompt for confirmation before retrying with confirmed: true.
export const NON_LOOPBACK_BIND_ERROR = 'non-loopback bind host requires confirmation'

export function addForward(sessionId: string, spec: ForwardSpec, confirmed = false) {
  return invoke<string>('ssh_add_forward', { sessionId, spec, confirmed })
}

export function removeForward(forwardId: string) {
  return invoke<void>('ssh_remove_forward', { forwardId })
}
