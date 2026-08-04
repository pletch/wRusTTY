import { describe, it, expect } from 'vitest'
import type { ConnectDialogInitial } from '../components/ConnectDialog'
import {
  connectDraftReducer,
  initialConnectDraft,
  isInitiallyVaulted,
  TERM_CUSTOM,
  TELNET_DEFAULT_TERM,
  NEW_FOLDER_SENTINEL,
  MAC_PATTERN,
  normalizeMac,
  wakeOnLanFrom,
} from './connectDraft'
import type { ConnectDraft } from './connectDraft'

describe('initialConnectDraft', () => {
  it('defaults a from-scratch form to ssh with port 22', () => {
    const draft = initialConnectDraft(undefined)
    expect(draft.protocol).toBe('ssh')
    expect(draft.port).toBe('22')
    expect(draft.termType).toBe('')
    expect(draft.termCustom).toBe(false)
    expect(draft.saveProfile).toBe(false)
    expect(draft.saveCredential).toBe(false)
  })

  it('defaults a telnet form to port 23 and the telnet default term type', () => {
    const draft = initialConnectDraft({ protocol: 'telnet' })
    expect(draft.port).toBe('23')
    expect(draft.termType).toBe(TELNET_DEFAULT_TERM)
  })

  it('a saved termType wins over the protocol default, with no post-mount reset needed', () => {
    const draft = initialConnectDraft({ protocol: 'telnet', termType: 'linux' })
    expect(draft.termType).toBe('linux')
  })

  it('detects a termType not on the known list as custom', () => {
    const draft = initialConnectDraft({ termType: 'putty-256color' })
    expect(draft.termCustom).toBe(true)
    expect(draft.termType).toBe('putty-256color')
  })

  it('a known termType is not custom', () => {
    const draft = initialConnectDraft({ termType: 'vt100' })
    expect(draft.termCustom).toBe(false)
  })

  it('prefills from a profile and defaults saveProfile/saveCredential on', () => {
    const initial: ConnectDialogInitial = { id: 'p1', host: 'h', hasCredential: true }
    const draft = initialConnectDraft(initial)
    expect(draft.host).toBe('h')
    expect(draft.saveProfile).toBe(true)
    expect(draft.saveCredential).toBe(true)
  })

  it('leaves keyPath at the conventional default for a from-scratch key auth form', () => {
    const draft = initialConnectDraft({ authType: 'PublicKey' })
    expect(draft.keyPath).toBe('~/.ssh/id_ed25519')
    expect(draft.keyStorage).toBe('path')
  })

  it('blanks keyPath and selects vault storage for an initially-vaulted key', () => {
    const initial: ConnectDialogInitial = { authType: 'PublicKey', hasCredential: true }
    // keyPath deliberately absent (undefined), matching a key stored in the vault
    const draft = initialConnectDraft(initial)
    expect(draft.keyPath).toBe('')
    expect(draft.keyStorage).toBe('vault')
  })

  it('a key with an explicit path is not considered vaulted even with hasCredential set', () => {
    const initial: ConnectDialogInitial = { authType: 'PublicKey', hasCredential: true, keyPath: '/home/me/.ssh/id_rsa' }
    expect(isInitiallyVaulted(initial)).toBe(false)
    const draft = initialConnectDraft(initial)
    expect(draft.keyPath).toBe('/home/me/.ssh/id_rsa')
    expect(draft.keyStorage).toBe('path')
  })
})

describe('protocolSwitched', () => {
  const base = initialConnectDraft(undefined) // ssh, port 22, no initial termType

  it('swaps the default port from ssh to telnet', () => {
    const next = connectDraftReducer(base, { type: 'protocolSwitched', protocol: 'telnet', hasInitialTermType: false })
    expect(next.port).toBe('23')
  })

  it('swaps the default port from telnet back to ssh', () => {
    const telnet = connectDraftReducer(base, { type: 'protocolSwitched', protocol: 'telnet', hasInitialTermType: false })
    const back = connectDraftReducer(telnet, { type: 'protocolSwitched', protocol: 'ssh', hasInitialTermType: false })
    expect(back.port).toBe('22')
  })

  it('does not touch a port the user customized away from the default', () => {
    const customized: ConnectDraft = { ...base, port: '2222' }
    const next = connectDraftReducer(customized, { type: 'protocolSwitched', protocol: 'telnet', hasInitialTermType: false })
    expect(next.port).toBe('2222')
  })

  it('resets termType to the new protocol default when there was no initial termType', () => {
    const withCustomTerm: ConnectDraft = { ...base, termType: 'vt220', termCustom: false }
    const next = connectDraftReducer(withCustomTerm, {
      type: 'protocolSwitched',
      protocol: 'telnet',
      hasInitialTermType: false,
    })
    expect(next.termType).toBe(TELNET_DEFAULT_TERM)
    expect(next.termCustom).toBe(false)
  })

  it('leaves termType alone when the form was prefilled from a saved session', () => {
    const withSavedTerm: ConnectDraft = { ...base, termType: 'vt220' }
    const next = connectDraftReducer(withSavedTerm, {
      type: 'protocolSwitched',
      protocol: 'telnet',
      hasInitialTermType: true,
    })
    expect(next.termType).toBe('vt220')
  })
})

describe('termTypeSelected', () => {
  const base = initialConnectDraft(undefined)

  it('selecting a known type sets it directly', () => {
    const next = connectDraftReducer(base, { type: 'termTypeSelected', value: 'vt220' })
    expect(next.termType).toBe('vt220')
    expect(next.termCustom).toBe(false)
  })

  it('selecting Custom clears the field instead of carrying over the old value', () => {
    const withTerm: ConnectDraft = { ...base, termType: 'vt220' }
    const next = connectDraftReducer(withTerm, { type: 'termTypeSelected', value: TERM_CUSTOM })
    expect(next.termCustom).toBe(true)
    expect(next.termType).toBe('')
  })
})

