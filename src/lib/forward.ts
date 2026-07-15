import { invoke } from '@tauri-apps/api/core'

export type ForwardSpec =
  | { type: 'local'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'remote'; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
  | { type: 'dynamic'; bindHost: string; bindPort: number }

export function addForward(sessionId: string, spec: ForwardSpec) {
  return invoke<string>('ssh_add_forward', { sessionId, spec })
}

export function removeForward(forwardId: string) {
  return invoke<void>('ssh_remove_forward', { forwardId })
}
