import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Every live <Terminal> is mounted exactly once, in a flat pool keyed by
 * pane id, and portaled into whichever "slot" div currently represents its
 * position (see Pane.tsx). Dragging a connection between tabs/splits only
 * ever changes which slot its portal points at — the Terminal component
 * itself, and the session/engine instance it owns, never unmounts, so the
 * live connection survives the move untouched.
 *
 * `liveLeafIds` is every pane id currently holding a connection — the same
 * set the caller portals a Terminal into via `getHomeContainer`. Used only
 * to prune home containers for leaves that are truly gone (disconnected or
 * closed, not just mid-move); otherwise every one ever created would sit in
 * the DOM forever. */
export function usePanePortals(liveLeafIds: string[]) {
  const [slots, setSlots] = useState<Record<string, HTMLDivElement>>({})

  // Stable across renders (empty deps — setSlots itself is guaranteed
  // stable by React) so that the per-leaf ref callbacks built from it in
  // Pane.tsx can themselves stay stable. Without that, a fresh callback
  // identity every render makes React think the ref "changed" on every
  // single render, perpetually detaching and reattaching it — each of
  // which calls setSlots, triggering another render, forever.
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

  // React's own reconciler (updatePortal, in react-dom's createChildReconciler)
  // discards and recreates a portal's entire subtree whenever the target
  // container passed to createPortal differs from the previous render's —
  // *even when the key is identical*. Splitting a pane or popping it to a
  // new tab reparents PaneLeafView in the React tree (it switches position
  // between a plain leaf and a child of a new PanelGroup), which unmounts
  // and remounts it, producing a brand new slot div — so portaling directly
  // into `slots[leaf.id]` (whatever it currently is) forces exactly this
  // "different container" case, tearing down and reconnecting the live
  // session, no matter how briefly the container changes. (Two earlier
  // attempts assumed the cause was a timing gap where the slot went
  // missing — a fixed delay, then a hidden fallback container — and both
  // still hit this, since switching between real-slot and fallback is
  // itself a container change.)
  //
  // The fix: never change what a leaf's portal targets. Each connected leaf
  // gets exactly one permanent container div, created once and portaled
  // into for its entire connected lifetime; a layout effect below physically
  // relocates *that same div* (plain DOM appendChild, invisible to React)
  // into whichever slot currently represents its position. The div's
  // identity — and therefore React's containerInfo — never changes, so
  // updatePortal always takes the "reuse" branch.
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

  // Runs after every commit (so after a slot div's own mount/unmount has
  // already happened) and physically moves each connected leaf's permanent
  // container into its current slot, or parks it invisibly off-tree if it
  // doesn't have one at the moment — using useLayoutEffect rather than
  // useEffect so the move happens before the browser paints, avoiding a
  // visible flash of the pane looking empty.
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

  // Prunes home containers for leaves that are truly gone (disconnected or
  // closed, not just mid-move) — otherwise every one ever created would sit
  // in the DOM forever.
  //
  // Keyed on the *contents* of liveLeafIds, not the array: the caller rebuilds
  // it fresh from the pane tree every render, so a reference dep would fire
  // every render exactly as no dep at all does. Erring toward running too
  // often is the safe direction here anyway — this effect only ever removes
  // containers whose pane is no longer live, so a skipped run defers a
  // cleanup, while a spurious run does nothing at all. The dangerous
  // direction would be a dep that let it run with a *stale* live set, which
  // a value dep on the ids themselves cannot do.
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
