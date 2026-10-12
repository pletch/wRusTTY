/** Drag MIME type for a tab (by id) dropped on an empty pane to attach its
 * connection; distinct from OS file drags. */
export const DRAG_TAB_MIME = 'application/x-wrustty-tab-id'

/** Drag MIME type for a split pane (by its grip) dropped on the tab bar to
 * pop it out. Carries JSON {tabId, paneId}. */
export const DRAG_PANE_MIME = 'application/x-wrustty-pane-id'
