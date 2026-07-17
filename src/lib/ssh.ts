export type AuthMethod =
  | { type: 'Password'; password: string }
  | { type: 'PublicKey'; key_path: string; passphrase: string | null }
  | { type: 'KeyboardInteractive' }

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: AuthMethod
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
