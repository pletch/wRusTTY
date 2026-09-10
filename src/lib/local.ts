/**
 * Local shell sessions — a process on this machine, on a Windows
 * pseudoconsole.
 *
 * Mirrors `LocalConfig` in crates/wr-local/src/config.rs, which is where the
 * reasoning for each field lives. The short version: a saved profile becomes
 * executable content, so the command is an absolute path and the arguments are
 * **argv** rather than a command line to be parsed — a distro name or an
 * install path with a space in it becomes an argument boundary the moment
 * anything concatenates them.
 */

export interface LocalConfig {
  /** Absolute path to the executable. Resolved when the shell was detected,
   * not looked up on PATH at connect time. */
  command: string
  /** Arguments, already split. Never a command line. */
  args: string[]
  /** Working directory, or null for the user's home. */
  cwd: string | null
  /** Variables set on top of the inherited environment, not a replacement for
   * it — a shell with a genuinely empty environment does not start. */
  env: [string, string][]
  /** Overrides TERM; null sends xterm-256color. Read by WSL and Git Bash,
   * ignored by PowerShell and CMD, which take their capabilities from ConPTY
   * rather than from the environment. */
  termType: string | null
}

/** Where PowerShell 7 installs by default.
 *
 * A placeholder, and deliberately a single one rather than a list: shell
 * detection is Phase 3 of docs/LOCAL_SHELL_PLAN.md and will replace this with
 * `local_shells_list`, which enumerates what is actually installed instead of
 * guessing. Until then the connect form pre-fills this and lets the path be
 * edited, so the field is never blank on a machine that has the common case.
 */
export const DEFAULT_SHELL_COMMAND = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

export function defaultLocalConfig(): LocalConfig {
  return {
    command: DEFAULT_SHELL_COMMAND,
    args: [],
    cwd: null,
    env: [],
    termType: null,
  }
}

/** What a status bar, tab and log filename call this session.
 *
 * The executable's file stem, mirroring `LocalConfig::label` in
 * crates/wr-local/src/config.rs: `pwsh`, not
 * `C:\Program Files\PowerShell\7\pwsh.exe`. Kept in step with the Rust
 * side so a pane and its log agree on what to call themselves.
 */
export function shellLabel(config: LocalConfig): string {
  const leaf = config.command.split(/[\\/]/).pop() ?? ''
  return leaf.replace(/\.exe$/i, '') || 'shell'
}
