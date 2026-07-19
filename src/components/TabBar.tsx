import { useEffect, useRef, useState } from 'react'
import {
  Plus,
  X,
  RotateCw,
  Copy,
  Terminal as TerminalIcon,
  Radio,
  Cable,
  TerminalSquare,
} from 'lucide-react'
import type { PaneNode, Tab } from '../types'
import { allLeaves, isTopSplitVertical } from '../lib/paneTree'
import { DRAG_TAB_MIME } from '../lib/dragTypes'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  statusByPane: Record<string, string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onDuplicate: (id: string) => void
  onReconnect: (id: string) => void
  onReorder: (draggedId: string, targetId: string) => void
}

const protocolIcons = {
  ssh: TerminalIcon,
  sshProfile: TerminalIcon,
  telnet: Radio,
  serial: Cable,
}

/** Mirrors a tab's actual pane tree as nested flex rows/columns (row for a
 * horizontal split, column for a vertical one), sized by each split's real
 * `sizes` — so a stacked split renders as stacked segments here too,
 * instead of every split flattening into left-right slices regardless of
 * its real direction. `activePaneId` of `null` means this tab itself isn't
 * focused: every leaf renders the same dim tone rather than highlighting
 * one, since there's no meaningful "focused pane" to call out from outside
 * the tab that's actually showing it. */
function PaneIndicator({
  node,
  activePaneId,
}: {
  node: PaneNode
  activePaneId: string | null
}) {
  if (node.type === 'leaf') {
    const focused = activePaneId === node.id
    return <span className={`block h-full w-full ${focused ? 'bg-sky-400' : 'bg-sky-400/30'}`} />
  }
  const horizontal = node.direction === 'horizontal'
  return (
    <span className={`flex h-full w-full gap-[2px] ${horizontal ? 'flex-row' : 'flex-col'}`}>
      {node.children.map((child, i) => (
        <span
          key={child.id}
          style={{ flexBasis: `${node.sizes[i]}%`, flexGrow: 0, flexShrink: 0 }}
          // Explicit rather than relying on flexbox's default cross-axis
          // stretch — the parent's main axis (flexBasis, above) sets this
          // segment's *proportional* dimension, but its other one still
          // needs telling to actually fill 100% of the shared cross-axis,
          // or two segments meant to look identically sized on that axis
          // (e.g. two stacked rows, both meant to span the same width) can
          // end up very slightly, but visibly, mismatched at this scale.
          className={`min-h-0 min-w-0 ${horizontal ? 'h-full' : 'w-full'}`}
        >
          <PaneIndicator node={child} activePaneId={activePaneId} />
        </span>
      ))}
    </span>
  )
}

function statusDotColor(status: string | undefined): string | null {
  if (!status) return null
  if (status === 'connected') return 'bg-emerald-400'
  if (status.startsWith('failed') || status === 'disconnected') return 'bg-red-400'
  return 'bg-amber-400'
}

