import { describe, it, expect } from 'vitest'
import type { ConnectDialogInitial } from '../components/ConnectDialog'
import {
  connectDraftReducer,
  initialConnectDraft,
  isInitiallyVaulted,
  TERM_CUSTOM,
  TELNET_DEFAULT_TERM,
  NEW_FOLDER_SENTINEL,
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
