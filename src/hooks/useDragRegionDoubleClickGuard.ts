import { useEffect } from 'react'

/**
 * Stops a double-click that *began* somewhere else from maximizing the window.
 *
 * Double-clicking the ✕ on the **last** tab closes it on the first click,
 * `TabBar` shrinks by a tab's width, and the drag-region spacer beside it
 * (App.tsx) expands left into the vacated space — arriving under the stationary
 * cursor exactly in time for the second press. The window maximizes, having
 * been asked to by a gesture aimed at a close button. Closing any other tab is
 * unaffected: another *tab* slides into the gap, not the spacer.
 *
 * **Two independent things maximize on that second press, and both had to be
 * stopped** — each was confirmed to fire on its own in the running app, with
 * the other disabled:
 *
 *   1. Tauri's own `mousedown` listener (`tauri/src/window/scripts/drag.js`),
 *      which maximizes on any press over a `data-tauri-drag-region` element
 *      with `e.detail === 2`. `detail` is the platform click counter: it counts
 *      consecutive presses by time and position, and does not reset when the
 *      second lands on a different element.
 *   2. The spacer's own React `onDoubleClick`. `dblclick` is a separate event
 *      from the presses that compose it, and it is dispatched at the target of
 *      the *completing* click — by then, the spacer. Suppressing the mousedown
 *      does nothing to it, which is exactly what the first attempt at this fix
 *      got wrong.
 *
 * The rule for all three listeners is the same: a double-click means what its
 * first press aimed at. If that press wasn't on a drag region, the second press
 * doesn't make it a drag-region double-click, whatever has since moved under
 * the cursor.
 *
 * Capture phase on `document`, which runs ahead of both Tauri's document-level
 * bubble listener and React's delegated listeners on the root container, so
 * `stopImmediatePropagation` retires the event before either sees it. It fires
 * only in the suppressed case, and only over a drag region.
 *
 * `preventDefault` is deliberately not called: focus and text selection are
 * default actions, and stopping propagation leaves them alone.
 */
export function useDragRegionDoubleClickGuard() {
  useEffect(() => {
    // Whether the previous left press was over a drag region — the state that
    // decides what the *next* one, if it completes a double-click, is aimed at.
    let previousWasDragRegion = false
    // Kept for the events that follow the second press — the `dblclick` it
    // completes, and the mouseup that macOS maximizes on instead (same script).
    // By then `previousWasDragRegion` describes that second press rather than
    // the first, so the verdict has to be remembered rather than recomputed.
    let suppressing = false

    const inDragRegion = (target: EventTarget | null) =>
      target instanceof Element && target.closest('[data-tauri-drag-region]') !== null

    const onMouseDown = (e: MouseEvent) => {
      // Only the left button maximizes, and only left presses advance the
      // click counter we care about — letting a right-click update the flag
      // would misreport what the next left press followed.
      if (e.button !== 0) return
      const here = inDragRegion(e.target)
      suppressing = here && !previousWasDragRegion && e.detail === 2
      previousWasDragRegion = here
      if (suppressing) e.stopImmediatePropagation()
    }

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0 && suppressing) e.stopImmediatePropagation()
    }

    const onDoubleClick = (e: MouseEvent) => {
      if (e.button === 0 && suppressing) e.stopImmediatePropagation()
    }

    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('dblclick', onDoubleClick, true)
    }
  }, [])
}