export function TabBar({
  tabs,
  activeTabId,
  statusByPane,
  onSelect,
  onClose,
  onNew,
  onDuplicate,
  onReconnect,
  onReorder,
}: Props) {
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  // Only fade the tabs container's right edge once it's actually
  // scrollable — otherwise every tab fits and there's nothing partially
  // clipped for the fade to hide, so it'd just needlessly dim the last tab.
  // A ResizeObserver (rather than just watching `tabs`) also catches the
  // window itself being resized narrower/wider with the same tab count.
  useEffect(() => {
    const el = tabsContainerRef.current
    if (!el) return
    const checkOverflow = () => setOverflowing(el.scrollWidth > el.clientWidth)
    checkOverflow()
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabs])

  return (
    <div className="relative flex min-w-0 shrink items-stretch">
      {/* Also gives the tab strip natural clearance from the window's
       * rounded corner, replacing what used to just be an empty sliver of
       * padding. */}
      <div className="flex shrink-0 items-center pl-2.5 pr-1.5 text-[#b7410e]">
        <TerminalSquare size={16} strokeWidth={2} />
      </div>
      {/* The fade mask (not just a visual flourish) keeps a tab that's only
       * partially scrolled into view from ending in a harsh mid-content
       * clip — one that, at just the wrong container width, would slice
       * straight through that tab's close button and leave half of it
       * rendered. Only applied once `overflowing` is actually true — with
       * every tab fully visible there's nothing partially clipped for it
       * to hide, so it'd just needlessly dim the last tab. */}
      <div
        ref={tabsContainerRef}
        className="flex min-w-0 shrink items-stretch overflow-x-auto"
        style={
          overflowing
            ? {
                WebkitMaskImage:
                  'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
                maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
              }
            : undefined
        }
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const leaves = allLeaves(tab.root)
          const tall = isTopSplitVertical(tab.root)
          const leaf = leaves.find((l) => l.id === tab.activePaneId)
          const ProtocolIcon = leaf?.source ? protocolIcons[leaf.source.protocol] : null
          const dotColor = leaf ? statusDotColor(statusByPane[leaf.id]) : null
          return (
            <div
              key={tab.id}
              draggable
              onClick={() => onSelect(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
              onDragStart={(e) => {
                setDraggedId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                // Lets an empty pane elsewhere in the window (a totally
                // separate drop target from the other tabs here) recognize
                // this as "a tab being dragged," to attach its connection
                // there — see DRAG_TAB_MIME.
                e.dataTransfer.setData(DRAG_TAB_MIME, tab.id)
              }}
              onDragEnd={() => {
                setDraggedId(null)
                setDropTargetId(null)
              }}
              onDragOver={(e) => {
                if (!draggedId || draggedId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTargetId(tab.id)
              }}
              onDragLeave={() => setDropTargetId((id) => (id === tab.id ? null : id))}
              onDrop={(e) => {
                e.preventDefault()
                if (draggedId) onReorder(draggedId, tab.id)
                setDraggedId(null)
                setDropTargetId(null)
              }}
              className={`group relative flex min-w-[130px] max-w-[200px] cursor-pointer items-center gap-2 border-r border-white/5 px-3 text-xs transition-colors duration-150 ${
                active
                  ? 'bg-white/10 text-white'
                  : 'text-white/45 hover:bg-white/[0.06] hover:text-white/80'
              } ${draggedId === tab.id ? 'opacity-40' : ''} ${
                dropTargetId === tab.id && draggedId !== tab.id ? 'bg-sky-400/10' : ''
              }`}
            >
              {/* A single-pane tab only shows this bar when it's the active
                  tab — plain and full-bright, same as before. A split tab
                  always shows it (even unfocused), dimmed, purely to signal
                  "this tab has multiple panes" at a glance; the active
                  tab's own split additionally highlights whichever pane has
                  keyboard focus. */}
              {(active || leaves.length > 1) && (
                <span className={`absolute inset-x-0 top-0 ${tall ? 'h-[5px]' : 'h-[2px]'}`}>
                  <PaneIndicator node={tab.root} activePaneId={active ? tab.activePaneId : null} />
                </span>
              )}
              {dropTargetId === tab.id && draggedId !== tab.id && (
                <span className="absolute inset-y-0 left-0 w-0.5 bg-sky-400" />
              )}
              {ProtocolIcon && (
                <span className="relative shrink-0 text-white/40">
                  <ProtocolIcon size={12} />
                  {dotColor && (
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-[#1a1b22] transition-colors duration-300 ${dotColor}`}
                    />
                  )}
                </span>
              )}
              <span className="truncate">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                className="ml-auto shrink-0 rounded p-0.5 text-white/40 opacity-0 transition-opacity duration-150 hover:bg-white/10 hover:text-white group-hover:opacity-100"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        onClick={onNew}
        className="flex shrink-0 items-center justify-center px-3 py-2 text-white/45 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
        title="New connection (Ctrl+Shift+T)"
      >
        <Plus size={16} strokeWidth={2} />
      </button>

      {menu && (
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-36 origin-top-left rounded-md border border-white/10 bg-[#1f2028] py-1 text-xs text-white/80 shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              onReconnect(menu.tabId)
              setMenu(null)
            }}
          >
            <RotateCw size={13} /> Reconnect
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              onDuplicate(menu.tabId)
              setMenu(null)
            }}
          >
            <Copy size={13} /> Duplicate
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-300 transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              onClose(menu.tabId)
              setMenu(null)
            }}
          >
            <X size={13} /> Close
          </button>
        </div>
      )}
    </div>
  )
}
