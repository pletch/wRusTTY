import { useEffect, useState, type CSSProperties } from 'react'
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
  History,
  Upload,
  Download,
  ShieldCheck,
  Info,
  Keyboard,
  X,
} from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type {
  TerminalSettings,
  CursorStyleSetting,
  FontRange,
  ProxyKindSetting,
} from '../lib/settings'
import { bindingsFor } from '../lib/keybindings'
import { KeybindingsEditor } from './KeybindingsEditor'
import {
  DEFAULT_PROXY_PORT,
  SCROLLBACK_FOOTPRINT_TIERS_MB,
  FONT_STACKS,
  FONT_SIZE_RANGE,
  FONT_WEIGHT_RANGE,
  LINE_HEIGHT_PERCENT_RANGE,
  LETTER_SPACING_RANGE,
  UNFOCUSED_DIM_RANGE,
  UNFOCUSED_DIM_STEP,
  UNFOCUSED_OPACITY_RANGE,
  UNFOCUSED_OPACITY_STEP,
} from '../lib/settings'
import { listInstalledFonts, stackFor, type InstalledFont } from '../lib/fonts'
import {
  bundledDefaultFeatures,
  bundledFaces,
  bundledLacksItalic,
  ensureBundledLoaded,
} from '../lib/bundledFonts'
import {
  descriptorIsValid,
  formatCodepoint,
  ligatureConflict,
  parseCodepoint,
  resolveRangeOverlaps,
  sameRanges,
} from '../lib/fontStack'
import { scrollbackBudgetBytesFor, estimateScrollbackRows } from '../lib/ghostty/GhosttyEngine'
import { APP_VERSION } from '../lib/version'
import { GHOSTTY_PIN, GHOSTTY_COMMIT_SHORT } from '../lib/ghostty/vendorPin'
import { revealLogs } from '../lib/logging'
import { toast } from '../lib/toast'
import { SHELL_SNIPPETS } from '../lib/shellSnippets'
import { puttySessionCount, sshConfigSessionCount } from '../lib/profiles'
import { runPuttyImport, runSshConfigImport } from '../lib/sessionImport'
import { exportVaultBundle, importVaultBundle } from '../lib/vaultTransfer'
import { useConfirm } from './confirmContext'
import { KnownHostsSection } from './KnownHostsSection'
import { ThemeEditor } from './ThemeEditor'
import { CommandHistorySection } from './CommandHistorySection'
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
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'session', label: 'Session', icon: Plug },
  { id: 'files', label: 'Remote files', icon: FolderOpen },
  { id: 'hostkeys', label: 'Host keys', icon: ShieldCheck },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'autocomplete', label: 'Autocomplete', icon: History },
  { id: 'shell', label: 'Shell integration', icon: ClipboardCopy },
  { id: 'logging', label: 'Logging', icon: ScrollText },
  { id: 'import', label: 'Backup & import', icon: Upload },
  { id: 'about', label: 'About', icon: Info },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const selectClass =
  'rounded border border-chrome/10 bg-black/20 px-1.5 py-1 text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'

/**
 * What the font select offers: the curated stacks, then whatever monospaced
 * families this machine actually has, then the current setting if it is
 * neither.
 *
 * That last group is what keeps the control honest. A controlled select whose
 * value matches no option displays nothing at all, which reads as the font
 * setting having been lost — so a stack carried over from a version that
 * offered a different set, or one this machine cannot enumerate, is shown as
 * its own entry rather than silently disappearing.
 *
 * Installed families are offered wrapped in the same symbol tier the curated
 * stacks carry, and the ones a curated stack already names are dropped so the
 * list does not say Consolas twice. That covers the bundled families too: a
 * machine that also has JetBrains Mono installed should offer it once, and the
 * bundled entry is the one that resolves either way.
 */
function fontOptions(current: string, installed: InstalledFont[] | null) {
  const curatedNames = new Set(FONT_STACKS.map((f) => familyName(f.value).toLowerCase()))
  const installedStacks = (installed ?? [])
    .filter((f) => f.monospace && !curatedNames.has(f.name.toLowerCase()))
    .map((f) => ({ label: f.name, value: stackFor(f.name) }))
  const known = [...FONT_STACKS, ...installedStacks]
  return {
    curated: FONT_STACKS.filter((f) => !f.bundled),
    // Grouped separately because the distinction is worth stating: these need
    // nothing from the machine, so they are the entries that look the same on
    // every install.
    bundled: FONT_STACKS.filter((f) => f.bundled),
    installed: installedStacks,
    extra: known.some((f) => f.value === current)
      ? null
      : { label: familyName(current), value: current },
  }
}

/** The first family in a CSS list, unquoted — what to call a stack in prose. */
function familyName(stack: string): string {
  const named = stack.match(/"([^"]+)"|^([^,]+)/)
  return (named?.[1] ?? named?.[2] ?? stack).trim()
}

/** Families the browser always answers yes for, because it resolves them
 *  itself rather than looking for an installed face by that name. Asking
 *  about one tells you nothing, so the report below stops before it. */
const GENERIC_FAMILIES = new Set([
  'monospace', 'serif', 'sans-serif', 'cursive', 'fantasy', 'system-ui',
  'ui-monospace', 'ui-serif', 'ui-sans-serif', 'ui-rounded', 'math', 'emoji', 'fangsong',
])

/**
 * Which face in a stack the browser will actually use, and which named ones
 * ahead of it are not installed.
 *
 * The stack is the only control over fallback this renderer has — Canvas 2D
 * picks per glyph and never says what it picked — so without this a machine
 * missing the named font renders in something else forever with no indication,
 * which reads as the setting doing nothing. `document.fonts.check` answers for
 * the whole webview and is available in WebView2.
 *
 * Returns null if nothing can be determined, which is the honest answer when
 * the API is missing rather than a guess dressed up as a report.
 */
