import { invoke } from '@tauri-apps/api/core'

export type ForwardSpec =
  | { type: 'local'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'remote'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'dynamic'; bindHost: string; bindPort: number }

/** One forward as the backend holds it — see `ForwardInfo` in ssh.rs.
 *
 *  `active: false` is a forward that is down: its connection went away and a
 *  reconnect could not stand it up again, usually because its local port was
 *  taken meanwhile. The row stays, with `error`, because a forward that
 *  silently disappeared is indistinguishable from one that is working. */
export interface ForwardInfo {
  id: string
  spec: ForwardSpec
  active: boolean
  error: string | null
}

// Matches src-tauri/src/ssh.rs's NON_LOOPBACK_BIND_ERROR — recognized by
// callers to prompt for confirmation before retrying with confirmed: true.
export const NON_LOOPBACK_BIND_ERROR = 'non-loopback bind host requires confirmation'

export function addForward(sessionId: string, spec: ForwardSpec, confirmed = false) {
  return invoke<string>('ssh_add_forward', { sessionId, spec, confirmed })
}

export function removeForward(forwardId: string) {
  return invoke<void>('ssh_remove_forward', { forwardId })
}

/** The backend is the authority on what a session is forwarding — this panel
 *  is unmounted while closed, so a list kept here would vanish with it and
 *  leave forwards running that nothing could name. */
export function listForwards(sessionId: string) {
  return invoke<ForwardInfo[]>('ssh_list_forwards', { sessionId })
}

export function retryForward(forwardId: string) {
  return invoke<void>('ssh_retry_forward', { forwardId })
}
