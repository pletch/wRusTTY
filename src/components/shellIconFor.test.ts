import { describe, it, expect } from 'vitest'

import { iconForShell, iconForShellId } from './shellIconFor'
import { CommandPromptIcon, GitIcon, LinuxIcon, PowerShellIcon } from './ShellIcons'
import { defaultLocalConfig } from '../lib/local'

describe('iconForShellId', () => {
  it('marks the shells detection knows', () => {
    expect(iconForShellId('pwsh')).toBe(PowerShellIcon)
    expect(iconForShellId('powershell')).toBe(PowerShellIcon)
    expect(iconForShellId('cmd')).toBe(CommandPromptIcon)
    expect(iconForShellId('git-bash')).toBe(GitIcon)
  })

  /** Every distro shares one glyph — mapping each name to its own mark would
   *  be an open-ended set, and an unknown distro is still Linux. */
  it('gives every WSL distro the Linux mark', () => {
    expect(iconForShellId('wsl:Debian')).toBe(LinuxIcon)
    expect(iconForShellId('wsl:Ubuntu 22.04 LTS')).toBe(LinuxIcon)
    expect(iconForShellId('wsl')).toBe(LinuxIcon)
  })

  /** Null falls back to the generic local icon. Stamping someone's trademark
   *  on a binary this app has not identified is the thing to avoid. */
  it('declines to mark anything it does not recognise', () => {
    expect(iconForShellId('')).toBeNull()
    expect(iconForShellId('my-shell')).toBeNull()
    // Not a WSL distro — the prefix has to be exact.
    expect(iconForShellId('wslish')).toBeNull()
  })
})

describe('iconForShell', () => {
  const config = (command: string, args: string[] = []) => ({
    ...defaultLocalConfig(),
    command,
    args,
  })

  it('classifies an ad-hoc session from its command', () => {
    expect(iconForShell(config(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`))).toBe(
      PowerShellIcon,
    )
    expect(iconForShell(config(String.raw`C:\Windows\System32\cmd.exe`))).toBe(CommandPromptIcon)
    expect(iconForShell(config(String.raw`C:\Program Files\Git\bin\bash.exe`))).toBeNull()
    expect(iconForShell(config(String.raw`D:\portable\thing.exe`))).toBeNull()
  })

  /** The distro lives in the arguments, not the path, so a WSL session is only
   *  recognisable once both are read together. */
  it('recognises a WSL launcher by its arguments', () => {
    expect(
      iconForShell(config(String.raw`C:\Windows\System32\wsl.exe`, ['-d', 'Debian', '--cd', '~'])),
    ).toBe(LinuxIcon)
  })
})
