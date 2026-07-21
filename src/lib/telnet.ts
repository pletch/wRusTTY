export interface TelnetConfig {
  host: string
  port: number
  /** Sent in reply to the server's TERMINAL-TYPE subnegotiation (RFC 1091).
   * Null/omitted sends `xterm-256color`. Telnet's remaining users are mostly
   * network gear and legacy systems, so `vt100` is a common override here. */
  term_type?: string | null
}
