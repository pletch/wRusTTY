export type AuthMethod =
  | { type: 'Password'; password: string }
  | { type: 'PublicKey'; key_path: string; passphrase: string | null }
  | { type: 'KeyboardInteractive' }
  /** Delegate to a running SSH agent (Pageant, or the Windows OpenSSH agent
   * service). Carries no secret — the agent holds the key and signs on our
   * behalf, which is also the only way to use a key that can't be exported
   * at all, such as a FIDO2 security key or a PIV smartcard. */
  | { type: 'Agent' }

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: AuthMethod
  jump?: SshConfig | null
  /** Overrides the `TERM` sent with the PTY request. Null/omitted sends
   * `xterm-256color`, which is right almost everywhere; `vt100` is the usual
   * override for network and embedded gear that renders badly otherwise. */
  term_type?: string | null
  /** Seconds between SSH keepalives. Null/omitted uses the 60s default; 0
   * disables them (PuTTY's own meaning for the value). The knob behind "my
   * session keeps dropping" — corporate firewalls and NAT commonly drop an
   * idle flow after 5-10 minutes with no notice to either end. */
  keepalive_seconds?: number | null
}
