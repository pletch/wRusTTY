import { useEffect, useState } from 'react'
import type { Tab } from '../types'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onDuplicate: (id: string) => void
  onReconnect: (id: string) => void
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onDuplicate,
  onReconnect,
}: Props) {
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  return (
    <div className="relative flex h-9 shrink-0 items-center border-b border-white/10 bg-black/20">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
              className={`group flex min-w-[120px] max-w-[200px] cursor-pointer items-center gap-2 border-r border-white/10 px-3 text-xs ${
                active ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'
              }`}
            >
              <span className="truncate">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                className="ml-auto rounded px-1 text-white/40 opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <button
        onClick={onNew}
        className="shrink-0 px-3 text-sm text-white/50 hover:bg-white/5 hover:text-white"
        title="New connection (Ctrl+T)"
      >
        +
      </button>

      {menu && (
        <div
          className="fixed z-50 w-32 rounded border border-white/10 bg-[#1f2028] py-1 text-xs text-white/80 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-white/10"
            onClick={() => {
              onReconnect(menu.tabId)
              setMenu(null)
            }}
          >
            Reconnect
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-white/10"
            onClick={() => {
              onDuplicate(menu.tabId)
              setMenu(null)
            }}
          >
            Duplicate
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left text-red-300 hover:bg-white/10"
            onClick={() => {
              onClose(menu.tabId)
              setMenu(null)
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  )
}
