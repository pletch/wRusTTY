export type AuthMethod =
  | { type: 'Password'; password: string }
  | { type: 'PublicKey'; key_path: string; passphrase: string | null }
  | { type: 'KeyboardInteractive' }

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: AuthMethod
  jump?: SshConfig | null
}
