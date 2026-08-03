import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Settings,
  FolderOpen,
  ClipboardCopy,
  SquareTerminal,
  Palette,
  Plug,
  Bell,
  ScrollText,
  Upload,
  Download,
  ShieldCheck,
  X,
} from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { TerminalSettings, CursorStyleSetting } from '../lib/settings'
import { SCROLLBACK_FOOTPRINT_TIERS_MB } from '../lib/settings'
import { scrollbackBudgetBytesFor, estimateScrollbackRows } from '../lib/ghostty/GhosttyEngine'
import { PRESET_THEMES } from '../lib/theme'
import { revealLogs } from '../lib/logging'
import { toast } from '../lib/toast'
import { SHELL_SNIPPETS } from '../lib/shellSnippets'
import { puttySessionCount } from '../lib/profiles'
import { runPuttyImport } from '../lib/puttyBanner'
import { exportVaultBundle, importVaultBundle } from '../lib/vaultTransfer'
import { useConfirm } from './confirmContext'
import { KnownHostsSection } from './KnownHostsSection'
import { useDismissable } from '../hooks/useDismissable'
import type { VaultStatus } from '../lib/vault'

interface Props {
  settings: TerminalSettings
  onChange: (settings: TerminalSettings) => void
  /** Width to quote the scrollback estimates against — the active pane's, so
   * the depth shown is the depth *this* user will get. Omitted (or absent)
   * before anything has connected, which falls back to 80 columns. */
  referenceCols?: number
  /** Sessions were added by an import, so the owner should re-read the saved
   * list — this dialog can trigger one but doesn't own the list. */
  onSessionsImported?: () => void
  /** Gates the bundle actions: exporting needs the vault open, since it has
   * to read the credentials it is about to re-encrypt. */
  vaultStatus?: VaultStatus
  /** A bundle import replaces the vault wholesale, so the owner has to
   * re-read its status — it will be locked afterwards. */
  onVaultChanged?: () => void
}

const SECTIONS = [
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'session', label: 'Session', icon: Plug },
  { id: 'files', label: 'Remote files', icon: FolderOpen },
  { id: 'hostkeys', label: 'Host keys', icon: ShieldCheck },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'shell', label: 'Shell integration', icon: ClipboardCopy },
  { id: 'logging', label: 'Logging', icon: ScrollText },
  { id: 'import', label: 'Backup & import', icon: Upload },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const selectClass =
  'rounded border border-white/10 bg-black/20 px-1.5 py-1 text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

/** Offered as a list rather than a free-text box. The engine measures one
 * glyph and assumes the rest match, so a proportional font renders with visibly
 * wrong column alignment — and a typo'd family name silently falls through
 * to whatever the fallback is, which looks like the setting doing nothing.
 * Each entry ends in a generic fallback so a machine missing the named font
 * still lands on something monospaced. */
const FONT_STACKS = [
  { label: 'System default', value: 'ui-monospace, Consolas, monospace' },
  { label: 'Cascadia Mono', value: '"Cascadia Mono", ui-monospace, monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", ui-monospace, monospace' },
  { label: 'Consolas', value: 'Consolas, ui-monospace, monospace' },
  { label: 'Courier New', value: '"Courier New", monospace' },
  { label: 'Lucida Console', value: '"Lucida Console", ui-monospace, monospace' },
]

/** Width the scrollback estimates are quoted against when no pane has fitted
 *  yet — Settings can be opened before any connection exists. */
const FALLBACK_COLS = 80

/** Rows, rounded to something readable at a glance. The estimate is ±7% at
 *  worst, so digits past the first two would be false precision. */
function formatRows(rows: number): string {
  if (rows >= 10000) return `${Math.round(rows / 1000)}k`
  if (rows >= 1000) return `${(rows / 1000).toFixed(1)}k`
  return String(rows)
}

/** One boolean setting: the control, what it's called, and what it actually
 * does. The explanation is part of the setting rather than a tooltip — half
 * of these have a consequence you can't guess from the name, and a tooltip
 * you have to hover to find is no help when you're scanning for the one you
 * came here to change. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 transition-colors duration-100 hover:bg-white/5">
      <input
        type="checkbox"
        className="mt-0.5 accent-sky-400"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-white/85">
        {label}
        <span className="mt-0.5 block leading-relaxed text-white/40">{hint}</span>
      </span>
    </label>
  )
}

/** Global preferences, one category at a time.
 *
 * A dialog rather than the dropdown this used to be: at a dozen-plus
 * controls the popover was a single scrolling column roughly 250px wide, so
 * every explanation wrapped to three lines and finding a given setting meant
 * reading all of them. The extra width is most of the fix; the categories
 * are what keep it from simply becoming a longer list.
 *
 * Owns its own trigger, like the other toolbar menus (VaultMenu,
 * WorkspaceMenu) — the toolbar stays a row of self-contained buttons rather
 * than App having to hold open-state for one of them. */
