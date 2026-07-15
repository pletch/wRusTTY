import { useEffect, useState } from 'react'
import { Plus, X, RotateCw, Copy, Terminal as TerminalIcon, Radio, Cable } from 'lucide-react'
import type { Tab } from '../types'
import { allLeaves } from '../lib/paneTree'

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

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  return (
    <div className="relative flex h-10 shrink-0 items-center border-b border-white/10 bg-black/20">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const leaf = allLeaves(tab.root).find((l) => l.id === tab.activePaneId)
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
              {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-sky-400" />}
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