function resolveFace(stack: string): { using: string; missing: string[] } | null {
  const families = stack.split(',').map((f) => f.trim()).filter(Boolean)
  const missing: string[] = []
  for (const family of families) {
    const bare = family.replace(/^["']|["']$/g, '')
    if (GENERIC_FAMILIES.has(bare.toLowerCase())) return { using: bare, missing }
    const present = hasFamily(bare)
    // Nothing can be determined, so nothing is claimed — see below.
    if (present === null) return null
    if (present) return { using: bare, missing }
    missing.push(bare)
  }
  return null
}

/**
 * Whether this machine has a face by this name, or null when the webview
 * cannot say — the API being missing is not the same answer as the font being
 * missing, and only one of the two is worth telling someone about.
 */
function hasFamily(bare: string): boolean | null {
  // A family that ships in the app is present by construction, and asking is
  // actively misleading: `check` answers "can this be drawn *right now*", and
  // a declared face that has not been fetched yet reads there as absent. That
  // is the difference between a font this machine does not have and a font
  // whose bytes are still on their way, and only the first is worth a warning.
  if (bundledFaces(bare)) return true
  if (typeof document === 'undefined' || !document.fonts?.check) return null
  try {
    // Quoted so a family with spaces parses as one name rather than as an
    // invalid shorthand, which `check` reports by throwing.
    return document.fonts.check(`16px "${bare.replace(/"/g, '')}"`)
  } catch {
    return null
  }
}

/** Width the scrollback estimates are quoted against when no pane has fitted
 *  yet — Settings can be opened before any connection exists. */
const FALLBACK_COLS = 80

/** What About shows, and what its copy button puts on the clipboard — one
 *  definition so the two can't say different things. Ordered as it reads: what
 *  you are running first, then what identifies the engine build.
 *
 *  The engine facts are not read off the running wasm, because it doesn't
 *  publish them — it exports no version symbol, and the `XTVERSION` reply is
 *  ours rather than its. They come from `vendorPin.ts`, which
 *  `vendorIntegrity.test.ts` checks against the bytes on every run, so what
 *  this shows is verified rather than merely recorded. */
const ABOUT_FACTS: ReadonlyArray<readonly [string, string]> = [
  ['wRusTTY', APP_VERSION],
  ['Engine', `ghostty ${GHOSTTY_PIN.upstream} @ ${GHOSTTY_COMMIT_SHORT}`],
  ['Patched with', GHOSTTY_PIN.patch],
  ['Engine SHA-256', GHOSTTY_PIN.sha256],
  ['Engine size', `${GHOSTTY_PIN.bytes.toLocaleString('en-US')} bytes`],
  ['Built with', `Zig ${GHOSTTY_PIN.zig}`],
  ['Build flags', GHOSTTY_PIN.buildFlags],
]

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
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 transition-colors duration-100 hover:bg-chrome/5">
      <input
        type="checkbox"
        className="mt-0.5 accent-sky-400"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-chrome/85">
        {label}
        <span className="mt-0.5 block leading-relaxed text-chrome/40">{hint}</span>
      </span>
    </label>
  )
}

/** What the font stack above actually resolved to on this machine. Rendered as
 * part of the setting rather than left to be discovered: the stack is a list of
 * hopes, and which of them came true is the single most useful thing to know
 * when the terminal is not drawing what you picked. */
function FontResolution({
  stack,
  installed,
  italicFace,
}: {
  stack: string
  installed: InstalledFont[] | null
  /** The configured italic slot, only so the note below can stop saying
   *  anything once it has been filled in. */
  italicFace: string
}) {
  const resolved = resolveFace(stack)
  const wanted = familyName(stack)
  // Settings can be open with no pane on screen, and a pane is otherwise the
  // only thing that asks for a font. Without this, picking a bundled family
  // here would declare interest in it and fetch nothing.
  useEffect(() => {
    ensureBundledLoaded(wanted)
  }, [wanted])
  // Said here rather than left to be discovered, for the same reason the rest
  // of this component exists: Fira Code ships uprights only, which is its
  // authors' decision and not something wrong with this install, but italic
  // text coming out unslanted reads exactly like a bug in the renderer.
  const noItalic = bundledLacksItalic(wanted) && !italicFace.trim() ? (
    <p className="px-0.5 leading-relaxed text-chrome/30">
      {wanted} has no italic face — italic text renders without a true italic until you
      name one under Faces below.
    </p>
  ) : null
  // Only ever said of a family we enumerated and were told is proportional —
  // never inferred from a name, and never guessed when enumeration is
  // unavailable. The engine measures one glyph and assumes the rest match, so
  // this comes out as visibly wrong column alignment rather than as anything
  // that looks like a font problem.
  const proportional = installed?.some(
    (f) => f.name.toLowerCase() === wanted.toLowerCase() && !f.monospace,
  )
  if (proportional) {
    return (
      <p className="px-0.5 leading-relaxed text-amber-300/50">
        {wanted} is not a fixed-width font — columns will not line up.
      </p>
    )
  }
  if (!resolved) return noItalic
  return (
    <>
      {resolved.missing.length === 0 ? (
        <p className="px-0.5 leading-relaxed text-chrome/30">Rendering in {resolved.using}.</p>
      ) : (
        <p className="px-0.5 leading-relaxed text-amber-300/50">
          {resolved.missing.length === 1 ? `${wanted} is` : `${resolved.missing.join(', ')} are`}{' '}
          not installed — falling back to {resolved.using}.
        </p>
      )}
      {noItalic}
    </>
  )
}

/** Every family this machine has, deduplicated and sorted — including the
 *  proportional ones, because a symbol font pinned to the private use area is
 *  the main thing ranges are for and those rarely report as monospaced. */
function familyChoices(installed: InstalledFont[] | null): string[] {
  return [...new Set((installed ?? []).map((f) => f.name))].sort((a, b) => a.localeCompare(b))
}

/**
 * A picker for one installed family, where empty means "not set".
 *
 * The value stored is the family name quoted, so it can be dropped into a CSS
 * font shorthand as-is — an unquoted name with a comma or a leading digit in
 * it would otherwise end the family list early or fail to parse.
 *
 * It becomes a text field when nothing could be enumerated, which is the
 * whole story off Windows: `list_fonts` answers natively through DirectWrite
 * and returns an empty list everywhere else. A select over an empty list is
 * not a degraded picker, it is a control that cannot express anything — so
 * where there is nothing to offer, the name gets typed instead. The setting,
 * what it stores, and everything downstream of it are identical either way.
 */
