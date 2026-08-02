import { describe, expect, it } from 'vitest'
import { groupByHost, hostLabel, type KnownHostEntry } from './knownHosts'

function entry(host: string, port: number, algorithm: string | null): KnownHostEntry {
  return {
    host,
    port,
    algorithm,
    fingerprint: algorithm ? `SHA256:${host}-${algorithm}` : null,
    keyText: `${algorithm ?? 'broken'} AAAA-${host}-${port}`,
  }
}

describe('groupByHost', () => {
  /** A host offers a different key per algorithm, so the flat list shows the
   *  same name two or three times — which reads as duplicates rather than as
   *  one host with several keys. */
  it('gathers a host’s algorithms under one entry', () => {
    const groups = groupByHost([
      entry('example.com', 22, 'ssh-ed25519'),
      entry('example.com', 22, 'ecdsa-sha2-nistp256'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].host).toBe('example.com')
    expect(groups[0].keys.map((k) => k.algorithm)).toEqual([
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
    ])
  })

  /** The same name on two ports is two hosts — a jump host and a container on
   *  2222 have no reason to share a key, and merging them would offer to forget
   *  trust the user did not mean to touch. */
  it('keeps the same hostname on different ports apart', () => {
    const groups = groupByHost([
      entry('example.com', 22, 'ssh-ed25519'),
      entry('example.com', 2222, 'ssh-ed25519'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.id)).toEqual(['example.com:22', 'example.com:2222'])
  })

  it('preserves the order the backend sorted into', () => {
    const groups = groupByHost([
      entry('a.example', 22, 'ssh-ed25519'),
      entry('b.example', 22, 'ssh-ed25519'),
      entry('a.example', 22, 'ssh-rsa'),
    ])
    expect(groups.map((g) => g.host)).toEqual(['a.example', 'b.example'])
    expect(groups[0].keys).toHaveLength(2)
  })

  it('keeps an unparseable entry, which is the one most worth deleting', () => {
    const groups = groupByHost([entry('example.com', 22, null)])
    expect(groups[0].keys[0].fingerprint).toBeNull()
    expect(groups[0].keys[0].keyText).not.toBe('')
  })

  it('has nothing to show for an empty store', () => {
    expect(groupByHost([])).toEqual([])
  })
})

describe('hostLabel', () => {
  it('leaves the default port off', () => {
    expect(hostLabel('example.com', 22)).toBe('example.com')
  })

  it('shows any other port', () => {
    expect(hostLabel('example.com', 2222)).toBe('example.com:2222')
    expect(hostLabel('[::1]', 2222)).toBe('[::1]:2222')
  })
})
