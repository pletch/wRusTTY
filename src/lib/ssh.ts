export type AuthMethod =
  | { type: 'Password'; password: string }
  | { type: 'PublicKey'; key_path: string; passphrase: string | null }
  | { type: 'KeyboardInteractive' }
  /** Delegate to a running SSH agent (Pageant or the Windows OpenSSH agent).
   * No secret; the only way to use unexportable keys (FIDO2, PIV). */
  | { type: 'Agent' }

/** An outbound proxy for the first socket (`ProxyConfig` in wr-ssh's
 * proxy.rs). */
export interface ProxyConfig {
  kind: 'http' | 'socks5'
  host: string
  port: number
}

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: AuthMethod
  jump?: SshConfig | null
  /** Overrides `TERM` in the PTY request; null sends `xterm-256color`.
   * `vt100` is the usual override for network gear. */
  term_type?: string | null
  /** Seconds between keepalives; null for 60s, 0 to disable (as in PuTTY). */
  keepalive_seconds?: number | null
}
