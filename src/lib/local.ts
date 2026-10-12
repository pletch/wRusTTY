import { invoke } from '@tauri-apps/api/core'

/**
 * Local shell sessions: a process on this machine, on a Windows
 * pseudoconsole. Mirrors `LocalConfig` in crates/wr-local/src/config.rs: the
 * command is an absolute path and the arguments are argv, never a command
 * line to be parsed.
 */

export interface LocalConfig {
  /** Absolute path, resolved at detection rather than on PATH at connect. */
  command: string
  /** Arguments, already split. Never a command line. */
  args: string[]
  /** Working directory, or null for the user's home. */
  cwd: string | null
  /** Variables set on top of the inherited environment, not replacing it. */
  env: [string, string][]
  /** Overrides TERM; null sends xterm-256color. Read by WSL and Git Bash;
   * PowerShell and CMD take their capabilities from ConPTY. */
  termType: string | null
}

/** One shell this machine actually has. Mirrors `ShellInfo` in
 * src-tauri/src/local_shells.rs. */
export interface ShellInfo {
  /** Stable across runs and machines (`pwsh`, `cmd`, `wsl:Ubuntu`). No version
   * or path, so an upgrade doesn't orphan anything keyed by it. */
  id: string
  label: string
  command: string
  args: string[]
}

/** What this machine has, most useful first. A snapshot, since nothing here is
 * hot-plugged. Resolves empty without a backend (`npm run dev`); typing a path
 * still works. */
export async function listShells(): Promise<ShellInfo[]> {
  try {
    return await invoke<ShellInfo[]>('local_list_shells')
  } catch {
    return []
  }
}

const iconRequests = new Map<string, Promise<string | null>>()
const iconAnswers = new Map<string, string | null>()

/** A detected shell's own icon as a PNG data URL, or null. Read from the
 * executable by the backend (src-tauri/src/shell_icon.rs), asked for by id so
 * the webview never picks the file. Cached for the page's life, null
 * included, and de-duplicated in flight. */
export function shellIconUrl(shellId: string): Promise<string | null> {
  let request = iconRequests.get(shellId)
  if (!request) {
    request = invoke<string | null>('local_shell_icon', { shellId })
      .catch(() => null)
      .then((url) => {
        iconAnswers.set(shellId, url)
        return url
      })
    iconRequests.set(shellId, request)
  }
  return request
}

/** The icon if already fetched: undefined is "not asked yet", null "none". */
export function cachedShellIconUrl(shellId: string): string | null | undefined {
  return iconAnswers.get(shellId)
}

/** Blank; the form fills it once detection answers. */
export function defaultLocalConfig(): LocalConfig {
  return {
    command: '',
    args: [],
    cwd: null,
    env: [],
    termType: null,
  }
}

/** Which family of shell this is, which decides how it's driven. PowerShell
 * and CMD are an autocomplete non-goal (decision 2 of
 * docs/LOCAL_SHELL_PLAN.md). */
export type ShellFamily = 'powershell' | 'cmd' | 'posix'

/** Classifies a shell by executable name (all an ad hoc session has).
 * `wsl.exe` is posix: bash is on the other side. Anything unrecognized is
 * posix, since misreading PowerShell as posix harvests nonsense while the
 * reverse only loses autocomplete; so the two Windows families are matched
 * explicitly. */
export function shellFamily(config: LocalConfig): ShellFamily {
  const exe = shellLabel(config).toLowerCase()
  if (exe === 'pwsh' || exe === 'powershell') return 'powershell'
  if (exe === 'cmd') return 'cmd'
  return 'posix'
}

/** The same, for a saved profile's detected id (`wsl:Ubuntu` needs no
 * executable matching). */
export function familyForShellId(shellId: string): ShellFamily | null {
  if (!shellId) return null
  if (shellId === 'pwsh' || shellId === 'powershell') return 'powershell'
  if (shellId === 'cmd') return 'cmd'
  return 'posix'
}

/** The detected-shell id an ad hoc session would have had, so a typed path
 * files history with the same shell picked from the list. WSL reads the
 * distro from `-d`, keeping each distro's history separate. */
export function shellIdFor(config: LocalConfig): string {
  const exe = shellLabel(config).toLowerCase()
  if (exe === 'wsl') {
    const at = config.args.indexOf('-d')
    const distro = at >= 0 ? config.args[at + 1] : undefined
    return distro ? `wsl:${distro}` : 'wsl'
  }
  return exe
}

/** Shells that may be opened as administrator. Must match
 * `ELEVATABLE_SHELLS` in src-tauri/src/elevation.rs, the check that counts.
 * Not WSL: elevating `wsl.exe` makes nobody root inside Linux (decision 2 of
 * docs/ELEVATED_TABS_PLAN.md). */
export const ELEVATABLE_SHELL_IDS: readonly string[] = ['pwsh', 'powershell', 'cmd', 'git-bash']

/** A tab's name for a recognized shell, matching the picker (`PowerShell`
 * rather than `pwsh`). Null keeps `shellLabel`'s file stem. Display only:
 * history keys and log names use `shellLabel` and `shellIdFor`. */
export function shellDisplayName(shellId: string): string | null {
  if (shellId.startsWith('wsl:')) return `${shellId.slice(4)} (WSL)`
  const names: Record<string, string> = {
    pwsh: 'PowerShell',
    powershell: 'Windows PowerShell',
    cmd: 'Command Prompt',
    'git-bash': 'Git Bash',
  }
  return names[shellId] ?? null
}

/** A local session's tab name: its detected name when it has one. */
export function localTitle(config: LocalConfig): string {
  return shellDisplayName(shellIdFor(config)) ?? shellLabel(config)
}

export function canElevate(shellId: string): boolean {
  return ELEVATABLE_SHELL_IDS.includes(shellId)
}

/** Whether wRusTTY's autocomplete records for this shell. False for
 * PowerShell and CMD, where PSReadLine's prediction already does it better. */
export function recordsHistory(family: ShellFamily): boolean {
  return family === 'posix'
}

/** What a status bar, tab and log filename call this session: the
 * executable's file stem, matching `LocalConfig::label` in
 * crates/wr-local/src/config.rs. */
export function shellLabel(config: LocalConfig): string {
  const leaf = config.command.split(/[\\/]/).pop() ?? ''
  return leaf.replace(/\.exe$/i, '') || 'shell'
}
