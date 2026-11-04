import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/app', () => ({ onBackButtonPress: vi.fn() }))

import { handleBack } from './backGesture'

function steps(surface: boolean, selection: boolean) {
  const calls: string[] = []
  return {
    calls,
    closeTopSurface: () => {
      calls.push('surface')
      return surface
    },
    clearSelection: () => {
      calls.push('selection')
      return selection
    },
    leaveApp: () => {
      calls.push('leave')
    },
  }
}

describe('handleBack', () => {
  it('closes what is open before touching a selection or leaving', () => {
    const s = steps(true, true)
    handleBack(s)
    expect(s.calls).toEqual(['surface'])
  })

  it('clears a selection once nothing is open', () => {
    const s = steps(false, true)
    handleBack(s)
    expect(s.calls).toEqual(['surface', 'selection'])
  })

  it('leaves the app only when there is nothing else to do', () => {
    const s = steps(false, false)
    handleBack(s)
    expect(s.calls).toEqual(['surface', 'selection', 'leave'])
  })
})
