import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { APP_VERSION } from './version'

/**
 * `APP_VERSION` is what the About section reports, and a version number that is
 * wrong is worse than one that is absent — it sends whoever reads a bug report
 * to the wrong commit. These assert it against every manifest that carries the
 * same number, so a release bump that misses one fails here rather than
 * shipping.
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

  /** The Rust side takes `version.workspace = true` from the root manifest, so
   *  this one number covers every crate. Matched loosely — a TOML parser is not
   *  worth a dependency for one field in a `[workspace.package]` block. */
  it('matches the Cargo workspace', () => {
    const cargo = read('Cargo.toml')
    expect(cargo).toMatch(new RegExp(`^version = "${APP_VERSION}"$`, 'm'))
  })
})
