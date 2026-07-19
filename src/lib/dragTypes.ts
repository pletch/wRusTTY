/** Custom drag MIME type used when dragging a tab (identified by its id)
 * onto an empty pane to attach its connection there. Distinct from any
 * built-in type so pane drop targets can tell "a tab is being dragged over
 * me" apart from, say, a file being dragged in from the OS. */
export const DRAG_TAB_MIME = 'application/x-wrustty-tab-id'

/** Custom drag MIME type used when dragging a split pane (by its grip
 * handle) onto the tab bar to pop it out into its own tab. Carries a JSON
 * {tabId, paneId} payload — a pane id alone isn't enough to identify which
 * tab to remove it from. */
export const DRAG_PANE_MIME = 'application/x-wrustty-pane-id'