export function SettingsDialog({
  settings,
  onChange,
  referenceCols,
  onSessionsImported,
  vaultStatus,
  onVaultChanged,
}: Props) {
  const cols = referenceCols && referenceCols > 0 ? referenceCols : FALLBACK_COLS
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SectionId>('terminal')
  // null while unknown, so the button can say "checking" rather than briefly
  // claiming there is nothing to import.
  const [puttyCount, setPuttyCount] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)

  // Re-checked whenever the section is opened rather than once at mount:
  // PuTTY may have been installed, or sessions added, since the app started,
  // and this is the screen someone opens *because* they want to import.
  useEffect(() => {
    if (!open || section !== 'import') return
    setPuttyCount(null)
    puttySessionCount()
      .then(setPuttyCount)
      .catch(() => setPuttyCount(0))
  }, [open, section])

  async function importPutty() {
    setImporting(true)
    const added = await runPuttyImport()
    setImporting(false)
    // The count deliberately isn't re-read here. It reports what PuTTY's
    // registry holds, not what is left to import, so it doesn't move when we
    // copy sessions out of it — re-reading would just show the same number
    // and imply nothing happened. Running it again is harmless anyway: the
    // import is additive and dedupes on label and host, so a second run says
    // "no new sessions to import" and changes nothing.
    if (added) onSessionsImported?.()
  }

  useDismissable(open, () => setOpen(false))

  // Deliberately not resetting `section` on close: reopening where you left
  // off is right far more often than not, since settings get revisited in
  // bursts — you change a thing, look at it, come back and change it again.

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-white/10 ${
          open ? 'text-white/90' : 'text-white/50 hover:text-white/90'
        }`}
        title="Settings"
      >
        <Settings size={15} strokeWidth={2} />
      </button>
      {open &&
        // Portalled to the body: the trigger lives inside the tab strip, and
        // a fixed-position overlay nested there would be at the mercy of any
        // ancestor picking up a transform (which turns it into the
        // containing block and clips the overlay to the strip's 40px).
        createPortal(
          <div
            className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 duration-150"
            onClick={() => setOpen(false)}
          >
            <div
              // Fixed height, not sized to its contents: the sections differ
              // a lot in length, and a dialog that resized as you moved
              // between them would shift the category list out from under
              // the pointer. Capped against the window so a short one still
              // fits on a small screen.
              className="animate-in zoom-in-95 flex h-[430px] max-h-full w-[660px] max-w-full overflow-hidden rounded-xl border border-white/10 bg-[#1f2028] text-xs shadow-2xl duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-44 shrink-0 overflow-y-auto border-r border-white/10 bg-black/10 py-2">
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setSection(id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 ${
                      section === id
                        ? 'bg-white/10 text-white'
                        : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                    }`}
                  >
                    <Icon size={13} className="shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
                  <span className="font-medium text-white/90">
                    {SECTIONS.find((s) => s.id === section)?.label}
                  </span>
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white"
                    title="Close (Esc)"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {section === 'terminal' && (
                    <>
                      <div className="space-y-3 px-2 py-1.5">
                        <label className="flex items-center justify-between gap-3 text-white/85">
                          <span>Font</span>
                          <select
                            className={selectClass}
                            value={settings.fontFamily}
                            onChange={(e) => onChange({ ...settings, fontFamily: e.target.value })}
                          >
                            {FONT_STACKS.map((f) => (
                              <option key={f.value} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-3 text-white/85">
                          <span>Font size</span>
                          <span className="flex items-center gap-2">
                            <input
                              type="range"
                              min={8}
                              max={24}
                              step={1}
                              className="w-40 accent-sky-400"
                              value={settings.fontSize}
                              onChange={(e) =>
                                onChange({ ...settings, fontSize: Number(e.target.value) })
                              }
                            />
                            <span className="w-8 text-right text-white/50">
                              {settings.fontSize}px
                            </span>
                          </span>
                        </label>
                        <label className="flex items-center justify-between gap-3 text-white/85">
                          <span>Scrollback memory</span>
                          <select
                            className={selectClass}
                            value={settings.scrollbackBudgetMB}
                            onChange={(e) =>
                              onChange({ ...settings, scrollbackBudgetMB: Number(e.target.value) })
                            }
                          >
                            {/* The rows are the point of this control — memory is
                                what's enforced, but nobody chooses a terminal by
                                megabytes. Showing the depth each tier buys at the
                                current pane's width is what makes the unit
                                usable, so it belongs in the option itself rather
                                than in the note below. */}
                            {SCROLLBACK_FOOTPRINT_TIERS_MB.map((mb) => (
                              <option key={mb} value={mb}>
                                {`${mb} MB — ~${formatRows(
                                  estimateScrollbackRows(scrollbackBudgetBytesFor(mb), cols),
                                )} rows`}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-3 text-white/85">
                          <span>Cursor</span>
                          <select
                            className={selectClass}
                            value={settings.cursorStyle}
                            onChange={(e) =>
                              onChange({
                                ...settings,
                                cursorStyle: e.target.value as CursorStyleSetting,
                              })
                            }
                          >
                            <option value="block">Block</option>
                            <option value="bar">Bar</option>
                            <option value="underline">Underline</option>
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-3 text-white/85">
                          <span>Blink cursor</span>
                          <input
                            type="checkbox"
                            className="accent-sky-400"
                            checked={settings.cursorBlink}
                            onChange={(e) =>
                              onChange({ ...settings, cursorBlink: e.target.checked })
                            }
                          />
                        </label>
                        <p className="leading-relaxed text-white/30">
                          Font changes apply to open sessions immediately. Scrollback is set
                          as memory per pane because memory is what's actually reserved; the
                          row estimates are for a {cols}-column pane and counted in wrapped
                          rows, so a wider pane or long lines reach the same limit sooner. It
                          applies to panes opened afterwards. The cursor setting is a starting
                          point — a program that picks its own cursor, as vim and many TUIs
                          do, overrides it.
                        </p>
                      </div>
                      <Toggle
                        checked={settings.copyOnSelect}
                        onChange={(v) => onChange({ ...settings, copyOnSelect: v })}
                        label="Copy on select"
                        hint="Selecting text in the terminal copies it automatically. Ctrl+Shift+C copies the selection either way, and Ctrl+Shift+M selects with the keyboard."
                      />
                      <Toggle
                        checked={settings.rightClickPaste}
                        onChange={(v) => onChange({ ...settings, rightClickPaste: v })}
                        label="Right-click to paste"
                        hint="PuTTY-style: right mouse button pastes the clipboard."
                      />
                      <Toggle
                        checked={settings.clipboardWriteFromRemote}
                        onChange={(v) => onChange({ ...settings, clipboardWriteFromRemote: v })}
                        label="Remote hosts can set your clipboard"
                        hint="Programs on the remote host can put text on your clipboard (OSC 52), and you'll see a notice when they do. Reading it is never allowed. Turn this off if you don't want a remote host able to change what you paste."
                      />
                    </>
                  )}

                  {section === 'appearance' && (
                    <div className="space-y-4 px-2 py-1.5">
                      <label className="flex items-center justify-between gap-3 text-white/85">
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
                      <div>
                        <label className="flex items-center justify-between gap-2 text-white/85">
                          <span>Background opacity</span>
                          <span className="text-white/50">
                            {Math.round(settings.backgroundOpacity * 100)}%
                          </span>
                        </label>
                        <input
                          type="range"
                          min={40}
                          max={100}
                          step={5}
                          className="mt-1.5 w-full accent-sky-400"
                          value={Math.round(settings.backgroundOpacity * 100)}
                          onChange={(e) =>
                            onChange({
                              ...settings,
                              backgroundOpacity: Number(e.target.value) / 100,
                            })
                          }
                        />
                      </div>
                      <div>
                        <span className="text-white/85">Window effect</span>
                        <div className="mt-1.5 flex gap-1 rounded-md bg-black/20 p-1">
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
                        <p className="mt-1.5 leading-relaxed text-white/40">
                          {settings.vibrancyMode === 'acrylic'
                            ? 'Live blur-behind, at opacity below 100% — Windows has a documented lag bug on some builds while resizing/dragging.'
                            : settings.vibrancyMode === 'mica'
                              ? "A one-time wallpaper-color tint, not a live blur — won't show desktop content moving behind the window."
                              : settings.vibrancyMode === 'tabbed'
                                ? 'Same one-time tint as Mica, tuned for windows with a tab strip — no live blur either. Windows 11 only.'
                                : 'Opacity below 100% still applies as plain unblurred glass, with no OS effect layered under it.'}
                        </p>
                      </div>
                    </div>
                  )}

                  {section === 'session' && (
                    <>
                      <Toggle
                        checked={settings.closeOnDisconnect}
                        onChange={(v) => onChange({ ...settings, closeOnDisconnect: v })}
                        label="Close pane on disconnect"
                        hint="When a connection is lost, close the pane automatically instead of showing Reconnect actions."
                      />
                      <Toggle
                        checked={settings.confirmCloseWithConnection}
                        onChange={(v) => onChange({ ...settings, confirmCloseWithConnection: v })}
                        label="Confirm before closing a live connection"
                        hint="Asks first when closing a pane, tab or the window would drop a session that's still connected. Panes still on their connect form close without asking."
                      />
                      <Toggle
                        checked={settings.restoreSessionsOnLaunch}
                        onChange={(v) => onChange({ ...settings, restoreSessionsOnLaunch: v })}
                        label="Restore sessions on launch"
                        hint="Offers to reopen open tabs next time you start wRusTTY."
                      />
                    </>
                  )}

                  {section === 'files' && (
                    <div className="space-y-3 px-2 py-1.5">
                      <label className="flex flex-col gap-1.5 text-white/85">
                        <span>Open remote files with</span>
                        <input
                          type="text"
                          spellCheck={false}
                          placeholder="Windows default (leave empty)"
                          className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 font-mono text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
                          value={settings.externalEditor}
                          onChange={(e) => onChange({ ...settings, externalEditor: e.target.value })}
                        />
                      </label>
                      <p className="leading-relaxed text-white/50">
                        Empty opens the file in whatever Windows uses for its type. That
                        works with no setup, but nothing can tell when you have finished
                        with it — the editor usually hands the file to a copy of itself
                        that is already running and returns at once — so the panel's
                        “watching” marker has to be dismissed by hand.
                      </p>
                      <p className="leading-relaxed text-white/50">
                        A command that <em>waits</em> fixes that: wRusTTY knows when you
                        close the file, uploads the last save, and stops watching on its
                        own. The wait flag is the whole point — without it the command
                        returns immediately and nothing is gained.
                      </p>
                      <div className="space-y-1 font-mono text-white/40">
                        <div>code --wait</div>
                        <div>"C:\Program Files\Sublime Text\subl.exe" --wait</div>
                        <div>gvim -f</div>
                      </div>
                      <p className="leading-relaxed text-white/30">
                        The file path is added at the end, or put <code>{'{file}'}</code>{' '}
                        where you need it. Quote a program path containing spaces;
                        backslashes are literal.
                      </p>
                    </div>
                  )}

                  {section === 'hostkeys' && <KnownHostsSection />}

                  {section === 'notifications' && (
                    <>
                      <Toggle
                        checked={settings.notifyOnCommandComplete}
                        onChange={(v) => onChange({ ...settings, notifyOnCommandComplete: v })}
                        label="Notify on command completion"
                        hint="For long commands finishing in a tab you aren't looking at. Needs shell integration set up on the remote host — see the next section."
                      />
                      <Toggle
                        checked={settings.bellMarksTab}
                        onChange={(v) => onChange({ ...settings, bellMarksTab: v })}
                        label="Bell marks the pane"
                        hint="A bell from the far end flags its pane in the tab strip until you focus it. Needs no setup on the host."
                      />
                      <Toggle
                        checked={settings.remoteNotifications}
                        onChange={(v) => onChange({ ...settings, remoteNotifications: v })}
                        label="Programs may raise notifications"
                        hint="A program on the far end can ask for a notification by name (OSC 9 / OSC 777) and choose its text. Works inside full-screen programs, where shell integration can't. Always shown under the pane's name, and the text it chose is shown only in the app — never on the lock screen."
                      />
                      <Toggle
                        checked={settings.bellSound}
                        onChange={(v) => onChange({ ...settings, bellSound: v })}
                        label="Bell plays a sound"
                        hint="A short tone on every bell, including from the pane you're watching. Off by default — some shells ring the bell on every ambiguous tab-completion."
                      />
                    </>
                  )}

                  {section === 'shell' && (
                    <div className="space-y-3 px-2 py-1.5">
                      <p className="leading-relaxed text-white/50">
                        Append the snippet to the rc file on a host once and every session
                        there reports when its commands start and finish — to any terminal
                        that speaks OSC 133, not just wRusTTY. It emits nothing in
                        non-interactive shells, so scp and rsync are unaffected.
                      </p>
                      <div className="flex gap-1.5">
                        {SHELL_SNIPPETS.map((snippet) => (
                          <button
                            key={snippet.id}
                            type="button"
                            onClick={() => {
                              writeText(snippet.script)
                                .then(() =>
                                  toast.success(
                                    `${snippet.label} snippet copied — paste into ${snippet.rcFile}`,
                                  ),
                                )
                                .catch((e) => toast.error(`Couldn't copy to clipboard: ${e}`))
                            }}
                            title={`Copy the ${snippet.label} snippet for ${snippet.rcFile}`}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-white/[0.06] py-1.5 text-white/70 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-white"
                          >
                            <ClipboardCopy size={12} /> {snippet.label}
                          </button>
                        ))}
                      </div>
                      <p className="leading-relaxed text-white/30">
                        Install notes and caveats — including what to do if your shell
                        already has an integration — are in docs/SHELL_INTEGRATION.md.
                      </p>
                    </div>
                  )}

                  {section === 'logging' && (
                    <>
                      <Toggle
                        checked={settings.logPlainText}
                        onChange={(v) => onChange({ ...settings, logPlainText: v })}
                        label="Plain-text session logs"
                        hint="Strip color/escape codes so logs read as text. Off keeps the raw stream. Applies to the next log started, not one already running."
                      />
                      <button
                        type="button"
                        onClick={() =>
                          revealLogs().catch((e) => toast.error(`Couldn't open logs folder: ${e}`))
                        }
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-white/5"
                      >
                        <FolderOpen size={14} className="mt-0.5 shrink-0 text-white/50" />
                        <span className="text-white/85">
                          Open logs folder
                          <span className="mt-0.5 block text-white/40">
                            Where session transcripts are saved.
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                  {section === 'import' && (
                    <>
                      <div className="px-2 py-1.5">
                        <p className="text-white/40">
                          Your saved credentials, sessions and workspaces move as one bundle —
                          each is meaningless without the others, so a backup carries all three.
                          Only the credentials are encrypted.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={vaultStatus !== 'unlocked'}
                        onClick={() => void exportVaultBundle(confirm)}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <Download size={14} className="mt-0.5 shrink-0 text-white/50" />
                        <span className="text-white/85">
                          Export a backup…
                          <span className="mt-0.5 block text-white/40">
                            {vaultStatus === 'unlocked'
                              ? 'Vault, saved sessions and workspaces, in one file.'
                              : // Not a limitation worth hiding: an export has to
                                // read the credentials it re-encrypts, so it
                                // genuinely cannot run against a locked vault.
                                'Unlock the vault first — an export has to read the credentials it protects.'}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (await importVaultBundle(confirm)) {
                            onVaultChanged?.()
                            onSessionsImported?.()
                          }
                        }}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-white/5"
                      >
                        <Upload size={14} className="mt-0.5 shrink-0 text-white/50" />
                        <span className="text-white/85">
                          Restore from a backup…
                          <span className="mt-0.5 block text-white/40">
                            Replaces everything currently saved. You will need the backup&apos;s
                            own master password.
                          </span>
                        </span>
                      </button>

                      <div className="mt-2 border-t border-white/10 px-2 pb-1.5 pt-3">
                        <p className="text-white/40">
                          Migrating from another client. Additive — a session already saved here
                          with the same name and host is left exactly as it is, so running one
                          twice is harmless.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={importing || puttyCount === 0}
                        onClick={importPutty}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <Upload size={14} className="mt-0.5 shrink-0 text-white/50" />
                        <span className="text-white/85">
                          {importing ? 'Importing…' : 'Import from PuTTY'}
                          <span className="mt-0.5 block text-white/40">
                            {puttyCount === null
                              ? 'Checking for saved PuTTY sessions…'
                              : puttyCount === 0
                                ? 'No saved PuTTY sessions found on this machine.'
                                : `${puttyCount} saved ${puttyCount === 1 ? 'session' : 'sessions'} found. Passwords aren't imported — PuTTY doesn't store them.`}
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
