import { Fragment, useEffect, useState } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import type { TerminalSettings } from '../lib/settings'
import {
  PRESET_THEMES,
  copyOfTheme,
  findTheme,
  isHexColor,
  uniqueThemeName,
  PALETTE_ROWS,
  SURFACE_FIELDS,
  type TerminalTheme,
} from '../lib/theme'
import { useConfirm } from './confirmContext'

const fieldClass =
  'rounded border border-chrome/10 bg-black/20 px-1.5 py-1 text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

const buttonClass =
  'flex items-center gap-1.5 rounded-md px-2 py-1 text-chrome/85 transition-colors duration-100 hover:bg-chrome/5'

/**
 * The theme picker, and — when what is picked is one of the user's own — the
 * palette editor for it.
 *
 * Presets are never editable in place. Editing one would have to either fork
 * it silently (leaving two things called "Dracula", only one of which is
 * Dracula) or redefine it for every session that named it; duplicating first
 * makes the fork the explicit step it is. It also keeps Campbell honest,
 * whose whole reason for being in the list is that it matches the Windows
 * console exactly.
 */
export function ThemeEditor({
  settings,
  onChange,
}: {
  settings: TerminalSettings
  onChange: (settings: TerminalSettings) => void
}) {
  const confirm = useConfirm()
  const active = findTheme(settings.themeName)
  const isCustom = settings.customThemes.some((t) => t.name === active.name)

  function replaceActive(next: TerminalTheme) {
    onChange({
      ...settings,
      // The name is part of what is being edited, so the pointer to it moves
      // with it — otherwise renaming the theme you are looking at deselects
      // it and the pane behind the dialog snaps back to the default.
      themeName: next.name,
      customThemes: settings.customThemes.map((t) => (t.name === active.name ? next : t)),
    })
  }

  function duplicate() {
    const copy = copyOfTheme(active, settings.customThemes)
    onChange({
      ...settings,
      themeName: copy.name,
      customThemes: [...settings.customThemes, copy],
    })
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete "${active.name}"?`,
      body: 'This theme is removed for good. Anything still set to it falls back to the default theme.',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    onChange({
      ...settings,
      themeName: PRESET_THEMES[0].name,
      customThemes: settings.customThemes.filter((t) => t.name !== active.name),
    })
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 text-chrome/85">
        <span>Theme</span>
        <select
          className={fieldClass}
          value={settings.themeName}
          onChange={(e) => onChange({ ...settings, themeName: e.target.value })}
        >
          <optgroup label="Built-in">
            {PRESET_THEMES.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </optgroup>
          {settings.customThemes.length > 0 && (
            <optgroup label="Custom">
              {settings.customThemes.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <div className="flex items-center gap-1">
        <button type="button" className={buttonClass} onClick={duplicate}>
          <Copy size={14} className="text-chrome/60" />
          <span>Duplicate &amp; edit</span>
        </button>
        {isCustom && (
          <button type="button" className={buttonClass} onClick={() => void remove()}>
            <Trash2 size={14} className="text-chrome/60" />
            <span>Delete</span>
          </button>
        )}
      </div>

      {isCustom ? (
        <div className="space-y-2 rounded-md border border-chrome/10 p-2">
          <label className="flex items-center justify-between gap-3 text-chrome/85">
            <span>Name</span>
            <ThemeNameField
              theme={active}
              others={[
                ...PRESET_THEMES,
                ...settings.customThemes.filter((t) => t.name !== active.name),
              ]}
              onCommit={(name) => replaceActive({ ...active, name })}
            />
          </label>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1">
            {SURFACE_FIELDS.map(({ label, key }) => (
              <div key={key} className="space-y-1">
                <span className="block text-chrome/60">{label}</span>
                <ColorField
                  label={label}
                  value={active[key]}
                  onChange={(hex) => replaceActive({ ...active, [key]: hex })}
                />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 gap-y-1">
            <span />
            <span className="text-chrome/60">Normal</span>
            <span className="text-chrome/60">Bright</span>
            {PALETTE_ROWS.map(({ label, normal, bright }) => (
              <Fragment key={normal}>
                <span className="text-chrome/85">{label}</span>
                <ColorField
                  label={label}
                  value={active[normal]}
                  onChange={(hex) => replaceActive({ ...active, [normal]: hex })}
                />
                <ColorField
                  label={`Bright ${label.toLowerCase()}`}
                  value={active[bright]}
                  onChange={(hex) => replaceActive({ ...active, [bright]: hex })}
                />
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-chrome/50">
          Built-in themes stay as they are. Duplicate one to get a copy you can change.
        </p>
      )}
    </div>
  )
}

/**
 * The name field, which commits on blur rather than per keystroke.
 *
 * Per keystroke is what every other field in this dialog does, and it is
 * wrong here: the name is the identity. Typing "Mine" would rename the theme
 * once per letter, and each rename has to move `themeName` with it, so the
 * intermediate "M" would be a real theme with a real settings write behind
 * it. Deduplication then compounds it — "M" is taken by the time you get
 * back to it.
 */
function ThemeNameField({
  theme,
  others,
  onCommit,
}: {
  theme: TerminalTheme
  others: readonly TerminalTheme[]
  onCommit: (name: string) => void
}) {
  const [draft, setDraft] = useState(theme.name)
  useEffect(() => setDraft(theme.name), [theme.name])

  function commit() {
    const trimmed = draft.trim()
    // An empty name is not a name, and one that is taken would be a theme the
    // picker lists twice and `findTheme` can only ever resolve to the other
    // one — so it gets a suffix rather than a rejection the user has to read.
    // Both paths put the field back in step with what was stored.
    if (trimmed === '') {
      setDraft(theme.name)
      return
    }
    const settled = uniqueThemeName(trimmed, new Set(others.map((t) => t.name)))
    setDraft(settled)
    if (settled !== theme.name) onCommit(settled)
  }

  return (
    <input
      className={`${fieldClass} w-48`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/**
 * One colour: a swatch that opens the OS picker, and the hex beside it for
 * anyone transcribing a palette from somewhere else.
 *
 * Carries no visible label — which one this is comes from where it sits in
 * the grid — but each input still names itself for a screen reader, since
 * position is not something that survives being read aloud.
 *
 * The text half keeps a draft because a hex is invalid for most of the time
 * it takes to type one — committing per keystroke would repaint every pane
 * with `#f`, then `#f3`, and land on whatever those parsed to. It commits
 * only once the draft is a full six-digit colour, which is also what makes
 * pasting one work.
 */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <span className="flex items-center gap-1.5">
      <input
        type="color"
        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-chrome/10 bg-transparent p-0.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      <input
        className={`${fieldClass} w-full min-w-0 font-mono`}
        value={draft}
        spellCheck={false}
        aria-label={`${label} hex`}
        onChange={(e) => {
          setDraft(e.target.value)
          if (isHexColor(e.target.value)) onChange(e.target.value.toLowerCase())
        }}
        // Whatever is left half-typed is not a colour, so the field goes
        // back to showing the colour that is actually in effect.
        onBlur={() => setDraft(value)}
      />
    </span>
  )
}
