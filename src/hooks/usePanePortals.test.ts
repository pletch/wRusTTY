// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePanePortals } from './usePanePortals'

function makeSlot(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('usePanePortals', () => {
  it('returns the same home container across repeated calls for one pane', () => {
    const { result } = renderHook(() => usePanePortals(['p1']))
    const a = result.current.getHomeContainer('p1')
    const b = result.current.getHomeContainer('p1')
    expect(a).toBe(b)
  })

  it('parks a home container invisibly on document.body before it has a slot', () => {
    const { result } = renderHook(() => usePanePortals(['p1']))
    const home = result.current.getHomeContainer('p1')
    expect(home.parentElement).toBe(document.body)
  })

  it('relocates the home container into a registered slot without changing its identity', () => {
    const { result } = renderHook(() => usePanePortals(['p1']))
    const home = result.current.getHomeContainer('p1')
    const slot = makeSlot()

    act(() => {
      result.current.registerSlot('p1', slot)
    })

    expect(result.current.getHomeContainer('p1')).toBe(home)
    expect(home.parentElement).toBe(slot)
  })

  // This is the invariant that actually matters: React's reconciler tears
  // down and reconnects a live session whenever createPortal's target
  // container changes identity, even if the pane id (the portal's key)
  // stays the same. A split, a pop-to-new-tab and a drag-attach all
  // reparent the pane's slot div in the React tree — each producing a
  // brand new slot element — but none of them may ever be allowed to
  // change which home container div a live pane's Terminal is portaled
  // into, or the connection tears down and reconnects.
  it("a leaf's home container is the same DOM node before and after a split, a pop-to-new-tab, and a drag-attach", () => {
    const { result } = renderHook(() => usePanePortals(['p1']))
    const home = result.current.getHomeContainer('p1')

    // Before any slot exists (e.g. mid-transition), the container is parked
    // off-tree — still the same node.
    expect(result.current.getHomeContainer('p1')).toBe(home)

    // Split: the leaf remounts inside a new PanelGroup, producing a fresh
    // slot div for the same pane id.
    const slotAfterSplit = makeSlot()
    act(() => result.current.registerSlot('p1', slotAfterSplit))
    expect(result.current.getHomeContainer('p1')).toBe(home)
    expect(home.parentElement).toBe(slotAfterSplit)

    // Pop to a new tab: the old slot unregisters (unmounts), a new one
    // registers in the new tab.
    const slotAfterPop = makeSlot()
    act(() => {
      result.current.registerSlot('p1', null)
      result.current.registerSlot('p1', slotAfterPop)
    })
    expect(result.current.getHomeContainer('p1')).toBe(home)
    expect(home.parentElement).toBe(slotAfterPop)

    // Drag-attach: same pattern again — old slot gone, new slot elsewhere.
    const slotAfterAttach = makeSlot()
    act(() => {
      result.current.registerSlot('p1', null)
      result.current.registerSlot('p1', slotAfterAttach)
    })
    expect(result.current.getHomeContainer('p1')).toBe(home)
    expect(home.parentElement).toBe(slotAfterAttach)
  })

  it('prunes the home container once its pane id is no longer live', () => {
    const { result, rerender } = renderHook(({ liveIds }) => usePanePortals(liveIds), {
      initialProps: { liveIds: ['p1'] },
    })
    const home = result.current.getHomeContainer('p1')
    expect(home.isConnected).toBe(true)

    act(() => rerender({ liveIds: [] }))

    expect(home.isConnected).toBe(false)
    // A fresh container is created for the same id on the next request —
    // the old one is gone for good, not reused.
    expect(result.current.getHomeContainer('p1')).not.toBe(home)
  })

  it('does not prune a still-live pane', () => {
    const { result, rerender } = renderHook(({ liveIds }) => usePanePortals(liveIds), {
      initialProps: { liveIds: ['p1', 'p2'] },
    })
    const home1 = result.current.getHomeContainer('p1')

    act(() => rerender({ liveIds: ['p1', 'p2'] }))

    expect(home1.isConnected).toBe(true)
    expect(result.current.getHomeContainer('p1')).toBe(home1)
  })

  it('registerSlot(paneId, null) is a no-op when that pane never had a slot', () => {
    const { result } = renderHook(() => usePanePortals(['p1']))
    expect(() => act(() => result.current.registerSlot('p1', null))).not.toThrow()
  })
})