export function FamilySelect({
  value,
  onPick,
  families,
  emptyLabel,
  className,
}: {
  value: string
  onPick: (value: string) => void
  families: string[]
  emptyLabel: string
  className?: string
}) {
  // A stored value naming a family this machine cannot enumerate still has to
  // show, for the same reason the body font select keeps its own odd one out:
  // a controlled select with no matching option renders blank, which reads as
  // the setting having been lost.
  const known = families.some((f) => JSON.stringify(f) === value)
  if (families.length === 0) {
    return (
      <input
        type="text"
        spellCheck={false}
        aria-label={emptyLabel}
        placeholder={emptyLabel}
        className={`${selectClass} ${className ?? ''}`}
        // Quoted on the way in and unquoted on the way out, so what is stored
        // is what the select would have stored: this is a different way to say
        // the same thing, not a different setting.
        value={value === '' ? '' : familyName(value)}
        onChange={(e) => onPick(e.target.value.trim() === '' ? '' : JSON.stringify(e.target.value))}
      />
    )
  }
  return (
    <select
      className={`${selectClass} ${className ?? ''}`}
      value={value}
      onChange={(e) => onPick(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {!known && value !== '' && <option value={value}>{familyName(value)}</option>}
      {families.map((f) => (
        <option key={f} value={JSON.stringify(f)}>
          {f}
        </option>
      ))}
    </select>
  )
}

/**
 * The range table, edited as text and committed as numbers.
 *
 * The drafts are strings rather than the parsed settings themselves because a
 * range is typed one character at a time: `U+E0` is not a range anyone meant,
 * and a control that dropped the row the moment it stopped parsing would take
 * the cursor with it. So a row exists here as soon as it is added, and reaches
 * the settings only once it is a range — which is also why a half-typed row
 * simply has no effect rather than an alarming one.
 *
 * Seeded from the settings once. Nothing else writes ranges while this dialog
 * is open, and re-seeding from a prop this component is itself the source of
 * would fight the person typing.
 */
function FontRangeTable({
  ranges,
  onChange,
  families,
}: {
  ranges: FontRange[]
  onChange: (ranges: FontRange[]) => void
  families: string[]
}) {
  const [rows, setRows] = useState(() =>
    ranges.map((r) => ({
      lo: formatCodepoint(r.lo),
      hi: formatCodepoint(r.hi),
      family: r.family,
    })),
  )
  /** Rows that parse but are not applied, because an earlier range already
   *  claims part of what they cover. Empty to start with: what seeds the table
   *  came through the same rule on the way out of storage. */
  const [overlapping, setOverlapping] = useState<ReadonlySet<number>>(() => new Set())

  function commit(next: typeof rows) {
    setRows(next)
    const valid: FontRange[] = []
    // Which row each valid entry came from, so an ignored one can be pointed
    // at in the table rather than only counted.
    const sourceRow: number[] = []
    for (let i = 0; i < next.length; i++) {
      const row = next[i]
      const lo = parseCodepoint(row.lo)
      const hi = parseCodepoint(row.hi)
      if (lo === null || hi === null || hi < lo || row.family === '') continue
      valid.push({ lo, hi, family: row.family })
      sourceRow.push(i)
    }
    // The same rule the loader applies, so what this table says is applied is
    // what is applied — a dialog that showed a range the atlas would never
    // consult would be worse than one that showed nothing.
    const { kept, ignored } = resolveRangeOverlaps(valid)
    setOverlapping(new Set(ignored.map((i) => sourceRow[i])))
    // Only when the applied table actually differs. Every keystroke lands
    // here, and handing back an equal-but-new array would still count as a
    // font change downstream -- which throws away the atlas and re-fits the
    // grid of every open pane, once per character typed.
    if (!sameRanges(kept, ranges)) onChange(kept)
  }

  function edit(index: number, patch: Partial<(typeof rows)[number]>) {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  // One border-colour utility, never two. Tailwind settles a conflict by where
  // the rules land in the stylesheet, not by the order the classes appear in
  // the attribute, so appending an amber border to a list already carrying the
  // white one is a coin toss — and it lands on white, which is how this shipped
  // marking nothing at all.
  const fieldBase =
    'w-20 rounded border bg-black/20 px-1.5 py-1 text-center font-mono text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50'
  const fieldClass = (flagged: boolean) =>
    `${fieldBase} ${flagged ? 'border-amber-300/50' : 'border-chrome/10'}`
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-chrome/85">
        <span>Ranges</span>
        <button
          className="rounded border border-chrome/10 px-1.5 py-1 text-chrome/70 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome"
          onClick={() => commit([...rows, { lo: '', hi: '', family: '' }])}
        >
          Add range
        </button>
      </div>
      {rows.map((row, i) => {
        const lo = parseCodepoint(row.lo)
        const hi = parseCodepoint(row.hi)
        // Amber rather than red, and only once something is typed: an empty
        // row is a row you just added, not a mistake you made.
        const bad = (text: string, cp: number | null) => text.trim() !== '' && cp === null
        const inverted = lo !== null && hi !== null && hi < lo
        const ignored = overlapping.has(i)
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              spellCheck={false}
              placeholder="U+E000"
              aria-label="First codepoint"
              className={fieldClass(bad(row.lo, lo) || ignored)}
              value={row.lo}
              onChange={(e) => edit(i, { lo: e.target.value })}
            />
            <span className="text-chrome/30">–</span>
            <input
              type="text"
              spellCheck={false}
              placeholder="U+F8FF"
              aria-label="Last codepoint"
              className={fieldClass(bad(row.hi, hi) || inverted || ignored)}
              value={row.hi}
              onChange={(e) => edit(i, { hi: e.target.value })}
            />
            <FamilySelect
              value={row.family}
              onPick={(family) => edit(i, { family })}
              families={families}
              emptyLabel="Pick a font"
              className="min-w-0 flex-1"
            />
            <button
              aria-label="Remove range"
              title="Remove range"
              className="rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome"
              onClick={() => commit(rows.filter((_, j) => j !== i))}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )
      })}
      {overlapping.size > 0 && (
        <p className="px-0.5 leading-relaxed text-amber-300/50">
          {overlapping.size === 1 ? 'A range overlaps' : 'Some ranges overlap'} another and{' '}
          {overlapping.size === 1 ? 'is' : 'are'} ignored — where two ranges claim the same
          character, only the one starting earlier applies.
        </p>
      )}
    </div>
  )
}

/** A labelled slider with its value beside it — the shape the font size
 *  control already had, now that weight and the two cell metrics want it too. */
/**
 * A range slider whose track this app paints (see `.range` in index.css).
 *
 * Exists because painting the track means the fill to the left of the thumb
 * has to be worked out here — `accent-color` used to do it, and taking the
 * track over to get it onto the theme gave that up with it. The percentage
 * goes to CSS as a custom property rather than into a computed gradient
 * string, so the colours stay in the stylesheet with the rest of them.
 */
function RangeInput({
  min,
  max,
  step = 1,
  value,
  onChange,
  className = '',
  'aria-label': ariaLabel,
}: {
  min: number
  max: number
  step?: number
  value: number
  onChange: (value: number) => void
  className?: string
  'aria-label'?: string
}) {
  // Guarding the degenerate range rather than dividing by it: a slider whose
  // bounds are equal has no position to be in, and NaN% is a track that
  // paints nothing at all.
  const filled = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`range ${className}`}
      style={{ '--range-fill': `${Math.min(100, Math.max(0, filled))}%` } as CSSProperties}
    />
  )
}

function SliderRow({
  label,
  value,
  onChange,
  range,
  step = 1,
  format,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  range: { min: number; max: number }
  step?: number
  format: (value: number) => string
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-chrome/85">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <RangeInput
          min={range.min}
          max={range.max}
          step={step}
          className="w-32"
          value={value}
          onChange={onChange}
          aria-label={label}
        />
        <span className="w-10 text-right text-chrome/50">{format(value)}</span>
      </span>
    </label>
  )
}

/**
 * Says when a descriptor string does not parse, because nothing else will.
 *
 * There is no error to surface here and no exception to catch: the browser
 * takes a descriptor it cannot read, discards it, and reports `normal`. The
 * font then renders as though the setting were empty, which from the outside
 * is indistinguishable from the font not having the feature — so the natural
 * conclusion is that the face lacks it, and the typo goes unfound.
 *
 * Worth saying loudly because the discard is all or nothing: one bad tag in a
 * list takes the working ones with it.
 */
export function DescriptorNote({ property, value }: { property: string; value: string }) {
  if (descriptorIsValid(property, value) !== false) return null
  return (
    <p className="px-0.5 leading-relaxed text-amber-300/50">
      Not a valid <code className="text-amber-300/70">{property}</code> value, so all of it is
      being ignored — one mistyped tag discards the working ones alongside it.
    </p>
  )
}

/**
 * What the OpenType features and the ligature toggle are doing to each other.
 *
 * Neither is wrong when they disagree — each is a different level of the same
 * pipeline doing as it was told — but the visible result is that one of the
 * two controls appears to do nothing, and there is no way to tell from either
 * one alone which one that is.
 */
