import { invoke } from '@tauri-apps/api/core'
import { onBackButtonPress } from '@tauri-apps/api/app'
import { hasDismissable } from './dismissStack'
import { dismissShownTouchSelection } from './ghostty/TouchSelection'

interface BackSteps {
  /** Closes the topmost menu, panel or dialog. False if none is open. */
  closeTopSurface(): boolean
  /** Clears a touch selection. False if there isn't one. */
  clearSelection(): boolean
  /** Leaves the app, with its sessions still running. */
  leaveApp(): void
}

/**
 * What Android's back gesture does: closes the topmost thing that's open, and only
 * leaves the app once nothing is. It sends nothing to the terminal.
 */
export function handleBack(steps: BackSteps): void {
  if (steps.closeTopSurface()) return
  if (steps.clearSelection()) return
  steps.leaveApp()
}

/** The surfaces already close on Escape, topmost only (see `dismissStack`). Dispatched
 * on `window`, so the terminal's input never sees it. */
function closeTopSurface(): boolean {
  if (!hasDismissable()) return false
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true
}

function leaveApp(): void {
  invoke('leave_app').catch((e: unknown) => {
    console.warn('could not leave the app', e)
  })
}

/** Takes over the gesture. Resolves to what releases it. */
export function startBackHandling() {
  return onBackButtonPress(() => {
    handleBack({ closeTopSurface, clearSelection: dismissShownTouchSelection, leaveApp })
  })
}
