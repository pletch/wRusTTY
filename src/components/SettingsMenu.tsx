import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import type { TerminalSettings } from '../lib/settings'
import { PRESET_THEMES } from '../lib/theme'

interface Props {
  settings: TerminalSettings
  onChange: (settings: TerminalSettings) => void
}

export function SettingsMenu({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
          open ? 'text-white/90' : 'text-white/50 hover:text-white/90'
        }`}
        title="Terminal settings"
      >
        <Settings size={15} strokeWidth={2} />
      </button>
      {open && (
        <div className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 w-64 origin-top-right rounded-lg border border-white/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100">
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors duration-100 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-0.5 accent-sky-400"
              checked={settings.copyOnSelect}
              onChange={(e) => onChange({ ...settings, copyOnSelect: e.target.checked })}
            />
            <span className="text-white/80">
              Copy on select
              <span className="block text-white/40">
                Selecting text in the terminal copies it automatically.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors duration-100 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-0.5 accent-sky-400"
              checked={settings.rightClickPaste}
              onChange={(e) => onChange({ ...settings, rightClickPaste: e.target.checked })}
            />
            <span className="text-white/80">
              Right-click to paste
              <span className="block text-white/40">
                PuTTY-style: right mouse button pastes the clipboard.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors duration-100 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-0.5 accent-sky-400"
              checked={settings.restoreSessionsOnLaunch}
              onChange={(e) =>
                onChange({ ...settings, restoreSessionsOnLaunch: e.target.checked })
              }
            />
            <span className="text-white/80">
              Restore sessions on launch
              <span className="block text-white/40">
                Offers to reopen open tabs next time you start wRusTTY.
              </span>
            </span>
          </label>
          <div className="mt-1 border-t border-white/10 px-1 pt-2.5">
            <label className="flex items-center justify-between gap-2 text-white/80">
              <span>Theme</span>
              <select
                className="rounded border border-white/10 bg-black/20 px-1.5 py-1 text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
                value={settings.themeName}
                onChange={(e) => onChange({ ...settings, themeName: e.target.value })}
              >
                {PRESET_THEMES.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
