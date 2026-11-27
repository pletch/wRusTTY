// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { installReloadBlock, isReloadShortcut } from './blockReload'

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })

describe('reload shortcuts', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => uninstall?.())

  it('recognizes F5 and Ctrl+R, with or without Shift', () => {
    for (const init of [
      { key: 'F5' },
      { key: 'F5', ctrlKey: true },
      { key: 'F5', shiftKey: true },
      { key: 'r', ctrlKey: true },
      { key: 'R', ctrlKey: true, shiftKey: true },
    ]) {
      expect(isReloadShortcut(key(init)), JSON.stringify(init)).toBe(true)
    }
    for (const init of [{ key: 'r' }, { key: 'F4' }, { key: 'r', ctrlKey: true, altKey: true }]) {
      expect(isReloadShortcut(key(init)), JSON.stringify(init)).toBe(false)
    }
  })

  it('cancels an unclaimed reload shortcut', () => {
    uninstall = installReloadBlock()
    const e = key({ key: 'F5' })
    document.body.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  /** A pane encodes F5 for its program and stops it; nothing here may run. */
  it('never sees a key a pane stopped', () => {
    uninstall = installReloadBlock()
    const pane = document.createElement('textarea')
    document.body.appendChild(pane)
    pane.addEventListener('keydown', (e) => e.stopPropagation())
    const e = key({ key: 'F5' })
    pane.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
