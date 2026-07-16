/** Custom drag MIME type used when dragging a tab (identified by its id)
 * onto an empty pane to attach its connection there. Distinct from any
 * built-in type so pane drop targets can tell "a tab is being dragged over
 * me" apart from, say, a file being dragged in from the OS. */
export const DRAG_TAB_MIME = 'application/x-wr-shell-tab-id'
