import { describe, it, expect } from 'vitest'

import { glyphForShell, glyphForShellId } from './shellIconFor'
import { CommandPromptIcon, GitIcon, LinuxIcon } from './ShellIcons'
import * as bundled from './ShellIcons'
import { defaultLocalConfig } from '../lib/local'

describe('glyphForShellId', () => {
  /** Microsoft's trademark terms prohibit distributing its logos, so these
   *  three are read from the user's own executables rather than bundled. */
  it('reads the Microsoft shells from their executables', () => {
    for (const id of ['pwsh', 'powershell', 'cmd']) {
      expect(glyphForShellId(id)).toEqual({
        kind: 'installed',
        shellId: id,
        fallback: CommandPromptIcon,
      })
    }
  })

  /** The regression this exists to prevent: a Microsoft logo creeping back
   *  into the bundle. Simple Icons withdrew it for exactly that reason. */
  it('bundles no PowerShell mark', () => {
    expect(Object.keys(bundled).some((name) => /powershell/i.test(name))).toBe(false)
  })

  it('bundles the marks that may be redistributed', () => {
    expect(glyphForShellId('git-bash')).toEqual({ kind: 'bundled', icon: GitIcon })
  })

  /** Every distro shares one glyph — mapping each name to its own mark would
   *  be an open-ended set, and an unknown distro is still Linux. */
  it('gives every WSL distro the Linux mark', () => {
    expect(glyphForShellId('wsl:Debian')).toEqual({ kind: 'bundled', icon: LinuxIcon })
    expect(glyphForShellId('wsl:Ubuntu 22.04 LTS')).toEqual({ kind: 'bundled', icon: LinuxIcon })
    expect(glyphForShellId('wsl')).toEqual({ kind: 'bundled', icon: LinuxIcon })
  })

  /** Null falls back to the generic local icon. Putting someone's trademark on
   *  a binary this app has not identified is the thing to avoid. */
  it('declines to mark anything it does not recognise', () => {
    expect(glyphForShellId('')).toBeNull()
    expect(glyphForShellId('my-shell')).toBeNull()
    // Not a WSL distro — the prefix has to be exact.
    expect(glyphForShellId('wslish')).toBeNull()
  })
})

describe('glyphForShell', () => {
  const config = (command: string, args: string[] = []) => ({
    ...defaultLocalConfig(),
    command,
    args,
  })

  it('classifies an ad-hoc session from its command', () => {
    expect(glyphForShell(config(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`))).toMatchObject({
      kind: 'installed',
      shellId: 'pwsh',
    })
    expect(glyphForShell(config(String.raw`C:\Windows\System32\cmd.exe`))).toMatchObject({
      kind: 'installed',
      shellId: 'cmd',
    })
    // A bash on PATH is not necessarily Git's.
    expect(glyphForShell(config(String.raw`C:\Program Files\Git\bin\bash.exe`))).toBeNull()
    expect(glyphForShell(config(String.raw`D:\portable\thing.exe`))).toBeNull()
  })

  /** The distro lives in the arguments, not the path. */
  it('recognises a WSL launcher by its arguments', () => {
    expect(
      glyphForShell(config(String.raw`C:\Windows\System32\wsl.exe`, ['-d', 'Debian', '--cd', '~'])),
    ).toEqual({ kind: 'bundled', icon: LinuxIcon })
  })
})
