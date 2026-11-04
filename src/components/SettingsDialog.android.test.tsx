// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => new Promise(() => {})) }))
vi.mock('../lib/platform', async (original) => ({
  ...(await original<typeof import('../lib/platform')>()),
  isAndroid: true,
}))

import { resetDismissStack } from '../lib/dismissStack'
import { loadSettings } from '../lib/settings'
import { ConfirmContext } from './confirmContext'
import { SettingsDialog } from './SettingsDialog'

function open() {
  render(
    <ConfirmContext.Provider value={async () => true}>
      <SettingsDialog settings={loadSettings()} onChange={() => {}} vaultStatus="locked" />
    </ConfirmContext.Provider>,
  )
  fireEvent.click(screen.getByTitle('Settings'))
}

function escape() {
  fireEvent.keyDown(window, { key: 'Escape' })
}

describe('SettingsDialog on a phone', () => {
  beforeEach(() => {
    resetDismissStack()
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { check: () => true, ready: Promise.resolve() },
    })
  })
  afterEach(cleanup)

  it('opens on the list of sections, without one showing', () => {
    open()
    expect(screen.getByRole('button', { name: /Appearance/ })).toBeTruthy()
    expect(screen.queryByLabelText('Back to settings')).toBeNull()
  })

  it('hides what does not apply to a phone', () => {
    open()
    for (const hidden of [/Keyboard/, /Remote files/, /Logging/]) {
      expect(screen.queryByRole('button', { name: hidden })).toBeNull()
    }
  })

  it('opens a section in place of the list, and its arrow comes back', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Host keys/ }))
    expect(screen.queryByRole('button', { name: /Appearance/ })).toBeNull()
    fireEvent.click(screen.getByLabelText('Back to settings'))
    expect(screen.getByRole('button', { name: /Appearance/ })).toBeTruthy()
  })

  it('backs out of a section first, and only then closes', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Host keys/ }))
    escape()
    expect(screen.getByRole('button', { name: /Appearance/ })).toBeTruthy()
    escape()
    expect(screen.queryByRole('button', { name: /Appearance/ })).toBeNull()
  })

  it('reopens on the list, not the last section', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /Host keys/ }))
    fireEvent.click(screen.getByTitle('Close (Esc)'))
    fireEvent.click(screen.getByTitle('Settings'))
    expect(screen.getByRole('button', { name: /Appearance/ })).toBeTruthy()
  })
})
