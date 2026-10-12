import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { APP_VERSION } from './version'

/**
 * `APP_VERSION` matches every manifest carrying the number, so a release
 * bump that misses one fails here.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8')

describe('APP_VERSION', () => {
  it('matches the version Tauri ships and installs', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }
    expect(conf.version).toBe(APP_VERSION)
  })

  it('matches package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(pkg.version).toBe(APP_VERSION)
  })

  /** Crates take `version.workspace = true` from the root manifest. Matched
   *  loosely rather than with a TOML parser. */
  it('matches the Cargo workspace', () => {
    const cargo = read('Cargo.toml')
    expect(cargo).toMatch(new RegExp(`^version = "${APP_VERSION}"$`, 'm'))
  })
})
