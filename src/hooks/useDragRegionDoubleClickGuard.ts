import { useEffect } from 'react'

/**
 * Stops a double-click that began elsewhere from maximizing the window.
 *
 * Double-clicking the ✕ on the last tab closes it on the first click; the
 * drag-region spacer (App.tsx) then expands under the cursor in time for the
 * second press. Two things maximize on that press, and both are stopped:
 *
 *   1. Tauri's `mousedown` listener (`tauri/src/window/scripts/drag.js`),
 *      which maximizes on a drag-region press with `e.detail === 2`. `detail`
 *      counts presses by time and position, not by element.
 *   2. The spacer's own `onDoubleClick`: `dblclick` is dispatched at the
 *      completing click's target, so suppressing the mousedown doesn't stop
 *      it.
 *
 * The rule: a double-click means what its first press aimed at. Listeners
 * run in the capture phase on `document`, ahead of Tauri's and React's, and
 * `stopImmediatePropagation` only in the suppressed case. No
 * `preventDefault`, so focus and selection are unaffected.
 */
export function useDragRegionDoubleClickGuard() {
  useEffect(() => {
    // Whether the previous left press was over a drag region.
    let previousWasDragRegion = false
    // Remembered for the events after the second press (its `dblclick`, and the
    // mouseup macOS maximizes on), when `previousWasDragRegion` has moved on.
    let suppressing = false

    const inDragRegion = (target: EventTarget | null) =>
      target instanceof Element && target.closest('[data-tauri-drag-region]') !== null

    const onMouseDown = (e: MouseEvent) => {
      // Only left presses maximize or count; a right-click mustn't update the flag.
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
