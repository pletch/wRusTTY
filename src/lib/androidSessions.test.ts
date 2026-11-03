// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { ConnectionSource } from './connection'
import { blankLeaf } from './paneTree'
import { openableHere } from './profiles'
import { sanitizeTabs } from './sessionSnapshot'
import { initialConnectDraft } from '../state/connectDraft'
import type { Tab } from '../types'

/**
 * What a desktop export turns into on a phone, which has no local shells or serial.
 * They're hidden, not deleted, so exporting from the phone still carries them.
 */

vi.mock('./platform', () => ({ isAndroid: true, relaxTextEntry: () => {} }))

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function tabWith(source: ConnectionSource): Tab {
  const leaf = { ...blankLeaf(), source }
  return { id: 'tab', title: 't', root: leaf, activePaneId: leaf.id } as unknown as Tab
}

describe('on Android', () => {
  it('offers only the sessions it can open', () => {
    expect(openableHere({ protocol: 'ssh' })).toBe(true)
    expect(openableHere({ protocol: 'telnet' })).toBe(true)
    expect(openableHere({ protocol: 'serial' })).toBe(false)
    expect(openableHere({ protocol: 'local' })).toBe(false)
  })

  it('filters what it lists, leaving the stored sessions alone', async () => {
    const { listSessions } = await import('./profiles')
    invoke.mockResolvedValueOnce([
      { id: 'a', protocol: 'ssh' },
      { id: 'b', protocol: 'local' },
      { id: 'c', protocol: 'serial' },
      { id: 'd', protocol: 'telnet' },
    ])
    const listed = await listSessions()
    expect(listed.map((s) => s.id)).toEqual(['a', 'd'])
    // Only ever a read: nothing here writes the list back without them.
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('list_sessions')
  })

  it('drops panes from a desktop workspace it could not reopen', () => {
    const opts = { allowSerial: true }
    const local = { protocol: 'localProfile', profileId: 'x', shellId: 'pwsh' } as ConnectionSource
    const elevated = { protocol: 'elevated', shellId: 'pwsh' } as ConnectionSource
    expect(sanitizeTabs([tabWith(local)], opts)).toEqual([])
    expect(sanitizeTabs([tabWith(elevated)], opts)).toEqual([])
    const ssh = { protocol: 'sshProfile', profileId: 'y' } as ConnectionSource
    expect(sanitizeTabs([tabWith(ssh)], opts)).toHaveLength(1)
  })

  it('starts a key in the vault, without a path from another machine', () => {
    const draft = initialConnectDraft({
      protocol: 'ssh',
      authType: 'PublicKey',
      keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
    } as never)
    expect(draft.keyPath).toBe('')
    expect(draft.keyStorage).toBe('vault')
  })
})