describe('folderSelected / newFolderCancelled', () => {
  const base = initialConnectDraft(undefined)

  it('selecting the new-folder sentinel enters new-folder mode with a blank field', () => {
    const next = connectDraftReducer({ ...base, folder: 'Work' }, {
      type: 'folderSelected',
      value: NEW_FOLDER_SENTINEL,
    })
    expect(next.isNewFolder).toBe(true)
    expect(next.folder).toBe('')
  })

  it('selecting an existing folder sets it directly', () => {
    const next = connectDraftReducer(base, { type: 'folderSelected', value: 'Work' })
    expect(next.folder).toBe('Work')
    expect(next.isNewFolder).toBe(false)
  })

  it('cancelling new-folder mode restores the original folder', () => {
    const inNewFolderMode: ConnectDraft = { ...base, isNewFolder: true, folder: 'typed so far' }
    const next = connectDraftReducer(inNewFolderMode, { type: 'newFolderCancelled', initialFolder: 'Work' })
    expect(next.isNewFolder).toBe(false)
    expect(next.folder).toBe('Work')
  })
})

describe('fieldSet', () => {
  it('sets an arbitrary field without touching the rest of the draft', () => {
    const base = initialConnectDraft(undefined)
    const next = connectDraftReducer(base, { type: 'fieldSet', field: 'host', value: 'example.com' })
    expect(next.host).toBe('example.com')
    expect(next.port).toBe(base.port)
  })

  it('works for boolean fields', () => {
    const base = initialConnectDraft(undefined)
    const next = connectDraftReducer(base, { type: 'fieldSet', field: 'saveProfile', value: true })
    expect(next.saveProfile).toBe(true)
  })
})

describe('normalizeMac', () => {
  it('accepts a MAC however it was written down', () => {
    for (const text of ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', 'AABBCCDDEEFF']) {
      expect(normalizeMac(text)).toBe('aa:bb:cc:dd:ee:ff')
    }
  })

  it('rejects anything that isn\'t six bytes of hex', () => {
    for (const text of ['', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'aa:bb:cc:dd:ee:gg']) {
      expect(normalizeMac(text)).toBeNull()
    }
  })

  /** The pattern the input enforces has to agree with the parser behind it,
   * or the form blocks something the backend would have accepted. */
  it('agrees with the input pattern about what a MAC is', () => {
    const pattern = new RegExp(`^(?:${MAC_PATTERN})$`)
    for (const text of ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', 'AABBCCDDEEFF']) {
      expect(pattern.test(text)).toBe(true)
    }
    for (const text of ['aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:gg', 'nope']) {
      expect(pattern.test(text)).toBe(false)
    }
  })
})

describe('wakeOnLanFrom', () => {
  const withWake = (fields: Partial<ConnectDraft>): ConnectDraft => ({
    ...initialConnectDraft(undefined),
    ...fields,
  })

  /** An empty MAC field is the feature's off switch — nothing else in the
   * group means anything without one. */
  it('is null when no MAC was given', () => {
    expect(wakeOnLanFrom(withWake({ wakeMac: '', wakeBroadcast: '192.168.1.255' }))).toBeNull()
  })

  it('stores the MAC canonically whatever form it was typed in', () => {
    expect(wakeOnLanFrom(withWake({ wakeMac: 'AABB.CCDD.EEFF' }))?.mac).toBe('aa:bb:cc:dd:ee:ff')
  })

  /** Blank means "use the backend's default" for both, rather than a value
   * here that would have to be kept in step with it. */
  it('leaves the optional fields null when they were left blank', () => {
    const wake = wakeOnLanFrom(withWake({ wakeMac: 'aa:bb:cc:dd:ee:ff' }))
    expect(wake).toEqual({ mac: 'aa:bb:cc:dd:ee:ff', broadcast: null, port: null, waitSeconds: null })
  })

  it('carries a directed broadcast and a custom wait through', () => {
    const wake = wakeOnLanFrom(
      withWake({ wakeMac: 'aa:bb:cc:dd:ee:ff', wakeBroadcast: ' 192.168.1.255 ', wakeWait: '120' }),
    )
    expect(wake?.broadcast).toBe('192.168.1.255')
    expect(wake?.waitSeconds).toBe(120)
  })

  /** The input's pattern is what stops this reaching here; saving something
   * the backend rejects on every connect would be worse than saving nothing. */
  it('is null for a MAC that never parsed', () => {
    expect(wakeOnLanFrom(withWake({ wakeMac: 'the printer' }))).toBeNull()
  })
})

describe('initialConnectDraft wake fields', () => {
  it('opens a saved session on its stored wake settings', () => {
    const draft = initialConnectDraft({
      wakeOnLan: { mac: 'aa:bb:cc:dd:ee:ff', broadcast: '192.168.1.255', port: null, waitSeconds: 90 },
    })
    expect(draft.wakeMac).toBe('aa:bb:cc:dd:ee:ff')
    expect(draft.wakeBroadcast).toBe('192.168.1.255')
    expect(draft.wakeWait).toBe('90')
  })

  it('leaves the fields blank for a session that never waked anything', () => {
    const draft = initialConnectDraft({ host: 'h' })
    expect(draft.wakeMac).toBe('')
    expect(draft.wakeBroadcast).toBe('')
    expect(draft.wakeWait).toBe('')
  })
})
