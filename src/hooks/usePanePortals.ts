import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Every live <Terminal> is mounted once, in a flat pool keyed by pane id,
 * and portaled into whichever slot div represents its position (Pane.tsx).
 * Moving a connection between tabs or splits only changes the slot, so the
 * session survives.
 *
 * `liveLeafIds` is every pane id holding a connection, used to prune home
 * containers for leaves that are truly gone. */
export function usePanePortals(liveLeafIds: string[]) {
  const [slots, setSlots] = useState<Record<string, HTMLDivElement>>({})

  // Stable (empty deps; setSlots is stable) so Pane.tsx's per-leaf ref
  // callbacks stay stable; otherwise each render would detach and reattach
  // them, calling setSlots, looping forever.
  const registerSlot = useCallback((paneId: string, el: HTMLDivElement | null) => {
    setSlots((prev) => {
      if (el) {
        if (prev[paneId] === el) return prev
        return { ...prev, [paneId]: el }
      }
      if (!(paneId in prev)) return prev
      const next = { ...prev }
      delete next[paneId]
      return next
    })
  }, [])

  // React recreates a portal's subtree whenever its target container changes,
  // even with the same key, and splitting a pane remounts its slot div. So
  // each connected leaf gets one permanent container, always the portal
  // target, and the layout effect below moves that div (plain DOM, invisible
  // to React) into the leaf's current slot.
  const homeContainers = useRef<Record<string, HTMLDivElement>>({})

  function getHomeContainer(paneId: string): HTMLDivElement {
    let el = homeContainers.current[paneId]
    if (!el) {
      el = document.createElement('div')
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '0'
      el.style.width = '0'
      el.style.height = '0'
      el.style.overflow = 'hidden'
      el.style.pointerEvents = 'none'
      document.body.appendChild(el)
      homeContainers.current[paneId] = el
    }
    return el
  }

  // After every commit, moves each leaf's container into its current slot, or
  // parks it off-tree. A layout effect, so it happens before paint.
  useLayoutEffect(() => {
    for (const paneId of Object.keys(homeContainers.current)) {
      const home = homeContainers.current[paneId]
      const slot = slots[paneId]
      if (slot && home.parentElement !== slot) {
        home.style.position = 'relative'
        home.style.inset = ''
        home.style.width = '100%'
        home.style.height = '100%'
        home.style.overflow = ''
        home.style.pointerEvents = ''
        slot.appendChild(home)
      } else if (!slot && home.parentElement !== document.body) {
        home.style.position = 'fixed'
        home.style.inset = '0'
        home.style.width = '0'
        home.style.height = '0'
        home.style.overflow = 'hidden'
        home.style.pointerEvents = 'none'
        document.body.appendChild(home)
      }
    }
  })

  // Prunes containers for leaves that are truly gone. Keyed on the ids'
  // contents, since the caller rebuilds the array every render; a spurious run
  // does nothing, while a skipped one only defers cleanup.
  const liveKey = liveLeafIds.join(',')
  useEffect(() => {
    const liveIds = new Set(liveLeafIds)
    for (const [id, el] of Object.entries(homeContainers.current)) {
      if (!liveIds.has(id)) {
        el.remove()
        delete homeContainers.current[id]
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey])

  return { registerSlot, getHomeContainer }
}
