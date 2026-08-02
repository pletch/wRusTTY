import { describe, expect, it } from 'vitest'
import {
  expandHome,
  nameError,
  safeSuggestedName,
  startDirFor,
  verdictForDownload,
  verdictForMutation,
} from './fileActions'

describe('verdictForDownload', () => {
  it('allows an ordinary file', () => {
    expect(verdictForDownload({ isDir: false, busy: false })).toEqual({ ok: true })
  })

  it('refuses a folder, which needs a recursive queue nothing has yet', () => {
    const verdict = verdictForDownload({ isDir: true, busy: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/folder/i)
  })

  /** The transient obstacle is reported ahead of the permanent one, matching
   *  `verdictForDrop`: being told "pick a file, not a folder" while a transfer
   *  is what's actually in the way sends the user after the wrong problem. */
  it('reports the running transfer before the folder limit', () => {
    const verdict = verdictForDownload({ isDir: true, busy: true })
    expect(verdict.ok === false && verdict.reason).toMatch(/one transfer at a time/i)
  })
})

describe('startDirFor', () => {
  it('prefers what the host actually reported', () => {
    expect(startDirFor('/etc/nginx', 'tim@build01: /tmp')).toBe('/etc/nginx')
  })

  /**
   * The case this was written for. A stock bash on Debian or RHEL sets the
   * window title and no OSC 7 at all, so the panel opened at the home
   * directory however plainly the title said `/tmp`.
   */
  it('falls back to the title when nothing was reported', () => {
    expect(startDirFor(null, 'tim@build01: /tmp')).toBe('/tmp')
    expect(startDirFor(undefined, 'tim@build01: /var/log')).toBe('/var/log')
  })

  it('gives up rather than guessing at a title that is not a path', () => {
    expect(startDirFor(null, 'vim README.md')).toBeNull()
    expect(startDirFor(null, null)).toBeNull()
    expect(startDirFor(null, undefined)).toBeNull()
  })

  /** `\w` renders the home directory as `~`, so this is what most of these
   *  titles actually look like. Passed through for `expandHome` to resolve. */
  it('passes a tilde path through rather than dropping it', () => {
    expect(startDirFor(null, 'tim@build01: ~/src')).toBe('~/src')
  })
})

describe('expandHome', () => {
  it('resolves a bare tilde to the home directory', () => {
    expect(expandHome('~', '/home/tim')).toBe('/home/tim')
  })

  it('resolves a tilde path', () => {
    expect(expandHome('~/src/wrustty', '/home/tim')).toBe('/home/tim/src/wrustty')
  })

  it('does not double the separator when home is the root', () => {
    expect(expandHome('~/src', '/')).toBe('/src')
    expect(expandHome('~/src', '/home/tim/')).toBe('/home/tim/src')
  })

  it('leaves an absolute path alone', () => {
    expect(expandHome('/tmp', '/home/tim')).toBe('/tmp')
  })

  /** Only a *leading* tilde is home. A directory called `~backup` is a
   *  directory called `~backup`. */
  it('leaves a tilde that is not the whole first segment alone', () => {
    expect(expandHome('~backup', '/home/tim')).toBe('~backup')
    expect(expandHome('/srv/~cache', '/home/tim')).toBe('/srv/~cache')
  })
})

describe('verdictForMutation', () => {
  it('allows renaming or deleting a file nothing is watching', () => {
    expect(verdictForMutation({ watched: false })).toEqual({ ok: true })
  })

  /** The watch holds the old remote path and nothing re-targets it, so a
   *  rename leaves the next save recreating the old name and a delete leaves it
   *  bringing the file back — minutes later, and reported as a success. */
  it('refuses while an edit watch is still pointing at it', () => {
    const verdict = verdictForMutation({ watched: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/stop watching/i)
  })
})

describe('nameError', () => {
  it('accepts ordinary names', () => {
    for (const name of ['notes.txt', 'my folder', '.config', 'a-b_c.2026', 'файл.txt']) {
      expect(nameError(name)).toBeNull()
    }
  })

  it('rejects an empty name', () => {
    expect(nameError('')).toMatch(/empty/i)
  })

  it('rejects the two names that are not names', () => {
    expect(nameError('.')).toMatch(/not a name/i)
    expect(nameError('..')).toMatch(/not a name/i)
  })

  /** The name is joined onto the directory the user is looking at, so a
   *  separator would act somewhere they did not choose — the difference
   *  between renaming a file and moving it into `/etc`. */
  it('rejects either separator', () => {
    expect(nameError('a/b')).toMatch(/slash/i)
    expect(nameError('a\\b')).toMatch(/slash/i)
    expect(nameError('../passwd')).toMatch(/slash/i)
  })

  it('rejects control characters', () => {
    expect(nameError('a\0b')).toMatch(/control/i)
    expect(nameError('a\nb')).toMatch(/control/i)
  })
})

describe('safeSuggestedName', () => {
  it('leaves an ordinary filename alone', () => {
    for (const name of ['notes.txt', 'my report.log', 'archive.tar.gz', '.bashrc', 'a-b_c.conf']) {
      expect(safeSuggestedName(name)).toBe(name)
    }
  })

  /** The one with teeth. `NUL` is the null device on Windows however it is
   *  spelled or extended: accepted as a save target, the download would be
   *  written to nowhere and reported as a success. */
  it('defuses reserved device names, extension or not', () => {
    expect(safeSuggestedName('NUL')).toBe('_NUL')
    expect(safeSuggestedName('nul.txt')).toBe('_nul.txt')
    expect(safeSuggestedName('COM1')).toBe('_COM1')
    expect(safeSuggestedName('lpt9.conf')).toBe('_lpt9.conf')
  })

  it('leaves names that merely start like a device alone', () => {
    for (const name of ['console.log', 'communication.md', 'COM10.txt', 'auxiliary.conf']) {
      expect(safeSuggestedName(name)).toBe(name)
    }
  })

  it('replaces characters Windows forbids', () => {
    expect(safeSuggestedName('what?.txt')).toBe('what_.txt')
    expect(safeSuggestedName('a<b>c|d*e.log')).toBe('a_b_c_d_e.log')
    expect(safeSuggestedName('notes.txt:stream')).toBe('notes.txt_stream')
  })

  /** A separator would make the suggestion a *path*, silently redirecting the
   *  save somewhere the user did not choose. */
  it('replaces both path separators', () => {
    expect(safeSuggestedName('../etc/passwd')).toBe('.._etc_passwd')
    expect(safeSuggestedName('a\\b.txt')).toBe('a_b.txt')
  })

  /** Stripped during Windows path normalisation, so the name written would not
   *  be the name shown. */
  it('drops trailing dots and spaces', () => {
    expect(safeSuggestedName('report.txt.')).toBe('report.txt')
    expect(safeSuggestedName('report.txt ')).toBe('report.txt')
  })

  it('falls back to something usable when nothing survives', () => {
    expect(safeSuggestedName('.')).toBe('download')
    expect(safeSuggestedName('..')).toBe('download')
    expect(safeSuggestedName('   ')).toBe('download')
  })
})
