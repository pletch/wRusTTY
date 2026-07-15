import { useEffect, useState } from 'react'
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
        className="px-2 text-white/50 hover:text-white/90"
        title="Terminal settings"
      >
        ⚙
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded border border-white/10 bg-[#1f2028] p-3 text-xs shadow-lg">
          <label className="flex items-start gap-2 py-1 text-white/80">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.copyOnSelect}
              onChange={(e) => onChange({ ...settings, copyOnSelect: e.target.checked })}
            />
            <span>
              Copy on select
              <span className="block text-white/40">
                Selecting text in the terminal copies it automatically.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 py-1 text-white/80">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.rightClickPaste}
              onChange={(e) => onChange({ ...settings, rightClickPaste: e.target.checked })}
            />
            <span>
              Right-click to paste
              <span className="block text-white/40">
                PuTTY-style: right mouse button pastes the clipboard.
              </span>
            </span>
          </label>
          <div className="mt-2 border-t border-white/10 pt-2">
            <label className="flex items-center justify-between gap-2 text-white/80">
              <span>Theme</span>
              <select
                className="rounded border border-white/10 bg-black/20 px-1 py-0.5 text-white/90 outline-none"
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
