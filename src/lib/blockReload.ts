/**
 * Keeps the webview's own reload shortcuts (F5, Ctrl+R and their Shift
 * variants) from reloading the app when no pane claims them.
 *
 * A pane encodes those keys for its program (F5 is `CSI 15~`, Ctrl+R is
 * `^R`) and stops them there, so this only sees them when focus is somewhere
 * else: the settings dialog, a prompt, the tab strip. A reload from there
 * would bring the window back empty. `lib.rs` closes the sessions a reload
 * leaves behind, but losing every tab to a stray keypress is still worth
 * preventing.
 *
 * On the window in the bubble phase, so a pane that handles the key (and
 * stops it) is never second-guessed, and an in-app binding on the capture
 * phase still runs first.
 */
export function isReloadShortcut(e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey) return false
  if (e.key === 'F5') return true
  return e.ctrlKey && (e.key === 'r' || e.key === 'R')
}

export function installReloadBlock(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isReloadShortcut(e)) e.preventDefault()
  }
  target.addEventListener('keydown', onKeyDown)
  return () => target.removeEventListener('keydown', onKeyDown)
}
