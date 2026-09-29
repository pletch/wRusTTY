import { describe, it, expect } from 'vitest'
import { findPaths, resolveRemotePath, splitRemotePath } from './pathDetect'

/**
 * The path detector. Like `urlDetect`'s tests, the groups that matter are what
 * the surrounding text owns, what must not become a link, and what a hostile
 * line costs.
 */

describe('findPaths', () => {
  const cases: [string, string, string[]][] = [
    ['an absolute path', 'edit /etc/nginx/nginx.conf now', ['/etc/nginx/nginx.conf']],
    ['a home-relative path', 'cd ~/src/app', ['~/src/app']],
    ['home alone', 'back to ~ again', ['~']],
    ['explicitly relative paths', 'run ./build.sh or ../bin/x', ['./build.sh', '../bin/x']],
    ['a relative path with a separator', 'error in src/main.rs', ['src/main.rs']],
    ['a compiler position', 'src/main.rs:42:7: error', ['src/main.rs']],
    ['a grep position', '/var/log/syslog:120:kernel', ['/var/log/syslog']],
    ['a sentence-ending full stop', 'see /etc/hosts.', ['/etc/hosts']],
    ['a parenthesised aside', '(in /usr/lib)', ['/usr/lib']],
    ['a quoted path', "open '/tmp/a b' and \"/tmp/c\"", ['/tmp/a', '/tmp/c']],
    ['an option value', '--config=/etc/app.toml', ['/etc/app.toml']],
    ['a directory with a trailing slash', 'ls /var/www/', ['/var/www/']],
    ['a dotfile path', 'cat .config/fish/config.fish', ['.config/fish/config.fish']],
    ['two in a row', '/a/b /c/d', ['/a/b', '/c/d']],

    ['nothing in a bare filename', 'README.md Cargo.toml', []],
    ['nothing in a lone slash', 'this / that', []],
    ['nothing in a double slash', '// a comment', []],
    ['nothing in a URL', 'https://example.com/a/b', []],
    ['nothing in scp syntax', 'host:/srv/data', []],
    ['nothing in a trailing-slash word', 'and/ or', []],
    ['nothing in a prose sentence', 'connected to host in 3 ms', []],
  ]
  for (const [name, line, expected] of cases) {
    it(name, () => {
      expect(findPaths(line).map((m) => m.path)).toEqual(expected)
    })
  }

  it('reports offsets that slice back to the path', () => {
    const line = 'x: /etc/hosts:3.'
    const [m] = findPaths(line)
    expect(line.slice(m.start, m.end)).toBe('/etc/hosts')
  })

  it('stays linear on a long slash-less run', () => {
    const line = 'a'.repeat(200_000)
    const t = performance.now()
    expect(findPaths(line)).toEqual([])
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('stays linear on a long run of separators', () => {
    const line = '/'.repeat(100_000) + ' ' + 'a/'.repeat(100_000)
    const t = performance.now()
    findPaths(line)
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('findPaths on Windows', () => {
  const cases: [string, string, string[]][] = [
    ['a drive-absolute path', String.raw`open C:\Users\tim\notes.txt now`, [String.raw`C:\Users\tim\notes.txt`]],
    ['a drive path with forward slashes', 'see D:/work/app.rs', ['D:/work/app.rs']],
    ['a PowerShell prompt', String.raw`PS C:\src\wrustty> `, [String.raw`C:\src\wrustty`]],
    ['backslash-relative paths', String.raw`.\build.ps1 and ..\lib and ~\notes`, [String.raw`.\build.ps1`, String.raw`..\lib`, String.raw`~\notes`]],
    ['a relative path with a backslash', String.raw`error in src\main.rs:4:2`, [String.raw`src\main.rs`]],
    ['an MSBuild position', String.raw`src\app.cs(12,5): error`, [String.raw`src\app.cs`]],
    ['POSIX forms still', 'src/main.rs and /c/Users', ['src/main.rs', '/c/Users']],
    ['nothing in a bare drive', 'drive C: is full', []],
    ['nothing in a UNC path', String.raw`\\server\share\x`, []],
  ]
  for (const [name, line, expected] of cases) {
    it(name, () => {
      expect(findPaths(line, 'windows').map((m) => m.path)).toEqual(expected)
    })
  }

  it('leaves backslashes alone for a POSIX host', () => {
    expect(findPaths(String.raw`src\main.rs C:\x\y`, 'posix')).toEqual([])
  })
})

describe('resolveRemotePath', () => {
  const home = '/home/tim'
  it('keeps an absolute path, normalised', () => {
    expect(resolveRemotePath('/etc//nginx/./conf.d/../nginx.conf', null, home)).toBe('/etc/nginx/nginx.conf')
  })
  it('expands home', () => {
    expect(resolveRemotePath('~', null, home)).toBe('/home/tim')
    expect(resolveRemotePath('~/src', null, home)).toBe('/home/tim/src')
  })
  it('resolves a relative path against the directory', () => {
    expect(resolveRemotePath('src/main.rs', '/srv/app', home)).toBe('/srv/app/src/main.rs')
    expect(resolveRemotePath('../x', '/srv/app', home)).toBe('/srv/x')
  })
  it('accepts a directory that is itself home-relative', () => {
    expect(resolveRemotePath('./a', '~/proj', home)).toBe('/home/tim/proj/a')
  })
  it('has nothing to go on without a directory', () => {
    expect(resolveRemotePath('src/main.rs', null, home)).toBeNull()
  })
  it('does not climb above the root', () => {
    expect(resolveRemotePath('/../../etc', null, home)).toBe('/etc')
  })
})

describe('splitRemotePath', () => {
  it('splits into parent and name', () => {
    expect(splitRemotePath('/etc/hosts')).toEqual({ dir: '/etc', name: 'hosts' })
    expect(splitRemotePath('/etc')).toEqual({ dir: '/', name: 'etc' })
    expect(splitRemotePath('/')).toEqual({ dir: '/', name: null })
  })
})
