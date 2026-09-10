import { describe, it, expect } from 'vitest'

import {
  defaultLocalConfig,
  familyForShellId,
  recordsHistory,
  shellFamily,
  shellIdFor,
  shellLabel,
  type LocalConfig,
} from './local'
import { historyKeyForSource } from './commandHistory'

function config(command: string, args: string[] = []): LocalConfig {
  return { ...defaultLocalConfig(), command, args }
}

describe('shellLabel', () => {
  it('is the executable stem, not the path', () => {
    expect(shellLabel(config('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))).toBe('pwsh')
  })

  it('handles a forward-slash path', () => {
    expect(shellLabel(config('/bin/bash'))).toBe('bash')
  })

  it('names itself when there is nothing to go on', () => {
    expect(shellLabel(config(''))).toBe('shell')
  })
})

/**
 * The classification decision 2 turns on. Getting `powershell` or `cmd` wrong
 * is the expensive direction: a PowerShell read as posix would harvest
 * fragments of half-redrawn PSReadLine edit buffers into the command history,
 * where a posix shell read as PowerShell merely goes without autocomplete.
 */
describe('shellFamily', () => {
  it('recognises both PowerShells', () => {
    expect(shellFamily(config('C:\\PowerShell\\7\\pwsh.exe'))).toBe('powershell')
    expect(shellFamily(config('C:\\Windows\\System32\\powershell.exe'))).toBe('powershell')
  })

  it('recognises cmd', () => {
    expect(shellFamily(config('C:\\Windows\\System32\\cmd.exe'))).toBe('cmd')
  })

  it('treats Git Bash as posix', () => {
    expect(shellFamily(config('C:\\Program Files\\Git\\bin\\bash.exe'))).toBe('posix')
  })

  /** What matters is the shell on the far side of the launcher, which is bash. */
  it('treats wsl as posix', () => {
    expect(shellFamily(config('C:\\Windows\\System32\\wsl.exe', ['-d', 'Ubuntu']))).toBe('posix')
  })

  it('is case-insensitive, since a typed path need not match the install', () => {
    expect(shellFamily(config('C:\\Windows\\System32\\CMD.EXE'))).toBe('cmd')
    expect(shellFamily(config('C:\\PowerShell\\7\\PWSH.EXE'))).toBe('powershell')
  })

  it('falls through to posix for anything unrecognised', () => {
    expect(shellFamily(config('C:\\tools\\zsh.exe'))).toBe('posix')
  })
})

describe('recordsHistory', () => {
  it('declines PowerShell and CMD, allows posix', () => {
    expect(recordsHistory('powershell')).toBe(false)
    expect(recordsHistory('cmd')).toBe(false)
    expect(recordsHistory('posix')).toBe(true)
  })
})

describe('familyForShellId', () => {
  it('classifies the detected ids', () => {
    expect(familyForShellId('pwsh')).toBe('powershell')
    expect(familyForShellId('powershell')).toBe('powershell')
    expect(familyForShellId('cmd')).toBe('cmd')
    expect(familyForShellId('git-bash')).toBe('posix')
    expect(familyForShellId('wsl:Ubuntu')).toBe('posix')
  })

  /** A hand-typed path has no id, and that is not the same as posix. */
  it('is null when there is no id', () => {
    expect(familyForShellId('')).toBeNull()
  })
})

describe('shellIdFor', () => {
  it('matches the id detection would have given', () => {
    expect(shellIdFor(config('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))).toBe('pwsh')
    expect(shellIdFor(config('C:\\Windows\\System32\\cmd.exe'))).toBe('cmd')
  })

  /** `local://wsl` would pool every distro's history into one — exactly what
   *  keying by distro exists to prevent. */
  it('reads the distro out of a wsl invocation', () => {
    const ubuntu = config('C:\\Windows\\System32\\wsl.exe', ['-d', 'Ubuntu', '--cd', '~'])
    const debian = config('C:\\Windows\\System32\\wsl.exe', ['-d', 'Debian', '--cd', '~'])
    expect(shellIdFor(ubuntu)).toBe('wsl:Ubuntu')
    expect(shellIdFor(debian)).toBe('wsl:Debian')
    expect(shellIdFor(ubuntu)).not.toBe(shellIdFor(debian))
  })

  it('falls back to the bare launcher when no distro is named', () => {
    expect(shellIdFor(config('C:\\Windows\\System32\\wsl.exe'))).toBe('wsl')
  })
})

/**
 * The gate itself, asserted through the function the pane actually calls.
 *
 * Null means "this pane records nothing" and is checked where the key is
 * chosen rather than filtered afterwards — see the "must not regress" list in
 * docs/LOCAL_SHELL_PLAN.md.
 */
describe('historyKeyForSource, for local shells', () => {
  it('records nothing for a local PowerShell or CMD', () => {
    expect(
      historyKeyForSource({ protocol: 'local', config: config('C:\\pwsh.exe') }),
    ).toBeNull()
    expect(historyKeyForSource({ protocol: 'local', config: config('C:\\cmd.exe') })).toBeNull()
  })

  it('records for a local bash, like any other bash host', () => {
    expect(
      historyKeyForSource({
        protocol: 'local',
        config: config('C:\\Program Files\\Git\\bin\\bash.exe', ['-i', '-l']),
      }),
    ).toBe('local://bash')
  })

  it('gives each WSL distro its own history', () => {
    const key = (distro: string) =>
      historyKeyForSource({
        protocol: 'local',
        config: config('C:\\Windows\\System32\\wsl.exe', ['-d', distro, '--cd', '~']),
      })
    expect(key('Ubuntu')).toBe('local://wsl:Ubuntu')
    expect(key('Ubuntu')).not.toBe(key('Debian'))
  })

  it('files a saved posix shell under its profile id', () => {
    expect(
      historyKeyForSource({ protocol: 'localProfile', profileId: 'abc', shellId: 'wsl:Ubuntu' }),
    ).toBe('profile://abc')
  })

  it('still records nothing for a saved PowerShell', () => {
    expect(
      historyKeyForSource({ protocol: 'localProfile', profileId: 'abc', shellId: 'pwsh' }),
    ).toBeNull()
  })

  /** A profile saved from a hand-typed path has no id to classify by, and
   *  guessing is the expensive direction to be wrong in. */
  it('records nothing for a saved shell of unknown family', () => {
    expect(
      historyKeyForSource({ protocol: 'localProfile', profileId: 'abc', shellId: '' }),
    ).toBeNull()
  })
})
