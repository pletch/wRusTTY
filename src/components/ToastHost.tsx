import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'
import { subscribe, dismiss } from '../lib/toast'
import type { ToastItem } from '../lib/toast'

const icons = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
}

const accents = {
  success: 'border-emerald-500/30 text-emerald-400',
  error: 'border-red-500/30 text-red-400',
  info: 'border-sky-500/30 text-sky-400',
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => subscribe(setItems), [])

  if (items.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {items.map((t) => {
        const Icon = icons[t.kind]
        return (
          <div
            key={t.id}
            className={`animate-in fade-in slide-in-from-bottom-2 pointer-events-auto flex w-80 items-start gap-2 rounded-lg border bg-[#1f2028] px-3 py-2.5 text-xs shadow-2xl duration-150 ${accents[t.kind]}`}
          >
            <Icon size={15} className="mt-0.5 shrink-0" />
            <p className="min-w-0 flex-1 break-words text-white/85">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-white/30 transition-colors duration-100 hover:text-white/70"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
