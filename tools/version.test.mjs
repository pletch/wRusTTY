import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SOURCES, nextVersion, rollChangelog, sectionBody } from './version.mjs'

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- A thing.

## [0.2.0] - 2026-08-29

First release.

[Unreleased]: https://github.com/pletch/wRusTTY/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pletch/wRusTTY/releases/tag/v0.2.0
`

describe('nextVersion', () => {
  it('bumps each part and resets the ones below it', () => {
    expect(nextVersion('0.2.3', 'patch')).toBe('0.2.4')
    expect(nextVersion('0.2.3', 'minor')).toBe('0.3.0')
    expect(nextVersion('0.2.3', 'major')).toBe('1.0.0')
  })

  it('takes an explicit version as given', () => {
    expect(nextVersion('0.2.3', '1.0.0')).toBe('1.0.0')
  })

  it('refuses anything else', () => {
    expect(() => nextVersion('0.2.3', 'v1.0.0')).toThrow()
    expect(() => nextVersion('0.2.3', 'next')).toThrow()
  })
})

describe('sectionBody', () => {
  it('stops at the next heading', () => {
    expect(sectionBody(CHANGELOG, 'Unreleased')).toBe('### Added\n\n- A thing.')
  })

  it('stops at the link list for the last section', () => {
    expect(sectionBody(CHANGELOG, '0.2.0')).toBe('First release.')
  })

  it('reads CRLF files', () => {
    expect(sectionBody(CHANGELOG.replace(/\n/g, '\r\n'), '0.2.0')).toBe('First release.')
  })

  it('returns null for a version with no section', () => {
    expect(sectionBody(CHANGELOG, '0.3.0')).toBeNull()
  })
})

describe('rollChangelog', () => {
  it('dates the Unreleased entries and leaves Unreleased empty', () => {
    const out = rollChangelog(CHANGELOG, '0.2.0', '0.3.0', '2026-10-01')
    expect(sectionBody(out, 'Unreleased')).toBe('')
    expect(sectionBody(out, '0.3.0')).toBe('### Added\n\n- A thing.')
    expect(out).toContain('## [0.3.0] - 2026-10-01')
    expect(out).toContain('[Unreleased]: https://github.com/pletch/wRusTTY/compare/v0.3.0...HEAD')
    expect(out).toContain('[0.3.0]: https://github.com/pletch/wRusTTY/compare/v0.2.0...v0.3.0')
    expect(out).toContain('[0.2.0]: https://github.com/pletch/wRusTTY/releases/tag/v0.2.0')
  })

  it('keeps CRLF line endings', () => {
    const out = rollChangelog(CHANGELOG.replace(/\n/g, '\r\n'), '0.2.0', '0.3.0', '2026-10-01')
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('refuses a release with nothing to say', () => {
    const empty = CHANGELOG.replace('### Added\n\n- A thing.\n\n', '')
    expect(() => rollChangelog(empty, '0.2.0', '0.3.0', '2026-10-01')).toThrow(/nothing under Unreleased/)
  })

  it('refuses a version that is already there', () => {
    expect(() => rollChangelog(CHANGELOG, '0.1.0', '0.2.0', '2026-10-01')).toThrow(/already has/)
  })
})

describe('SOURCES', () => {
  // Each pattern is anchored on its file's surrounding structure, so a
  // reformatted file fails here rather than at release time.
  it('finds a version in every file it names', () => {
    for (const [file, pattern] of SOURCES) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(pattern.exec(text)?.[2], file).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
