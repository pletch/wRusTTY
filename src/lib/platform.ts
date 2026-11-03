/** Running in the Android build's webview. */
export const isAndroid = typeof navigator !== 'undefined' && /\bAndroid\b/.test(navigator.userAgent)

/**
 * Below this window height, in CSS pixels, the app's chrome leaves the terminal too
 * little room. A phone in landscape with its keyboard open has about 110, of which the
 * toolbar, tabs and key row take 120. Well above that, and below the shortest window
 * with no keyboard, about 360.
 */
const COMPACT_HEIGHT_PX = 240

export function isCompactHeight(height: number, android = isAndroid): boolean {
  return android && height > 0 && height < COMPACT_HEIGHT_PX
}

/** The button for unlocking the vault without its password, where a prompt doesn't
 * know which method is enrolled. */
export function osUnlockButtonLabel(android = isAndroid): string {
  return android ? 'Unlock with biometrics' : 'Unlock with Windows sign-in'
}

/**
 * Stops a soft keyboard capitalizing and correcting what's typed into any field
 * under `root`. Nearly everything here is a host name, user name, path or command,
 * where a capital first letter is simply wrong. Done as fields take focus, because
 * the dialogs have dozens of them and a new one shouldn't have to remember.
 */
export function relaxTextEntry(root: Document | HTMLElement = document): void {
  root.addEventListener('focusin', (e) => {
    const el = e.target
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
    el.setAttribute('autocapitalize', 'none')
    el.setAttribute('autocorrect', 'off')
    el.spellcheck = false
  })
}