function LigatureConflictNote({ settings }: { settings: TerminalSettings }) {
  const conflict = ligatureConflict(settings.fontFeatures, settings.ligatures)
  if (!conflict) return null
  return (
    <p className="px-0.5 leading-relaxed text-amber-300/50">
      {conflict === 'features-win'
        ? 'A feature above switches ligatures off in the face itself, so they will not appear even with the Ligatures setting on.'
        : 'A feature above asks for ligatures, but the Ligatures setting is off — operators are drawn one cell at a time, so the face never gets a run to substitute in.'}
    </p>
  )
}

/**
 * The faces named above that this machine does not have.
 *
 * The same argument as `FontResolution`, carried to the slots that name one
 * family rather than a stack: a missing face is not an error anywhere, it is
 * text quietly rendering in something else. It is worse here, though. The body
 * stack has fallbacks written into it and can say which one it landed on;
 * these are a single family, so a name nothing answers to leaves the rasterizer
 * on whatever it defaults to — not the body font, which is what anyone would
 * assume happened.
 *
 * Ranges are checked alongside the styled slots because the range picker only
 * offers installed families, so a missing one arrives from a settings file
 * written on another machine — exactly the case nobody would think to check.
 */
export function NamedFaceReport({
  settings,
}: {
  settings: TerminalSettings
}) {
  const named = [
    settings.fontFamilyBold,
    settings.fontFamilyItalic,
    settings.fontFamilyBoldItalic,
    ...settings.fontRanges.map((r) => r.family),
  ]
    .filter((f) => f !== '')
    .map(familyName)
  // `false` only: null is the webview declining to answer, and a warning built
  // on that would be a guess dressed up as a report.
  const missing = [...new Set(named)].filter((f) => hasFamily(f) === false)
  if (missing.length === 0) return null
  return (
    <p className="px-0.5 leading-relaxed text-amber-300/50">
      {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not installed — the text
      pinned to {missing.length === 1 ? 'it' : 'them'} falls back to the webview's default
      face rather than to your body font.
    </p>
  )
}

/**
 * The font settings behind a disclosure: a face per style, OpenType features,
 * and families pinned to codepoint ranges.
 *
 * Folded away rather than listed with the rest, because the Terminal section
 * is where people come for font size and cursor shape. These only start to
 * matter once you have a font you care about, and two of them are typed rather
 * than picked.
 */
function AdvancedFontSettings({
  settings,
  onChange,
  installed,
}: {
  settings: TerminalSettings
  onChange: (settings: TerminalSettings) => void
  installed: InstalledFont[] | null
}) {
  const families = familyChoices(installed)
  const defaultFeatures = bundledDefaultFeatures(familyName(settings.fontFamily))
  return (
    <details className="rounded-md border border-chrome/5 bg-black/10">
      <summary className="cursor-pointer px-2 py-1.5 text-chrome/55 transition-colors duration-100 hover:text-chrome/85">
        Faces, weight, spacing and ranges
      </summary>
      <div className="space-y-2.5 px-2 pt-1 pb-2.5">
        {(
          [
            ['Bold', 'fontFamilyBold'],
            ['Italic', 'fontFamilyItalic'],
            ['Bold italic', 'fontFamilyBoldItalic'],
          ] as const
        ).map(([label, key]) => (
          <label key={key} className="flex items-center justify-between gap-3 text-chrome/85">
            <span>{label}</span>
            <FamilySelect
              value={settings[key]}
              onPick={(value) => onChange({ ...settings, [key]: value })}
              families={families}
              emptyLabel="Body font"
              className="min-w-0 max-w-52"
            />
          </label>
        ))}
        <SliderRow
          label="Weight"
          value={settings.fontWeight}
          onChange={(fontWeight) => onChange({ ...settings, fontWeight })}
          range={FONT_WEIGHT_RANGE}
          step={100}
          format={(v) => String(v)}
        />
        <SliderRow
          label="Bold weight"
          value={settings.fontWeightBold}
          onChange={(fontWeightBold) => onChange({ ...settings, fontWeightBold })}
          range={FONT_WEIGHT_RANGE}
          step={100}
          format={(v) => String(v)}
        />
        <label className="flex items-center justify-between gap-3 text-chrome/85">
          <span>OpenType features</span>
          <input
            type="text"
            spellCheck={false}
            // The family's own defaults where it has them, so what is in force
            // while the field is empty is legible rather than invisible.
            placeholder={defaultFeatures || '"ss01" 1, "zero" 1'}
            className={`${selectClass} w-52 font-mono`}
            value={settings.fontFeatures}
            onChange={(e) => onChange({ ...settings, fontFeatures: e.target.value })}
          />
        </label>
        <DescriptorNote property="font-feature-settings" value={settings.fontFeatures} />
        {defaultFeatures && !settings.fontFeatures.trim() && (
          <p className="px-0.5 leading-relaxed text-chrome/30">
            {familyName(settings.fontFamily)} keeps its ligatures in stylistic sets rather
            than in the usual place, so those are on by default. Anything typed here replaces
            them outright.
          </p>
        )}
        <LigatureConflictNote settings={settings} />
        <label className="flex items-center justify-between gap-3 text-chrome/85">
          <span>Variable axes</span>
          <input
            type="text"
            spellCheck={false}
            placeholder={'"wdth" 85, "slnt" -10'}
            className={`${selectClass} w-52 font-mono`}
            value={settings.fontVariations}
            onChange={(e) => onChange({ ...settings, fontVariations: e.target.value })}
          />
        </label>
        <DescriptorNote property="font-variation-settings" value={settings.fontVariations} />
        <SliderRow
          label="Line height"
          value={settings.lineHeightPercent}
          onChange={(lineHeightPercent) => onChange({ ...settings, lineHeightPercent })}
          range={LINE_HEIGHT_PERCENT_RANGE}
          step={5}
          format={(v) => `${(v / 100).toFixed(2)}×`}
        />
        <SliderRow
          label="Letter spacing"
          value={settings.letterSpacing}
          onChange={(letterSpacing) => onChange({ ...settings, letterSpacing })}
          range={LETTER_SPACING_RANGE}
          format={(v) => `${v > 0 ? '+' : ''}${v}px`}
        />
        <FontRangeTable
          ranges={settings.fontRanges}
          onChange={(fontRanges) => onChange({ ...settings, fontRanges })}
          families={families}
        />
        <NamedFaceReport settings={settings} />
        <p className="leading-relaxed text-chrome/30">
          Leaving a style on the body font asks that font for the weight or slant, which is
          what it has always done. Naming a face instead is worth it for italic in
          particular, where a real cursive face is a different thing from a slanted upright
          one. Features are passed through as{' '}
          <code className="text-chrome/50">font-feature-settings</code>, so a font's stylistic
          sets and its slashed zero are reachable by tag — they reach italic text only when
          an italic face is named above. Variable axes go the same way, so a face's width,
          slant or optical size is reachable by tag too; weight has a control of its own
          because the cell is measured at it, and where the two disagree the axis wins. A range pins every codepoint between its two ends,
          inclusive and in hex, to one family ahead of everything else: the private use area
          to a Nerd Font, or CJK to a font that covers it. A row that is not a complete range
          yet has no effect.
        </p>
        <p className="leading-relaxed text-chrome/30">
          Weight is a number because that is what the axis is: 400 and 700 are what normal
          and bold mean, and a family with six cuts has no keyword for the one you probably
          want. A family without a face at the weight asked for gets the nearest it has.
          Line height and letter spacing resize the cell rather than the glyph — the grid
          has no gaps to widen — so a wider cell draws its character centred in the space,
          and a narrower one condenses it to fit. Both change how many rows and columns a
          pane holds, so open sessions re-fit as you drag them.
        </p>
      </div>
    </details>
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
  // null while unknown, so a button can say "checking" rather than briefly
  // claiming there is nothing to import.
  const [puttyCount, setPuttyCount] = useState<number | null>(null)
  const [sshConfigCount, setSshConfigCount] = useState<number | null>(null)
  /** Which import is mid-flight, or null. One at a time: both write
   * `sessions.json` through the same lock, and running them together would
   * only queue one behind the other while showing two spinners. */
  const [importing, setImporting] = useState<'putty' | 'sshConfig' | null>(null)
  // null while unread. Fonts can be installed while the app is running, but
  // not often enough to re-enumerate every time the dialog opens, so this is
  // read once per session and kept.
  const [installedFonts, setInstalledFonts] = useState<InstalledFont[] | null>(null)

  useEffect(() => {
    if (!open || installedFonts !== null) return
    let cancelled = false
    listInstalledFonts().then((fonts) => {
      if (!cancelled) setInstalledFonts(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [open, installedFonts])

  // Re-checked whenever the section is opened rather than once at mount:
  // PuTTY may have been installed, or `~/.ssh/config` edited, since the app
  // started, and this is the screen someone opens *because* they want to
  // import.
  useEffect(() => {
    if (!open || section !== 'import') return
    setPuttyCount(null)
    setSshConfigCount(null)
    puttySessionCount()
      .then(setPuttyCount)
      .catch(() => setPuttyCount(0))
    sshConfigSessionCount()
      .then(setSshConfigCount)
      .catch(() => setSshConfigCount(0))
  }, [open, section])

  async function runImport(which: 'putty' | 'sshConfig') {
    setImporting(which)
    const added = await (which === 'putty' ? runPuttyImport() : runSshConfigImport())
    setImporting(null)
    // The counts deliberately aren't re-read here. They report what PuTTY's
    // registry and `~/.ssh/config` hold, not what is left to import, so they
    // don't move when we copy sessions out of them — re-reading would just
    // show the same number and imply nothing happened. Running one again is
    // harmless anyway: an import is additive and dedupes on label and host, so
    // a second run says "no new sessions to import" and changes nothing.
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
        className={`flex items-center justify-center rounded p-1.5 transition-colors duration-150 hover:bg-chrome/10 ${
          open ? 'text-chrome/90' : 'text-chrome/50 hover:text-chrome/90'
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
              className="animate-in zoom-in-95 flex h-[430px] max-h-full w-[660px] max-w-full overflow-hidden rounded-xl border border-chrome/10 bg-surface text-xs shadow-2xl duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-44 shrink-0 overflow-y-auto border-r border-chrome/10 bg-black/10 py-2">
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setSection(id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 ${
                      section === id
                        ? 'bg-chrome/10 text-chrome'
                        : 'text-chrome/50 hover:bg-chrome/5 hover:text-chrome/80'
                    }`}
                  >
                    <Icon size={13} className="shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-chrome/10 px-4 py-2.5">
                  <span className="font-medium text-chrome/90">
                    {SECTIONS.find((s) => s.id === section)?.label}
                  </span>
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome"
                    title="Close (Esc)"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {section === 'terminal' && (
                    <>
                      <div className="space-y-3 px-2 py-1.5">
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
                          <span>Font</span>
                          <select
                            className={selectClass}
                            value={settings.fontFamily}
                            onChange={(e) => onChange({ ...settings, fontFamily: e.target.value })}
                          >
                            {(() => {
                              const opts = fontOptions(settings.fontFamily, installedFonts)
                              return (
                                <>
                                  {opts.curated.map((f) => (
                                    <option key={f.value} value={f.value}>
                                      {f.label}
                                    </option>
                                  ))}
                                  {opts.bundled.length > 0 && (
                                    <optgroup label="Bundled with wRusTTY">
                                      {opts.bundled.map((f) => (
                                        <option key={f.value} value={f.value}>
                                          {f.label}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {opts.extra && (
                                    <option key={opts.extra.value} value={opts.extra.value}>
                                      {opts.extra.label}
                                    </option>
                                  )}
                                  {opts.installed.length > 0 && (
                                    <optgroup label="Installed">
                                      {opts.installed.map((f) => (
                                        <option key={f.value} value={f.value}>
                                          {f.label}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                </>
                              )
                            })()}
                          </select>
                        </label>
                        <FontResolution
                          stack={settings.fontFamily}
                          installed={installedFonts}
                          italicFace={settings.fontFamilyItalic}
                        />
                        <AdvancedFontSettings
                          settings={settings}
                          onChange={onChange}
                          installed={installedFonts}
                        />
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
                          <span>Font size</span>
                          <span className="flex items-center gap-2">
                            <RangeInput
                              min={FONT_SIZE_RANGE.min}
                              max={FONT_SIZE_RANGE.max}
                              step={1}
                              className="w-40"
                              value={settings.fontSize}
                              aria-label="Font size"
                              onChange={(size) => onChange({ ...settings, fontSize: size })}
                            />
                            <span className="w-8 text-right text-chrome/50">
                              {settings.fontSize}px
                            </span>
                          </span>
                        </label>
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
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
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
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
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
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
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
                          <span>Ligatures</span>
                          <input
                            type="checkbox"
                            className="accent-sky-400"
                            checked={settings.ligatures}
                            onChange={(e) =>
                              onChange({ ...settings, ligatures: e.target.checked })
                            }
                          />
                        </label>
                        <p className="leading-relaxed text-chrome/30">
                          Font changes apply to open sessions immediately. Scrollback is set
                          as memory per pane because memory is what's actually reserved; the
                          row estimates are for a {cols}-column pane and counted in wrapped
                          rows, so a wider pane or long lines reach the same limit sooner. It
                          applies to panes opened afterwards. The cursor setting is a starting
                          point — a program that picks its own cursor, as vim and many TUIs
                          do, overrides it. Ligatures join runs of operators like{' '}
                          <code className="text-chrome/50">=&gt;</code> into one glyph, and need
                          a font that has them — all three bundled fonts do, as does Cascadia
                          Code; Cascadia Mono and Consolas do not. Monaspace Neon also spaces
                          awkward letter pairs apart through the same mechanism, so it wants
                          this on too. The cursor's own cell always shows the plain
                          character.
                        </p>
                      </div>
                      <Toggle
                        checked={settings.copyOnSelect}
                        onChange={(v) => onChange({ ...settings, copyOnSelect: v })}
                        label="Copy on select"
                        hint={`Selecting text in the terminal copies it automatically. ${
                          bindingsFor(settings.keybindings, 'copy')[0] ?? 'The copy shortcut'
                        } copies the selection either way, and ${
                          bindingsFor(settings.keybindings, 'markMode')[0] ??
                          'the mark-mode shortcut'
                        } selects with the keyboard.`}
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
                      <ThemeEditor settings={settings} onChange={onChange} />
                      <div>
                        <label className="flex items-center justify-between gap-2 text-chrome/85">
                          <span>Background opacity</span>
                          <span className="text-chrome/50">
                            {Math.round(settings.backgroundOpacity * 100)}%
                          </span>
                        </label>
                        <RangeInput
                          min={40}
                          max={100}
                          step={5}
                          className="mt-1.5 w-full"
                          value={Math.round(settings.backgroundOpacity * 100)}
                          aria-label="Background opacity"
                          onChange={(percent) =>
                            onChange({ ...settings, backgroundOpacity: percent / 100 })
                          }
                        />
                      </div>
                      <div>
                        <span className="text-chrome/85">When unfocused</span>
                        <div className="mt-1.5 flex gap-1 rounded-md bg-black/20 p-1">
                          {(
                            [
                              ['fade', 'Fade'],
                              ['glass', 'See-through'],
                            ] as const
                          ).map(([style, sLabel]) => (
                            <button
                              key={style}
                              type="button"
                              onClick={() => onChange({ ...settings, unfocusedStyle: style })}
                              className={`flex-1 rounded py-1 transition-colors duration-150 ${
                                settings.unfocusedStyle === style
                                  ? 'bg-chrome/15 text-chrome'
                                  : 'text-chrome/40 hover:text-chrome/70'
                              }`}
                            >
                              {sLabel}
                            </button>
                          ))}
                        </div>
                        {settings.unfocusedStyle === 'glass' ? (
                          <>
                            <label className="mt-3 flex items-center justify-between gap-2 text-chrome/85">
                              <span>Opacity when unfocused</span>
                              <span className="text-chrome/50">
                                {settings.unfocusedOpacityPercent}%
                              </span>
                            </label>
                            <RangeInput
                              min={UNFOCUSED_OPACITY_RANGE.min}
                              max={UNFOCUSED_OPACITY_RANGE.max}
                              step={UNFOCUSED_OPACITY_STEP}
                              className="mt-1.5 w-full"
                              value={settings.unfocusedOpacityPercent}
                              aria-label="Opacity when unfocused"
                              onChange={(percent) =>
                                onChange({ ...settings, unfocusedOpacityPercent: percent })
                              }
                            />
                            <p className="mt-1 text-chrome/40">
                              While another app is active, the window turns its effect off and
                              uses this opacity instead, then returns to the settings above when
                              you click back in. Text is unaffected.
                            </p>
                          </>
                        ) : (
                          <>
                            <label className="mt-3 flex items-center justify-between gap-2 text-chrome/85">
                              <span>Fade when unfocused</span>
                              <span className="text-chrome/50">
                                {settings.unfocusedDimPercent === 0
                                  ? 'Off'
                                  : `${settings.unfocusedDimPercent}%`}
                              </span>
                            </label>
                            <RangeInput
                              min={UNFOCUSED_DIM_RANGE.min}
                              max={UNFOCUSED_DIM_RANGE.max}
                              step={UNFOCUSED_DIM_STEP}
                              className="mt-1.5 w-full"
                              value={settings.unfocusedDimPercent}
                              aria-label="Fade when unfocused"
                              onChange={(percent) =>
                                onChange({ ...settings, unfocusedDimPercent: percent })
                              }
                            />
                            <p className="mt-1 text-chrome/40">
                              While another app is active, shifts the background towards the tab
                              bar's colour and makes it more see-through, so it is obvious this
                              window is not the one you are typing into. Text is unaffected.
                            </p>
                          </>
                        )}
                      </div>
                      <div>
                        <span className="text-chrome/85">Window effect</span>
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
                                  ? 'bg-chrome/15 text-chrome'
                                  : 'text-chrome/40 hover:text-chrome/70'
                              }`}
                            >
                              {mLabel}
                            </button>
                          ))}
                        </div>
                        <p className="mt-1.5 leading-relaxed text-chrome/40">
                          {settings.vibrancyMode === 'acrylic'
                            ? 'Live blur-behind, at opacity below 100% — Windows has a documented lag bug on some builds while resizing/dragging.'
                            : settings.vibrancyMode === 'mica'
                              ? "A one-time wallpaper-color tint, not a live blur — won't show desktop content moving behind the window."
                              : settings.vibrancyMode === 'tabbed'
                                ? 'Same one-time tint as Mica, tuned for windows with a tab strip — no live blur either. Windows 11 only.'
                                : 'Opacity below 100% still applies as plain unblurred glass, with no OS effect layered under it.'}
                        </p>
                      </div>
                      {/* Three modes rather than a switch and a slider: the
                          correction has no constant in it, so there is
                          nothing left to tune once it is on. Names and
                          behaviour are ghostty's alpha-blending option. */}
                      <div>
                        <span className="text-chrome/85">Text blending</span>
                        <div className="mt-1.5 flex gap-1 rounded-md bg-black/20 p-1">
                          {(
                            [
                              ['native', 'Native'],
                              ['linear', 'Linear'],
                              ['linear-corrected', 'Corrected'],
                            ] as const
                          ).map(([mode, mLabel]) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => onChange({ ...settings, textBlending: mode })}
                              className={`flex-1 rounded py-1 transition-colors duration-150 ${
                                settings.textBlending === mode
                                  ? 'bg-chrome/15 text-chrome'
                                  : 'text-chrome/40 hover:text-chrome/70'
                              }`}
                            >
                              {mLabel}
                            </button>
                          ))}
                        </div>
                        <p className="mt-1.5 leading-relaxed text-chrome/40">
                          {settings.textBlending === 'linear'
                            ? 'Blends antialiased edges in linear light. Physically correct, and removes the dark fringe — but draws light-on-dark text heavier and dark-on-light thinner than the font intends.'
                            : settings.textBlending === 'linear-corrected'
                              ? 'Linear blending, corrected so text keeps the weight it has under Native. Removes the dark fringe where a glyph and its background differ in hue, and changes nothing else.'
                              : 'Blends in sRGB, the space the canvas is already in. What this terminal has always done — cheapest, but colored text picks up a dark fringe at the edges.'}
                        </p>
                      </div>
                    </div>
                  )}

                  {section === 'session' && (
                    <>
                      <Toggle
                        checked={settings.closeOnDisconnect}
                        onChange={(v) => onChange({ ...settings, closeOnDisconnect: v })}
                        label="Close pane when the session ends"
                        hint="When the remote shell exits or the server hangs up, close the pane instead of leaving it open on Reconnect actions. A connection that drops unexpectedly is not affected — that one reconnects on its own."
                      />
                      <Toggle
                        checked={settings.autoReconnect}
                        onChange={(v) => onChange({ ...settings, autoReconnect: v })}
                        label="Reconnect a dropped connection automatically"
                        hint="A link that goes away without being asked to comes back on its own, under the same pane — its scrollback, logging, port forwards and running transfers all survive. Note that the shell itself does not: SSH cannot resume a session, so the remote process is gone and the working directory is back to the login default. Individual saved sessions can opt out."
                      />
                      {/* Only under the switch they qualify. Shown as a pair
                          because both bind and neither alone describes the
                          leash: the delay doubles to a 30s ceiling, so twelve
                          attempts is four minutes early on and much longer once
                          it saturates. */}
                      {settings.autoReconnect && (
                        <div className="space-y-2 pl-8">
                          <label className="flex items-center justify-between gap-3 text-chrome/85">
                            <span>Give up after</span>
                            <select
                              className={selectClass}
                              value={settings.reconnectMaxAttempts}
                              onChange={(e) =>
                                onChange({
                                  ...settings,
                                  reconnectMaxAttempts: Number(e.target.value),
                                })
                              }
                            >
                              {[3, 6, 12, 25, 50].map((n) => (
                                <option key={n} value={n}>
                                  {n} attempts
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex items-center justify-between gap-3 text-chrome/85">
                            <span>...or after</span>
                            <select
                              className={selectClass}
                              value={settings.reconnectMaxSeconds}
                              onChange={(e) =>
                                onChange({
                                  ...settings,
                                  reconnectMaxSeconds: Number(e.target.value),
                                })
                              }
                            >
                              {[
                                [60, '1 minute'],
                                [120, '2 minutes'],
                                [300, '5 minutes'],
                                [900, '15 minutes'],
                                [3600, '1 hour'],
                              ].map(([seconds, label]) => (
                                <option key={seconds} value={seconds}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p className="leading-relaxed text-chrome/40">
                            Whichever comes first. The wait doubles from one second to a
                            thirty-second ceiling, so the clock is usually the one that decides.
                          </p>
                        </div>
                      )}
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
                      <div className="space-y-2 px-2 py-2">
                        <label className="flex items-center justify-between gap-3 text-chrome/85">
                          <span>Outbound proxy for SSH</span>
                          <select
                            className={selectClass}
                            value={settings.proxyKind}
                            onChange={(e) =>
                              onChange({
                                ...settings,
                                proxyKind: e.target.value as ProxyKindSetting,
                              })
                            }
                          >
                            <option value="none">None — connect directly</option>
                            <option value="http">HTTP (CONNECT)</option>
                            <option value="socks5">SOCKS5</option>
                          </select>
                        </label>
                        {settings.proxyKind !== 'none' && (
                          <div className="flex gap-2 pl-8">
                            <input
                              type="text"
                              spellCheck={false}
                              aria-label="Proxy host"
                              placeholder="proxy.example.com"
                              className="min-w-0 flex-1 rounded border border-chrome/10 bg-black/20 px-2 py-1 font-mono text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
                              value={settings.proxyHost}
                              onChange={(e) => onChange({ ...settings, proxyHost: e.target.value })}
                            />
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              aria-label="Proxy port"
                              placeholder={String(DEFAULT_PROXY_PORT[settings.proxyKind])}
                              className="w-20 rounded border border-chrome/10 bg-black/20 px-2 py-1 font-mono text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
                              value={settings.proxyPort || ''}
                              onChange={(e) => {
                                const port = Number(e.target.value)
                                onChange({
                                  ...settings,
                                  proxyPort:
                                    Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
                                })
                              }}
                            />
                          </div>
                        )}
                        <p className="leading-relaxed text-chrome/40">
                          SSH sessions reach their host — or their jump host — through this
                          proxy, which resolves the name itself. Telnet and serial are
                          unaffected, and Wake-on-LAN is skipped behind a proxy. A proxy that
                          asks for a login is reported as such; logins are not supported. A
                          saved session can opt out on its connect form.
                        </p>
                      </div>
                    </>
                  )}

                  {section === 'keyboard' && (
                    <KeybindingsEditor
                      value={settings.keybindings}
                      onChange={(keybindings) => onChange({ ...settings, keybindings })}
                    />
                  )}

                  {section === 'files' && (
                    <div className="space-y-3 px-2 py-1.5">
                      <label className="flex flex-col gap-1.5 text-chrome/85">
                        <span>Open remote files with</span>
                        <input
                          type="text"
                          spellCheck={false}
                          placeholder="Windows default (leave empty)"
                          className="w-full rounded border border-chrome/10 bg-black/20 px-2 py-1 font-mono text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
                          value={settings.externalEditor}
                          onChange={(e) => onChange({ ...settings, externalEditor: e.target.value })}
                        />
                      </label>
                      <p className="leading-relaxed text-chrome/50">
                        Empty opens the file in whatever Windows uses for its type. That
                        works with no setup, but nothing can tell when you have finished
                        with it — the editor usually hands the file to a copy of itself
                        that is already running and returns at once — so the panel's
                        “watching” marker has to be dismissed by hand.
                      </p>
                      <p className="leading-relaxed text-chrome/50">
                        A command that <em>waits</em> fixes that: wRusTTY knows when you
                        close the file, uploads the last save, and stops watching on its
                        own. The wait flag is the whole point — without it the command
                        returns immediately and nothing is gained.
                      </p>
                      <div className="space-y-1 font-mono text-chrome/40">
                        <div>code --wait</div>
                        <div>"C:\Program Files\Sublime Text\subl.exe" --wait</div>
                        <div>gvim -f</div>
                      </div>
                      <p className="leading-relaxed text-chrome/30">
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

                  {section === 'autocomplete' && (
                    <>
                      <Toggle
                        checked={settings.autocompleteEnabled}
                        onChange={(v) => onChange({ ...settings, autocompleteEnabled: v })}
                        label="Suggest recent commands"
                        hint="As you type at a remote prompt, offer commands you have run on that host before. Press the right arrow at the end of the line to take one, or Alt+Right for just its next word — Tab stays the remote shell's own completion key. Turning this on means command lines are saved to this machine — off means none are kept, and none are suggested."
                      />
                      {/* Indented and disabled-when-off, because it is not a
                          second feature but a part of this one — and because
                          it must never look like something the switch above
                          already turned on. It is the only part of
                          autocomplete that reads anything on a remote
                          machine, so it is off by default even here. */}
                      {settings.autocompleteEnabled && (
                        <div className="ml-6 border-l border-chrome/10 pl-2">
                          <Toggle
                            checked={settings.autocompleteImportRemoteHistory}
                            onChange={(v) =>
                              onChange({ ...settings, autocompleteImportRemoteHistory: v })
                            }
                            label="Import each host's own shell history"
                            hint="Once per SSH session, read the host's shell history file (over its own channel, on the connection already open) so suggestions work the first time you connect. Nothing is written on the host and its history file is not changed. Off by default: this is the only part of autocomplete that reads anything on a server, and a server is often not yours alone. Individual saved sessions can override this."
                          />
                        </div>
                      )}
                      <CommandHistorySection />
                    </>
                  )}

                  {section === 'shell' && (
                    <div className="space-y-3 px-2 py-1.5">
                      <p className="leading-relaxed text-chrome/50">
                        Append the snippet to the rc file on a host once and every session
                        there reports when its commands start and finish, and which
                        directory it is in — to any terminal that speaks OSC 133 and
                        OSC 7, not just wRusTTY. The directory is what lets a dropped
                        file land where you are without being asked. It emits nothing in
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
                            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-chrome/[0.06] py-1.5 text-chrome/70 transition-colors duration-fast ease-swift hover:bg-chrome/10 hover:text-chrome"
                          >
                            <ClipboardCopy size={12} /> {snippet.label}
                          </button>
                        ))}
                      </div>
                      <p className="leading-relaxed text-chrome/30">
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
                      <Toggle
                        checked={settings.autoLogSessions}
                        onChange={(v) => onChange({ ...settings, autoLogSessions: v })}
                        label="Log every session"
                        hint="Starts a transcript for every connection as it opens, login banner included. Without this, a session is logged when its connect form or saved session asks for it, or from the toolbar once it is open."
                      />
                      <div className="space-y-1.5 px-2 py-2">
                        <span className="text-chrome/85">Log folder</span>
                        <div className="flex items-center gap-2">
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-chrome/60"
                            title={settings.logDirectory || undefined}
                          >
                            {settings.logDirectory || 'Default — inside the app’s own log folder'}
                          </span>
                          <button
                            type="button"
                            onClick={async () => {
                              const picked = await openDialog({
                                directory: true,
                                multiple: false,
                                defaultPath: settings.logDirectory || undefined,
                              })
                              if (typeof picked === 'string') {
                                onChange({ ...settings, logDirectory: picked })
                              }
                            }}
                            className="shrink-0 rounded border border-chrome/10 px-2 py-0.5 text-chrome/80 transition-colors duration-100 hover:bg-chrome/10"
                          >
                            Choose…
                          </button>
                          {settings.logDirectory && (
                            <button
                              type="button"
                              onClick={() => onChange({ ...settings, logDirectory: '' })}
                              className="shrink-0 rounded border border-chrome/10 px-2 py-0.5 text-chrome/80 transition-colors duration-100 hover:bg-chrome/10"
                            >
                              Use default
                            </button>
                          )}
                        </div>
                        <p className="leading-relaxed text-chrome/40">
                          Applies to the next log started. A folder that has gone missing is
                          created again, and one that cannot be is reported when a log starts.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          revealLogs(settings.logDirectory).catch((e) =>
                            toast.error(`Couldn't open logs folder: ${e}`),
                          )
                        }
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-chrome/5"
                      >
                        <FolderOpen size={14} className="mt-0.5 shrink-0 text-chrome/50" />
                        <span className="text-chrome/85">
                          Open logs folder
                          <span className="mt-0.5 block text-chrome/40">
                            Where session transcripts are saved.
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                  {section === 'import' && (
                    <>
                      <div className="px-2 py-1.5">
                        <p className="text-chrome/40">
                          Your saved credentials, sessions and workspaces move as one bundle —
                          each is meaningless without the others, so a backup carries all three.
                          Only the credentials are encrypted.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={vaultStatus !== 'unlocked'}
                        onClick={() => void exportVaultBundle(confirm)}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-chrome/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <Download size={14} className="mt-0.5 shrink-0 text-chrome/50" />
                        <span className="text-chrome/85">
                          Export a backup…
                          <span className="mt-0.5 block text-chrome/40">
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
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-chrome/5"
                      >
                        <Upload size={14} className="mt-0.5 shrink-0 text-chrome/50" />
                        <span className="text-chrome/85">
                          Restore from a backup…
                          <span className="mt-0.5 block text-chrome/40">
                            Replaces everything currently saved. You will need the backup&apos;s
                            own master password.
                          </span>
                        </span>
                      </button>

                      <div className="mt-2 border-t border-chrome/10 px-2 pb-1.5 pt-3">
                        <p className="text-chrome/40">
                          Migrating from another client. Additive — a session already saved here
                          with the same name and host is left exactly as it is, so running one
                          twice is harmless.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={importing !== null || puttyCount === 0}
                        onClick={() => void runImport('putty')}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-chrome/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <Upload size={14} className="mt-0.5 shrink-0 text-chrome/50" />
                        <span className="text-chrome/85">
                          {importing === 'putty' ? 'Importing…' : 'Import from PuTTY'}
                          <span className="mt-0.5 block text-chrome/40">
                            {puttyCount === null
                              ? 'Checking for saved PuTTY sessions…'
                              : puttyCount === 0
                                ? 'No saved PuTTY sessions found on this machine.'
                                : `${puttyCount} saved ${puttyCount === 1 ? 'session' : 'sessions'} found. Passwords aren't imported — PuTTY doesn't store them.`}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={importing !== null || sshConfigCount === 0}
                        onClick={() => void runImport('sshConfig')}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-chrome/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <Upload size={14} className="mt-0.5 shrink-0 text-chrome/50" />
                        <span className="text-chrome/85">
                          {importing === 'sshConfig' ? 'Importing…' : 'Import from your SSH config'}
                          <span className="mt-0.5 block text-chrome/40">
                            {sshConfigCount === null
                              ? 'Checking ~/.ssh/config…'
                              : sshConfigCount === 0
                                ? 'No hosts found in ~/.ssh/config.'
                                : // Named rather than counted-and-left-vague: what
                                  // does and doesn't come across is the question
                                  // someone has before pressing this.
                                  `${sshConfigCount} ${sshConfigCount === 1 ? 'host' : 'hosts'} found in ~/.ssh/config. Host, port, user, identity file, ProxyJump and ServerAliveInterval come across; other settings don't.`}
                          </span>
                        </span>
                      </button>
                    </>
                  )}

                  {section === 'about' && (
                    <>
                      <div className="px-2 py-1.5">
                        <p className="leading-relaxed text-chrome/40">
                          The terminal engine is a build of ghostty compiled to WebAssembly, not a
                          released version of it — the commit and hash below are what identify it.
                          Quote all of this in a bug report about parsing or rendering.
                        </p>
                      </div>
                      <dl className="space-y-1.5 px-2 py-1.5">
                        {ABOUT_FACTS.map(([label, value]) => (
                          <div key={label} className="flex items-baseline gap-3">
                            <dt className="w-28 shrink-0 text-chrome/40">{label}</dt>
                            {/* break-all, not truncate: the hash is the field most
                                likely to be read off the screen rather than copied,
                                and half a hash is no use. */}
                            <dd className="min-w-0 break-all font-mono text-chrome/85">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <button
                        type="button"
                        onClick={() =>
                          writeText(ABOUT_FACTS.map(([k, v]) => `${k}: ${v}`).join('\n'))
                            .then(() => toast.success('Version details copied'))
                            .catch((e) => toast.error(`Couldn't copy: ${e}`))
                        }
                        className="mt-1 flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-swift hover:bg-chrome/5"
                      >
                        <ClipboardCopy size={14} className="mt-0.5 shrink-0 text-chrome/50" />
                        <span className="text-chrome/85">
                          Copy version details
                          <span className="mt-0.5 block text-chrome/40">
                            As plain text, ready to paste into an issue.
                          </span>
                        </span>
                      </button>
                      {/* Attribution, and a licence condition rather than a
                          courtesy: the Git logo is CC BY 3.0, which requires
                          the credit to travel with the mark wherever it is
                          distributed — including into a shipped installer,
                          where a file in the repo would never reach anyone.
                          THIRD-PARTY-NOTICES.md carries the long form. */}
                      <div className="mt-2 border-t border-chrome/10 px-2 py-2">
                        <p className="leading-relaxed text-chrome/40">
                          Shell icons identify the products they launch. The Git logo is by Jason
                          Long, licensed CC BY 3.0. Linux is a trademark of Linus Torvalds, used
                          here referentially. PowerShell and Command Prompt icons are not included
                          with wRusTTY: they are read from the programs installed on this computer.
                          PowerShell and Windows are trademarks of Microsoft Corporation, which
                          does not sponsor or endorse wRusTTY.
                        </p>
                      </div>
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
