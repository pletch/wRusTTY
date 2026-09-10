import { useEffect, useState } from 'react'
import { listShells, type LocalConfig, type ShellInfo } from '../lib/local'

interface Props {
  config: LocalConfig
  onChange: (config: LocalConfig) => void
  inputClass: string
}

/**
 * The connect form for a local shell.
 *
 * A picker over the shells this machine actually has, with the path as an
 * escape hatch rather than the only route. The list comes from
 * `local_list_shells` — see src-tauri/src/local_shells.rs — and choosing an
 * entry fills in both the command *and* its arguments, which is the point:
 * `-d Ubuntu --cd ~` for a WSL distro and `-i -l` for Git Bash are not things
 * a user should have to know, and a Git Bash without `-l` cannot find git.
 *
 * The arguments field splits on whitespace. That is wrong for an argument
 * containing a space and right for everything a person types by hand; it is
 * also why detection supplies argv directly instead of a string for the cases
 * that matter, and why the backend takes argv rather than a command line. A
 * distro called "Ubuntu 22.04 LTS" survives being picked and would not survive
 * being typed.
 */
export function LocalFields({ config, onChange, inputClass }: Props) {
  const [shells, setShells] = useState<ShellInfo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void listShells().then((found) => {
      if (cancelled) return
      setShells(found)
      // Only ever fills a blank form. Re-selecting on every open would
      // overwrite a path the user typed, and editing a saved session would
      // silently discard what it was saved with.
      if (!config.command && found.length > 0) {
        onChange({ ...config, command: found[0].command, args: found[0].args })
      }
    })
    return () => {
      cancelled = true
    }
    // Once, on open: this is a snapshot of the machine, and `config` changing
    // is the user editing the form rather than a reason to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Matched on both halves, so two WSL distros — same executable, different
  // arguments — are not mistaken for each other.
  const selected = shells?.find(
    (s) => s.command === config.command && s.args.join(' ') === config.args.join(' '),
  )

  return (
    <>
      {shells && shells.length > 0 && (
        <select
          className={`${inputClass} w-full`}
          value={selected?.id ?? ''}
          onChange={(e) => {
            const shell = shells.find((s) => s.id === e.target.value)
            if (shell) onChange({ ...config, command: shell.command, args: shell.args })
          }}
        >
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
          {/* Selected whenever the fields below no longer match any detected
              shell, so a hand-edited path does not look like it is still the
              entry it started from. */}
          {!selected && <option value="">Custom</option>}
        </select>
      )}

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
