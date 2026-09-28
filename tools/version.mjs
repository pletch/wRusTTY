#!/usr/bin/env node
// The app's version lives in four files, and a release is a tag plus a
// CHANGELOG section. This keeps all of that in step:
//
//   node tools/version.mjs bump <major|minor|patch|X.Y.Z>
//       Sets the version everywhere, turns CHANGELOG's Unreleased section into
//       a dated one, and refreshes Cargo.lock. Commits and tags nothing — it
//       prints the commands for that, so the diff can be looked at first.
//
//   node tools/version.mjs check [vX.Y.Z]
//       Fails if the four files disagree. Given a tag, also fails unless the
//       tag names that version and CHANGELOG has a section for it. CI runs the
//       first form on every push and the second before publishing a release.
//
//   node tools/version.mjs notes <vX.Y.Z>
//       Prints that version's CHANGELOG section, for the release body.
//
// Edits are string replacements on the version value alone rather than a JSON
// or TOML round-trip, so formatting and line endings are left as they were.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_URL = 'https://github.com/pletch/wrustty'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** Each place the version is written, as [file, pattern whose group 2 is the version]. */
export const SOURCES = [
  ['package.json', /^(\{\s*"name": "wrustty",\s*"private": true,\s*"version": ")([^"]+)/],
  ['package-lock.json', /^(\{\s*"name": "wrustty",\s*"version": ")([^"]+)/],
  ['package-lock.json', /("packages": \{\s*"": \{\s*"name": "wrustty",\s*"version": ")([^"]+)/],
  ['src-tauri/tauri.conf.json', /("productName": "wRusTTY",\s*"version": ")([^"]+)/],
  ['Cargo.toml', /(\[workspace\.package\]\r?\nversion = ")([^"]+)/],
]

export function nextVersion(current, how) {
  if (SEMVER.test(how)) return how
  const m = SEMVER.exec(current)
  if (!m) throw new Error(`current version ${current} is not X.Y.Z`)
  const [major, minor, patch] = m.slice(1).map(Number)
  switch (how) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      throw new Error(`expected major, minor, patch or X.Y.Z, got ${how}`)
  }
}

/** The body of `## [heading]`, up to the next `## ` heading or the link list. */
export function sectionBody(changelog, heading) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(`## [${heading}]`))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## ') || /^\[[^\]]+\]: /.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

/**
 * Moves Unreleased's entries under a new `## [version] - date` heading, leaves
 * Unreleased empty above it, and rewrites the compare links at the foot.
 */
export function rollChangelog(changelog, previous, version, date) {
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n'
  const body = sectionBody(changelog, 'Unreleased')
  if (body === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  if (!body) throw new Error('CHANGELOG.md has nothing under Unreleased — write the entries first')
  if (sectionBody(changelog, version) !== null) throw new Error(`CHANGELOG.md already has ${version}`)

  let out = changelog.replace(/^## \[Unreleased\][^\r\n]*/m, `## [Unreleased]${eol}${eol}## [${version}] - ${date}`)
  const unreleasedLink = /^\[Unreleased\]: .*$/m
  const links =
    `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD${eol}` +
    `[${version}]: ${REPO_URL}/compare/v${previous}...v${version}`
  out = unreleasedLink.test(out) ? out.replace(unreleasedLink, links) : `${out.trimEnd()}${eol}${eol}${links}${eol}`
  return out
}

function readVersions(root) {
  return SOURCES.map(([file, pattern]) => {
    const m = pattern.exec(readFileSync(join(root, file), 'utf8'))
    if (!m) throw new Error(`could not find the version in ${file}`)
    return [file, m[2]]
  })
}

function check(root, tag) {
  const found = readVersions(root)
  const versions = new Set(found.map(([, v]) => v))
  if (versions.size !== 1) {
    throw new Error(`versions disagree:\n${found.map(([f, v]) => `  ${f}: ${v}`).join('\n')}`)
  }
  const [version] = versions
  if (tag !== undefined) {
    if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match version ${version}`)
    const notes = sectionBody(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
    if (!notes) throw new Error(`CHANGELOG.md has no entries for ${version}`)
  }
  return version
}

function bump(root, how) {
  const previous = check(root)
  const version = nextVersion(previous, how)
  const date = new Date().toISOString().slice(0, 10)

  // Validate the changelog before touching anything, so a missing entry
  // leaves the tree as it was.
  const changelogPath = join(root, 'CHANGELOG.md')
  const changelog = rollChangelog(readFileSync(changelogPath, 'utf8'), previous, version, date)

  for (const [file, pattern] of SOURCES) {
    const path = join(root, file)
    writeFileSync(path, readFileSync(path, 'utf8').replace(pattern, `$1${version}`))
  }
  writeFileSync(changelogPath, changelog)
  // Workspace members only: their own entries move to the new version and no
  // dependency is re-resolved.
  execFileSync('cargo', ['update', '--workspace', '--offline'], { cwd: root, stdio: 'inherit' })
  check(root)

  // The files by name, not `commit -a`: work in progress elsewhere in the
  // tree has no business in a release commit.
  const files = [...new Set(SOURCES.map(([file]) => file)), 'Cargo.lock', 'CHANGELOG.md']
  console.log(`\n${previous} -> ${version}. Review the diff, then:\n`)
  console.log(`  git add ${files.join(' ')}`)
  console.log(`  git commit -m "Release ${version}"`)
  console.log(`  git tag v${version}`)
  console.log(`  git push origin main v${version}\n`)
}

function main([command, arg]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  switch (command) {
    case 'bump':
      if (!arg) throw new Error('usage: bump <major|minor|patch|X.Y.Z>')
      return bump(root, arg)
    case 'check':
      return console.log(check(root, arg))
    case 'notes': {
      const notes = sectionBody(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), (arg ?? '').replace(/^v/, ''))
      if (!notes) throw new Error(`CHANGELOG.md has no entries for ${arg}`)
      return console.log(notes)
    }
    default:
      throw new Error('usage: version.mjs <bump|check|notes> [arg]')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`version: ${e.message}`)
    process.exit(1)
  }
}
