import { invoke } from '@tauri-apps/api/core'

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

/** One shell this machine actually has. Mirrors `ShellInfo` in
 * src-tauri/src/local_shells.rs. */
export interface ShellInfo {
  /** Stable across runs and machines — `pwsh`, `cmd`, `wsl:Ubuntu`. Carries no
   * version and no install path, so upgrading PowerShell 7 to 8 does not
   * orphan whatever was keyed by it. */
  id: string
  label: string
  command: string
  args: string[]
}

/** What this machine has, most useful first.
 *
 * A snapshot taken when the form opens rather than a subscription: unlike COM
 * ports, nothing here is hot-plugged.
 *
 * Resolves empty rather than rejecting when there is no backend to ask. That
 * is the `npm run dev` case, where the form still works by typing a path —
 * the picker is a convenience over the text field, never a gate in front of
 * it.
 */
export async function listShells(): Promise<ShellInfo[]> {
  try {
    return await invoke<ShellInfo[]>('local_list_shells')
  } catch {
    return []
  }
}

/** Blank, and filled in by the form once detection answers.
 *
 * Deliberately not a guessed path any more. A hardcoded
 * `C:\Program Files\PowerShell\7\pwsh.exe` was right on this developer's
 * machine and wrong on one without PowerShell 7, where it pre-filled a path
 * that could only fail — worse than an empty field, because it looks like an
 * answer. */
export function defaultLocalConfig(): LocalConfig {
  return {
    command: '',
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
