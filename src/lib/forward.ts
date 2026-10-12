import { invoke } from '@tauri-apps/api/core'

export type ForwardSpec =
  | { type: 'local'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'remote'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'dynamic'; bindHost: string; bindPort: number }

/** One forward as the backend holds it (`ForwardInfo` in ssh.rs).
 *  `active: false` is a forward a reconnect couldn't restore (often its local
 *  port was taken); it stays listed with `error` rather than vanishing. */
export interface ForwardInfo {
  id: string
  spec: ForwardSpec
  active: boolean
  error: string | null
}

// Matches NON_LOOPBACK_BIND_ERROR in src-tauri/src/ssh.rs; callers confirm,
// then retry with confirmed: true.
export const NON_LOOPBACK_BIND_ERROR = 'non-loopback bind host requires confirmation'

export function addForward(sessionId: string, spec: ForwardSpec, confirmed = false) {
  return invoke<string>('ssh_add_forward', { sessionId, spec, confirmed })
}

export function removeForward(forwardId: string) {
  return invoke<void>('ssh_remove_forward', { forwardId })
}

/** The backend is authoritative: this panel unmounts when closed. */
export function listForwards(sessionId: string) {
  return invoke<ForwardInfo[]>('ssh_list_forwards', { sessionId })
}

export function retryForward(forwardId: string) {
  return invoke<void>('ssh_retry_forward', { forwardId })
}
