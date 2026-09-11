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

const iconRequests = new Map<string, Promise<string | null>>()
const iconAnswers = new Map<string, string | null>()

/** A detected shell's own icon, as a PNG data URL, or null when it has none.
 *
 * Read from the shell's executable on this machine by the backend — see
 * src-tauri/src/shell_icon.rs for why the Microsoft shells' icons are never
 * bundled. Asked for by shell id rather than by path, so the webview never
 * chooses which file gets read.
 *
 * Cached for the life of the page, and de-duplicated while in flight: every
 * tab of the same shell asks for the same icon, and an installed executable's
 * icon does not change under a running app. Null is cached too, so a shell
 * with no icon is not asked about again on every render. */
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

/** The icon if it has already been fetched: undefined means "not yet asked",
 *  which is different from null's "asked, and there is none". Lets a tab paint
 *  the real icon on its first render once any other tab has fetched it. */
export function cachedShellIconUrl(shellId: string): string | null | undefined {
  return iconAnswers.get(shellId)
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

/** Which family of shell this is, which is what decides how it is driven.
 *
 * Not cosmetic: `docs/TODO.md:406` makes PowerShell and CMD an autocomplete
 * non-goal, and that rule is about the shell rather than about the transport,
 * so it applies to a local pane exactly as it applies to a remote one. See
 * decision 2 of docs/LOCAL_SHELL_PLAN.md.
 */
export type ShellFamily = 'powershell' | 'cmd' | 'posix'

/** Classify a shell from what it runs.
 *
 * By executable name, because that is all an ad-hoc session has — a typed path
 * carries no detected id. `wsl.exe` counts as posix: the thing on the other
 * side of it is bash, and it is bash whose prompt and history this has to
 * reason about.
 *
 * Anything unrecognised is posix. That is the direction that *adds* a feature
 * rather than removing one, and the cost of being wrong is asymmetric: a
 * PowerShell misread as posix would harvest nonsense into the history, while a
 * posix shell misread as PowerShell merely goes without autocomplete. So the
 * two families that must never be wrong are matched explicitly and everything
 * else falls through.
 */
export function shellFamily(config: LocalConfig): ShellFamily {
  const exe = shellLabel(config).toLowerCase()
  if (exe === 'pwsh' || exe === 'powershell') return 'powershell'
  if (exe === 'cmd') return 'cmd'
  return 'posix'
}

/** The same question, for a saved profile that carries a detected id.
 *
 * An id is the better source when there is one: `wsl:Ubuntu` says what the
 * session is without anything having to recognise `wsl.exe`.
 */
export function familyForShellId(shellId: string): ShellFamily | null {
  if (!shellId) return null
  if (shellId === 'pwsh' || shellId === 'powershell') return 'powershell'
  if (shellId === 'cmd') return 'cmd'
  return 'posix'
}

/** The detected-shell id an ad-hoc session would have had.
 *
 * Reconstructed from the command rather than looked up, so a session opened by
 * typing a path files its history in the same place as the same shell picked
 * from the list. The WSL case reads the distro out of `-d`, because
 * `local://wsl` would pool every distro's history into one — the thing
 * decision 1 keys by distro specifically to avoid.
 */
export function shellIdFor(config: LocalConfig): string {
  const exe = shellLabel(config).toLowerCase()
  if (exe === 'wsl') {
    const at = config.args.indexOf('-d')
    const distro = at >= 0 ? config.args[at + 1] : undefined
    return distro ? `wsl:${distro}` : 'wsl'
  }
  return exe
}

/** The shells that may be opened as administrator. Must match
 * `ELEVATABLE_SHELLS` in src-tauri/src/elevation.rs, which is the check that
 * actually counts — this one only decides whether the form offers the box.
 *
 * Detected shells only, and not WSL: elevating `wsl.exe` makes nobody root
 * inside Linux, it only elevates what WSL runs back on the Windows side. See
 * decision 2 of docs/ELEVATED_TABS_PLAN.md. */
export const ELEVATABLE_SHELL_IDS: readonly string[] = ['pwsh', 'powershell', 'cmd', 'git-bash']

/** What a tab calls a shell it recognises — the same names detection gives
 * the picker (src-tauri/src/local_shells.rs), so the tab says `PowerShell`
 * where the list did rather than the executable's `pwsh`. Null for anything
 * else, which keeps `shellLabel`'s file stem.
 *
 * Display only: history keys and log filenames stay on `shellLabel` and
 * `shellIdFor`, which must not move under existing data. */
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

/** Whether wRusTTY's own recent-command autocomplete records for this shell.
 *
 * False for PowerShell and CMD — see [`ShellFamily`]. PSReadLine's Predictive
 * IntelliSense already does the job better from inside the shell, in-process
 * and against the real command grammar, so what is being declined here is a
 * worse duplicate rather than a feature.
 */
export function recordsHistory(family: ShellFamily): boolean {
  return family === 'posix'
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
