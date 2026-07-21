import { useEffect, useState } from 'react'
import { Settings, FolderOpen, ClipboardCopy } from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { TerminalSettings } from '../lib/settings'
import { PRESET_THEMES } from '../lib/theme'
import { revealLogs } from '../lib/logging'
import { toast } from '../lib/toast'
import { SHELL_SNIPPETS } from '../lib/shellSnippets'

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
        <div className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 max-h-[calc(100vh-4rem)] w-64 origin-top-right overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100">
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
              checked={settings.closeOnDisconnect}
              onChange={(e) => onChange({ ...settings, closeOnDisconnect: e.target.checked })}
            />
            <span className="text-white/80">
              Close pane on disconnect
              <span className="block text-white/40">
                When a connection is lost, close the pane automatically instead
                of showing Reconnect actions.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors duration-100 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-0.5 accent-sky-400"
              checked={settings.logPlainText}
              onChange={(e) => onChange({ ...settings, logPlainText: e.target.checked })}
            />
            <span className="text-white/80">
              Plain-text session logs
              <span className="block text-white/40">
                Strip color/escape codes so logs read as text. Off keeps the
                raw stream. Applies to the next log started.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors duration-100 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-0.5 accent-sky-400"
              checked={settings.notifyOnCommandComplete}
              onChange={(e) =>
                onChange({ ...settings, notifyOnCommandComplete: e.target.checked })
              }
            />
            <span className="text-white/80">
              Notify on command completion
              <span className="block text-white/40">
                For long commands finishing in a background tab. Needs shell
                integration on the remote host — see docs/SHELL_INTEGRATION.md.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 transition-colors duration-100 hover:bg-white/5">
            <input
              type="checkbox"
              className="mt-0.5 accent-sky-400"
              checked={settings.bellMarksTab}
              onChange={(e) => onChange({ ...settings, bellMarksTab: e.target.checked })}
            />
            <span className="text-white/80">
              Bell marks the pane
              <span className="block text-white/40">
                A bell from the far end flags its pane in the tab strip until
                you focus it.
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
          <div className="mt-1 px-1 pt-1.5">
            <label className="flex items-center justify-between gap-2 text-white/80">
              <span>Background opacity</span>
              <span className="text-white/50">{Math.round(settings.backgroundOpacity * 100)}%</span>
            </label>
            <input
              type="range"
              min={40}
              max={100}
              step={5}
              className="mt-1 w-full accent-sky-400"
              value={Math.round(settings.backgroundOpacity * 100)}
              onChange={(e) => onChange({ ...settings, backgroundOpacity: Number(e.target.value) / 100 })}
            />
          </div>
          <div className="mt-1.5 px-1">
            <span className="text-white/80">Window effect</span>
            <div className="mt-1 flex gap-1 rounded-md bg-black/20 p-1">
              {(
                [
                  ['off', 'Off'],
                  ['acrylic', 'Acrylic'],
                  ['mica', 'Mica'],
                  ['tabbed', 'Tabbed'],
                ] as const
              ).map(([mode, mLabel]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChange({ ...settings, vibrancyMode: mode })}
                  className={`flex-1 rounded py-1 transition-colors duration-150 ${
                    settings.vibrancyMode === mode
                      ? 'bg-white/15 text-white'
                      : 'text-white/40 hover:text-white/70'
                  }`}
                >
                  {mLabel}
                </button>
              ))}
            </div>
            <p className="mt-1 text-white/40">
              {settings.vibrancyMode === 'acrylic'
                ? 'Live blur-behind, at opacity below 100% — Windows has a documented lag bug on some builds while resizing/dragging.'
                : settings.vibrancyMode === 'mica'
                  ? "A one-time wallpaper-color tint, not a live blur — won't show desktop content moving behind the window."
                  : settings.vibrancyMode === 'tabbed'
                    ? 'Same one-time tint as Mica, tuned for windows with a tab strip — no live blur either. Windows 11 only.'
                    : 'Opacity below 100% still applies as plain unblurred glass, with no OS effect layered under it.'}
            </p>
          </div>
          <div className="mt-2 border-t border-white/10 px-1 pt-2">
            <span className="text-white/80">Shell integration</span>
            <p className="mt-0.5 text-white/40">
              Append to the rc file on a host once and every session there
              reports its commands — to any terminal that speaks OSC 133, not
              just wRusTTY. Emits nothing in non-interactive shells, so scp and
              rsync are unaffected.
            </p>
            <div className="mt-1.5 flex gap-1">
              {SHELL_SNIPPETS.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  onClick={() => {
                    writeText(snippet.script)
                      .then(() => toast.success(`${snippet.label} snippet copied — paste into ${snippet.rcFile}`))
                      .catch((e) => toast.error(`Couldn't copy to clipboard: ${e}`))
                    // Left open deliberately: copying one shell's snippet is
                    // often followed by copying another's for a different
                    // host, and reopening the menu each time to do it would
                    // be needless friction.
                  }}
                  title={`Copy the ${snippet.label} snippet for ${snippet.rcFile}`}
                  className="flex flex-1 items-center justify-center gap-1 rounded bg-white/[0.06] py-1 text-white/70 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-white"
                >
                  <ClipboardCopy size={12} /> {snippet.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 border-t border-white/10 pt-2">
            <button
              type="button"
              onClick={() => {
                revealLogs().catch((e) => toast.error(`Couldn't open logs folder: ${e}`))
                setOpen(false)
              }}
              className="flex w-full items-start gap-2 rounded px-1 py-1.5 text-left transition-colors duration-fast ease-swift hover:bg-white/5"
            >
              <FolderOpen size={14} className="mt-0.5 shrink-0 text-white/50" />
              <span className="text-white/80">
                Open logs folder
                <span className="block text-white/40">
                  Where session transcripts are saved.
                </span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
