import type { LocalConfig } from '../lib/local'

interface Props {
  config: LocalConfig
  onChange: (config: LocalConfig) => void
  inputClass: string
}

/**
 * The connect form for a local shell.
 *
 * Deliberately spare, and temporary in one specific way: it asks for a path
 * because nothing can yet offer a list. Shell detection —
 * `local_shells_list`, enumerating installed PowerShell, CMD, Git Bash and WSL
 * distros — is Phase 3 of docs/LOCAL_SHELL_PLAN.md, and when it lands this
 * field becomes a picker with the typed path as the escape hatch rather than
 * the only route.
 *
 * Arguments are split on whitespace here and sent as argv. That is a
 * simplification the picker will remove: a real profile's arguments come from
 * detection (`-d Ubuntu` for a WSL distro, `-i -l` for Git Bash) and never
 * need parsing at all. Splitting naively is fine for the one thing this form
 * is for — typing a path and pressing connect — and wrong for a path with a
 * space in it, which is exactly why the backend takes argv rather than a
 * command line and why this is the only place a string is ever split.
 */
export function LocalFields({ config, onChange, inputClass }: Props) {
  return (
    <>
      <input
        className={`${inputClass} w-full`}
        placeholder="path to shell"
        value={config.command}
        onChange={(e) => onChange({ ...config, command: e.target.value })}
        required
        spellCheck={false}
      />
      <input
        className={`${inputClass} w-full`}
        placeholder="arguments (optional)"
        value={config.args.join(' ')}
        onChange={(e) =>
          onChange({ ...config, args: e.target.value.split(/\s+/).filter(Boolean) })
        }
        spellCheck={false}
      />
      <input
        className={`${inputClass} w-full`}
        placeholder="working directory (optional — defaults to home)"
        value={config.cwd ?? ''}
        onChange={(e) => onChange({ ...config, cwd: e.target.value.trim() || null })}
        spellCheck={false}
      />
    </>
  )
}
