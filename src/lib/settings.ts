import type { VibrancyMode } from './windowEffects'
import { resolveRangeOverlaps } from './fontStack'
import { sanitizeCustomThemes, setCustomThemes, type TerminalTheme } from './theme'
import { sanitizeKeybindings, type Keybindings } from './keybindings'
import type { ProxyConfig } from './ssh'

export type ProxyKindSetting = 'none' | 'http' | 'socks5'
export const PROXY_KINDS: readonly ProxyKindSetting[] = ['none', 'http', 'socks5']

/** The port a proxy kind usually listens on, used when `proxyPort` is 0. */
export const DEFAULT_PROXY_PORT: Record<'http' | 'socks5', number> = { http: 3128, socks5: 1080 }

/** What Ctrl+0 restores, and what a settings blob without a size gets. */
export const DEFAULT_FONT_SIZE = 13

export type CursorStyleSetting = 'block' | 'bar' | 'underline'

/** Color space the renderer blends glyph coverage in; see `textBlending`.
 *  The values and names are ghostty's `alpha-blending` option. */
export type TextBlending = 'native' | 'linear' | 'linear-corrected'

const TEXT_BLENDINGS: readonly TextBlending[] = ['native', 'linear', 'linear-corrected']

/** DECSCUSR values; each pairs a shape with blink or steady. */
const DECSCUSR: Record<CursorStyleSetting, { blink: number; steady: number }> = {
  block: { blink: 1, steady: 2 },
  underline: { blink: 3, steady: 4 },
  bar: { blink: 5, steady: 6 },
}

/** The sequence that puts a terminal into the configured cursor. */
export function cursorStyleSequence(style: CursorStyleSetting, blink: boolean): string {
  const pair = DECSCUSR[style] ?? DECSCUSR.block
  return `[${blink ? pair.blink : pair.steady} q`
}

export interface TerminalSettings {
  /** Selecting text immediately copies it to the clipboard. */
  copyOnSelect: boolean
  /** Right-click pastes clipboard contents instead of opening a menu. */
  rightClickPaste: boolean
  /** When a connection ends cleanly (the shell exits or the server hangs up),
   * close the pane after a moment. Off leaves it open with Reconnect actions. */
  closeOnDisconnect: boolean
  /** Reconnect a dropped connection under the same session id, keeping the
   * pane's engine, scrollback, logging, forwards and transfers. The new shell is
   * still a new shell (SSH has no resumption). Reconnect happens only if this,
   * the profile's `autoReconnect` and the backend all allow it. */
  autoReconnect: boolean
  /** Attempts per reconnect run before giving up. Clamped to 1-100 backend-side. */
  reconnectMaxAttempts: number
  /** Wall-clock seconds per reconnect run, whichever bound binds first. Clamped
   * to 5-3600. */
  reconnectMaxSeconds: number
  /** Strip escape sequences from session logs. Off logs the raw PTY stream.
   * Applies to the next log started. */
  logPlainText: boolean
  /** Log every session as it connects. */
  autoLogSessions: boolean
  /** Folder for transcripts; '' for the default. Must be a full path. */
  logDirectory: string
  /** Outbound proxy for SSH: none, HTTP `CONNECT`, or SOCKS5. Global, with a
   * per-session opt-out (`SessionProfile.useProxy`). No proxy auth; see wr-ssh's
   * proxy.rs. */
  proxyKind: ProxyKindSetting
  proxyHost: string
  /** 0 for the kind's usual port (`DEFAULT_PROXY_PORT`). */
  proxyPort: number
  /** Shortcut overrides by action (only those that differ from the defaults);
   * see lib/keybindings.ts. */
  keybindings: Keybindings
  /** Toast when a long-running command finishes in a tab you aren't watching,
   * using OSC 133 (see lib/shellIntegration.ts). Silent without shell
   * integration. */
  notifyOnCommandComplete: boolean
  /** A bell (BEL) from the far end marks its pane until focused. The key says
   * "tab" for compatibility with existing stored settings. */
  bellMarksTab: boolean
  /** A bell also plays a short tone. */
  bellSound: boolean
  /** Show desktop notifications a remote program requests by name (OSC 9 /
   * OSC 777). Separate from `notifyOnCommandComplete` because the remote side
   * chooses the text; it's bounded, stripped of control characters and shown
   * under the pane's name (see lib/appProgress.ts). */
  remoteNotifications: boolean
  /** Let remote programs write the clipboard via OSC 52; the only copy path a
   * full-screen remote program has. Reads are always refused. Every write raises
   * a toast, since silent writes enable clipboard poisoning. */
  clipboardWriteFromRemote: boolean
  /** Font stack for the terminal; any CSS family list. Must be monospaced: the
   * engine measures one glyph. */
  fontFamily: string
  /** Terminal font size in px. */
  fontSize: number
  /**
   * CSS numeric weights for regular and bold text (400 and 700 by default). A
   * family without that weight gets the browser's nearest match or a synthesized
   * one.
   */
  fontWeight: number
  fontWeightBold: number
  /**
   * Cell height as a percentage of the font size (120 = 1.2). An integer so it
   * round-trips through JSON exactly.
   */
  lineHeightPercent: number
  /**
   * Pixels added to each cell's width. Glyphs are centered; negative values
   * condense the glyph to fit.
   */
  letterSpacing: number
  /**
   * Per-pane memory for scrollback, in MB of total WASM footprint; one of
   * `SCROLLBACK_FOOTPRINT_TIERS_MB`. Memory rather than rows because the core's
   * limit is a byte budget: rows depend on width (~24,000 at 80 columns vs
   * ~6,500 at 400). Settings and the status bar show the derived rows.
   */
  scrollbackBudgetMB: number
  /**
   * Default cursor shape, written as DECSCUSR so an application's own shape
   * still wins.
   */
  cursorStyle: CursorStyleSetting
  /** Whether the default cursor blinks (part of the same DECSCUSR). */
  cursorBlink: boolean
  /** Ask before closing a tab, pane or the window with a live connection. */
  confirmCloseWithConnection: boolean
  /**
   * Command used to open a remote file for editing instead of the OS handler
   * (empty, the default). It must block until the user is done (`code --wait`,
   * `subl --wait`, `gvim -f`) so the watch can end itself.
   *
   * `{file}` marks where the path goes; otherwise it's appended. Backslashes are
   * literal and double quotes group. A command that returns immediately keeps
   * the watch.
   */
  externalEditor: string
  /** Suggest previously run commands at a remote prompt, from a per-host store
   * (see docs/AUTOCOMPLETE_PLAN.md and lib/commandHistory.ts). Off by default
   * since it records command lines to disk; off means nothing is captured.
   * Importing the host's history file is a separate switch. */
  autocompleteEnabled: boolean
  /**
   * Once per session, import the remote host's shell history file. Requires
   * `autocompleteEnabled` and is off by default even then, since it reads a file
   * on a server that may not be yours alone. SSH only; overridable per session
   * (`SessionProfile.importRemoteHistory`).
   */
  autocompleteImportRemoteHistory: boolean
  /** Active theme name: a preset from lib/theme.ts or one of `customThemes`.
   * By name, so edits repaint panes using it and a missing theme falls back. */
  themeName: string
  /** The user's own themes, alongside the presets. Never shadow a preset name;
   * see `sanitizeCustomThemes`. */
  customThemes: TerminalTheme[]
  /** Offer to reopen the previous session's tabs and panes on launch. Opt-in:
   * it reconnects live sessions and may need the vault. */
  restoreSessionsOnLaunch: boolean
  /** 1 = fully opaque (default). Below 1 the background is alpha-blended, over
   * the window effect if one is set. */
  backgroundOpacity: number
  /** How much further the background fades while the window is inactive, as a
   * percentage of `backgroundOpacity` (0 = no change). Relative so it composes
   * with any base opacity; see `effectiveBackgroundLayers`. */
  unfocusedDimPercent: number
  /** What losing focus does: 'fade' applies `unfocusedDimPercent`; 'glass'
   * behaves as if the window effect were off and the opacity were
   * `unfocusedOpacityPercent`. See `unfocusedAppearance`. */
  unfocusedStyle: UnfocusedStyle
  /** 'glass' only: the background opacity while unfocused, in percent. */
  unfocusedOpacityPercent: number
  /** Runtime only, never saved: the background color panes use while the window
   * is unfocused (from `stripColor`), set by App. */
  backgroundOverride?: string | null
  /** 'off' skips the native call. 'acrylic' is live blur but has a known
   * resize/drag performance bug on Win10 1903+/Win11 22000+. 'mica' and 'tabbed'
   * are a static wallpaper tint ('tabbed' tuned for windows with a tab strip). */
  vibrancyMode: VibrancyMode
  /**
   * Color space glyph coverage is blended in:
   *
   * - 'native': sRGB. Under-weights edge pixels, giving colored text a dark
   *   fringe.
   * - 'linear': linear light. No fringe, but dark-on-light text looks thinner and
   *   light-on-dark thicker than designed.
   * - 'linear-corrected': linear with ghostty's per-pixel weight correction, so
   *   weight matches 'native' without the fringe.
   *
   * Defaults to 'native' so updates don't restyle existing installs.
   */
  textBlending: TextBlending
  /**
   * Shape runs of ASCII operators as one string so a font's ligatures apply.
   * Off by default: it costs atlas slots, and the default fonts have none.
   */
  ligatures: boolean
  /**
   * Faces for bold, italic and bold italic. Empty means the body font with the
   * weight or slant requested from CSS. A separate italic face is also what lets
   * `fontFeatures` reach italic text; see `fontStack.ts`.
   */
  fontFamilyBold: string
  fontFamilyItalic: string
  fontFamilyBoldItalic: string
  /**
   * OpenType features as a CSS `font-feature-settings` value (`"ss01" 1`).
   * Canvas 2D can't set these, so the face is declared with them baked in; see
   * `fontStack.ts`.
   */
  fontFeatures: string
  /**
   * Variable font axes as a CSS `font-variation-settings` value (`"wdth" 85`).
   * Overrides the weight setting where they overlap.
   */
  fontVariations: string
  /**
   * Codepoint ranges pinned to a family (e.g. a face for the private-use area),
   * consulted before the body font.
   */
  fontRanges: FontRange[]
}

/** One entry of `fontRanges`; `lo` and `hi` are inclusive codepoints. */
export interface FontRange {
  lo: number
  hi: number
  family: string
}

/**
 * The font stacks Settings offers. Each ends with a symbol tier, since Canvas
 * 2D falls back per glyph across the list (box drawing and Powerline glyphs are
 * drawn as geometry; see boxDrawing.ts). `bundled` entries ship in the app
 * (see `bundledFonts.ts`) and resolve on a fresh install. Cascadia Code
 * differs from Mono only in ligatures, which need `ligatures` on.
 */
export const FONT_STACKS: ReadonlyArray<{ label: string; value: string; bundled?: true }> = [
  {
    label: 'System default',
    value: 'ui-monospace, Consolas, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
  },
  {
    label: 'JetBrains Mono',
    value: '"JetBrains Mono", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
    bundled: true,
  },
  {
    label: 'Fira Code',
    value: '"Fira Code", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
    bundled: true,
  },
  {
    label: 'Monaspace Neon',
    value:
      '"Monaspace Neon", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
    bundled: true,
  },
  {
    label: 'Cascadia Mono',
    value: '"Cascadia Mono", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
  },
  {
    label: 'Cascadia Code',
    value: '"Cascadia Code", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
  },
  {
    label: 'Consolas',
    value: 'Consolas, ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
  },
  {
    label: 'Courier New',
    value: '"Courier New", "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
  },
  {
    label: 'Lucida Console',
    value: '"Lucida Console", ui-monospace, "Symbols Nerd Font Mono", "Segoe UI Symbol", monospace',
  },
]

/**
 * Former default stacks mapped to their current equivalents, so existing
 * installs pick up the symbol tier. Only exact former defaults are rewritten.
 */
const FONT_STACK_MIGRATIONS: Record<string, string> = {
  'ui-monospace, Consolas, monospace': curatedStack('System default'),
  '"Cascadia Mono", ui-monospace, monospace': curatedStack('Cascadia Mono'),
  '"Cascadia Code", ui-monospace, monospace': curatedStack('Cascadia Code'),
  'Consolas, ui-monospace, monospace': curatedStack('Consolas'),
  '"Courier New", monospace': curatedStack('Courier New'),
  '"Lucida Console", ui-monospace, monospace': curatedStack('Lucida Console'),
}

/** The current stack for a curated entry, by its picker label. Throws for an
 *  unknown label. */
function curatedStack(label: string): string {
  const entry = FONT_STACKS.find((f) => f.label === label)
  if (!entry) throw new Error(`no curated font stack labeled ${label}`)
  return entry.value
}

/**
 * Keeps only well-formed, lookup-able ranges. Malformed or overlapping ones are
 * dropped (see `resolveRangeOverlaps`): the atlas binary-searches these, so a
 * bad range would silently never match.
 */
function sanitizeRanges(value: unknown): FontRange[] {
  if (!Array.isArray(value)) return []
  const out: FontRange[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { lo, hi, family } = entry as Partial<FontRange>
    if (typeof lo !== 'number' || typeof hi !== 'number' || typeof family !== 'string') continue
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > 0x10ffff) continue
    if (family.trim() === '') continue
    out.push({ lo, hi, family })
  }
  // Sorted and disentangled once so the atlas can binary-search.
  return resolveRangeOverlaps(out).kept
}

const STORAGE_KEY = 'wrustty.terminal-settings'
// Pre-rebrand key, read as a fallback; never written.
const PREVIOUS_STORAGE_KEY = 'wr-shell.terminal-settings'

const defaults: TerminalSettings = {
  copyOnSelect: true,
  rightClickPaste: true,
  closeOnDisconnect: true,
  autoReconnect: true,
  // Mirrors the backend's defaults, so Settings can render without a round
  // trip.
  reconnectMaxAttempts: 12,
  reconnectMaxSeconds: 300,
  logPlainText: true,
  autoLogSessions: false,
  logDirectory: '',
  proxyKind: 'none',
  proxyHost: '',
  proxyPort: 0,
  keybindings: {},
  notifyOnCommandComplete: true,
  bellMarksTab: true,
  bellSound: false,
  remoteNotifications: true,
  clipboardWriteFromRemote: true,
  fontFamily: FONT_STACKS[0].value,
  fontSize: DEFAULT_FONT_SIZE,
  fontWeight: 400,
  fontWeightBold: 700,
  lineHeightPercent: 120,
  letterSpacing: 0,
  // 16 MB: ~10,100 rows at 80 columns.
  scrollbackBudgetMB: 16,
  cursorStyle: 'block',
  cursorBlink: true,
  confirmCloseWithConnection: true,
  // Empty: the OS handler opens the user's own editor with no setup.
  externalEditor: '',
  autocompleteEnabled: false,
  autocompleteImportRemoteHistory: false,
  themeName: 'wRusTTY Dark',
  customThemes: [],
  restoreSessionsOnLaunch: false,
  backgroundOpacity: 1,
  // Off by default.
  unfocusedDimPercent: 0,
  unfocusedStyle: 'fade',
  unfocusedOpacityPercent: 45,
  vibrancyMode: 'off',
  textBlending: 'native',
  ligatures: false,
  fontFamilyBold: '',
  fontFamilyItalic: '',
  fontFamilyBoldItalic: '',
  fontFeatures: '',
  fontVariations: '',
  fontRanges: [],
}

/**
 * The look a first launch starts with, applied only when nothing is stored.
 * Kept out of `defaults`, which also fills fields missing from existing blobs,
 * so updates don't restyle configured installs.
 */
const firstRunAppearance: Partial<TerminalSettings> = {
  fontFamily: curatedStack('JetBrains Mono'),
  fontWeight: 200,
  fontWeightBold: 500,
  ligatures: true,
  textBlending: 'linear-corrected',
  cursorStyle: 'bar',
  themeName: 'Campbell',
  backgroundOpacity: 0.9,
  vibrancyMode: 'tabbed',
  unfocusedDimPercent: 6,
  unfocusedStyle: 'glass',
  unfocusedOpacityPercent: 55,
}

/**
 * Per-pane scrollback memory tiers offered in Settings, ascending, in MB of
 * total pane footprint. Lives here (not in `GhosttyEngine`) to avoid an import
 * cycle; `scrollbackTiers.test.ts` checks it matches the engine's budgets.
 */
export const SCROLLBACK_FOOTPRINT_TIERS_MB = [8, 16, 32, 64]

/**
 * Approximate rows each tier holds at 80 columns, used only to migrate a
 * stored row-count setting. Measured; see GhosttyEngine.
 */
const TIER_ROWS_AT_80_COLS: ReadonlyArray<readonly [tierMB: number, rows: number]> = [
  [8, 3788],
  [16, 10100],
  [32, 24617],
  [64, 49230],
]

/**
 * Migrates the old `scrollback` row count to a memory tier, rounding up so no
 * history is lost (values past the largest tier land on it). The field was
 * renamed because `{ ...defaults, ...parsed }` would have read 10,000 rows as
 * 10,000 MB.
 */
export function scrollbackTierForRows(rows: number): number {
  if (!Number.isFinite(rows)) return defaults.scrollbackBudgetMB
  for (const [tierMB, tierRows] of TIER_ROWS_AT_80_COLS) {
    if (rows <= tierRows) return tierMB
  }
  return TIER_ROWS_AT_80_COLS[TIER_ROWS_AT_80_COLS.length - 1][0]
}

/** Font size bounds, shared by the Settings slider and the zoom shortcuts. */
export const FONT_SIZE_RANGE = { min: 8, max: 24 } as const
/** Unfocused fade range; more than about 10% reads as too strong now that the
 *  window also changes color. Saved values above it clamp on load. */
export const UNFOCUSED_DIM_RANGE = { min: 0, max: 10 } as const
/** The slider's step; saved values are snapped to it on load. */
export const UNFOCUSED_DIM_STEP = 1
/** 'glass' mode's opacity slider. Lower floor than the focused slider since
 * seeing through an unused window is the point. */
export const UNFOCUSED_OPACITY_RANGE = { min: 20, max: 100 } as const
export const UNFOCUSED_OPACITY_STEP = 5

export type UnfocusedStyle = 'fade' | 'glass'
export const UNFOCUSED_STYLES: readonly UnfocusedStyle[] = ['fade', 'glass']

/** The settings the window should look like right now. Only 'glass' mode
 * changes anything: unfocused, it swaps in effect Off and the unfocused
 * opacity with no fade, so everything downstream treats it like that
 * configuration. */
export function unfocusedAppearance(
  settings: TerminalSettings,
  focused: boolean,
): TerminalSettings {
  if (focused || settings.unfocusedStyle !== 'glass') return settings
  return {
    ...settings,
    vibrancyMode: 'off',
    backgroundOpacity: settings.unfocusedOpacityPercent / 100,
    unfocusedDimPercent: 0,
  }
}
export const FONT_WEIGHT_RANGE = { min: 100, max: 900 } as const
/** 100 is a cell exactly as tall as the font size; less clips descenders. */
export const LINE_HEIGHT_PERCENT_RANGE = { min: 100, max: 200 } as const
export const LETTER_SPACING_RANGE = { min: -2, max: 8 } as const

/**
 * Reconnect bounds, mirroring `ATTEMPTS_RANGE` and `ELAPSED_SECONDS_RANGE` in
 * src-tauri/src/session_registry.rs (which enforces them), so Settings stores
 * what will actually be used.
 */
export const RECONNECT_ATTEMPTS_RANGE = { min: 1, max: 100 } as const
export const RECONNECT_SECONDS_RANGE = { min: 5, max: 3600 } as const

function clampSetting(value: unknown, fallback: number, range: { min: number; max: number }) {
  // Numbers only: `Number()` reads null, '' and [] as zero, which would clamp
  // to the range's minimum rather than the fallback.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), range.min), range.max)
}

/** The least an unfocused window's background will fade to. */
export const UNFOCUSED_OPACITY_FLOOR = 0.3

/** Translucent layers behind a connected terminal: App's root, Terminal's
 *  padding wrapper and the engine's cells. The tab strip is one layer; a blank
 *  pane and the active tab are two. */
export const TERMINAL_BACKGROUND_LAYERS = 3

/** The opacity each kind of background surface paints at. */
export interface BackgroundLayers {
  /** The window's own background (App's root). */
  root: number
  /** One surface standing in for the terminal's two layers (the active tab, a
   *  blank pane), so it composites the same. */
  overRoot: number
  /** Each of a connected terminal's two layers over the root. */
  terminal: number
}

/** The opacity of `layers` stacked copies of one translucent color. */
export function stackedOpacity(alpha: number, layers: number): number {
  return 1 - (1 - alpha) ** layers
}

/** The opacity each background surface should paint at now.
 *
 * Areas are stacked to different depths (tab strip: root only; blank pane or
 * active tab: two layers; connected terminal: three), and stacked layers
 * compound, so no single per-layer value fades them equally. The root fades by
 * exactly the dim, and the terminal's layers are solved so the terminal area
 * ends up exactly `dim` percent less opaque. Focused, every surface is the
 * configured opacity.
 *
 * The floor applies to the terminal area and scales everything together,
 * capped so a translucent window never firms up when unfocused. The acrylic
 * tint isn't faded (re-applying the native effect on every focus change would
 * clear it). */
export function effectiveBackgroundLayers(
  settings: Pick<TerminalSettings, 'backgroundOpacity' | 'unfocusedDimPercent'>,
  focused: boolean,
): BackgroundLayers {
  const alpha = settings.backgroundOpacity
  if (focused || settings.unfocusedDimPercent <= 0) {
    return { root: alpha, overRoot: stackedOpacity(alpha, 2), terminal: alpha }
  }

  const terminalSeen = stackedOpacity(alpha, TERMINAL_BACKGROUND_LAYERS)
  const floorScale = terminalSeen > 0 ? Math.min(1, UNFOCUSED_OPACITY_FLOOR / terminalSeen) : 1
  const scale = Math.max(1 - settings.unfocusedDimPercent / 100, floorScale)

  // Clamp to [0, alpha]; floating point lands a hair outside.
  const bound = (v: number) => Math.min(alpha, Math.max(0, v))

  const root = bound(alpha * scale)
  // What the root lets through.
  const throughRoot = 1 - root
  if (throughRoot <= 0) return { root, overRoot: 0, terminal: 0 }

  // Two layers over the root: 1 - (1 - root)(1 - t)^2 = scale * seen3.
  const terminal = bound(1 - Math.sqrt((1 - scale * terminalSeen) / throughRoot))
  // Not bounded by alpha: it stands in for two layers.
  return { root, overRoot: stackedOpacity(terminal, 2), terminal }
}

export function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(PREVIOUS_STORAGE_KEY)
    if (!raw) return { ...defaults, ...firstRunAppearance }
    const parsed = JSON.parse(raw)
    const merged = { ...defaults, ...parsed }
    // Convert a pre-tier `scrollback` row count once; the stale key is dropped
    // on the next save.
    if (parsed.scrollbackBudgetMB === undefined && parsed.scrollback !== undefined) {
      merged.scrollbackBudgetMB = scrollbackTierForRows(Number(parsed.scrollback))
    }
    // A non-tier value falls back to the default.
    if (!SCROLLBACK_FOOTPRINT_TIERS_MB.includes(merged.scrollbackBudgetMB)) {
      merged.scrollbackBudgetMB = defaults.scrollbackBudgetMB
    }
    // These size the grid and the face; zero or NaN would break rendering.
    merged.unfocusedDimPercent =
      Math.round(
        clampSetting(merged.unfocusedDimPercent, defaults.unfocusedDimPercent, UNFOCUSED_DIM_RANGE) /
          UNFOCUSED_DIM_STEP,
      ) * UNFOCUSED_DIM_STEP
    if (!UNFOCUSED_STYLES.includes(merged.unfocusedStyle)) {
      merged.unfocusedStyle = defaults.unfocusedStyle
    }
    merged.unfocusedOpacityPercent =
      Math.round(
        clampSetting(
          merged.unfocusedOpacityPercent,
          defaults.unfocusedOpacityPercent,
          UNFOCUSED_OPACITY_RANGE,
        ) / UNFOCUSED_OPACITY_STEP,
      ) * UNFOCUSED_OPACITY_STEP
    merged.fontSize = clampSetting(merged.fontSize, defaults.fontSize, FONT_SIZE_RANGE)
    merged.fontWeight = clampSetting(merged.fontWeight, defaults.fontWeight, FONT_WEIGHT_RANGE)
    merged.fontWeightBold = clampSetting(
      merged.fontWeightBold,
      defaults.fontWeightBold,
      FONT_WEIGHT_RANGE,
    )
    merged.lineHeightPercent = clampSetting(
      merged.lineHeightPercent,
      defaults.lineHeightPercent,
      LINE_HEIGHT_PERCENT_RANGE,
    )
    merged.letterSpacing = clampSetting(
      merged.letterSpacing,
      defaults.letterSpacing,
      LETTER_SPACING_RANGE,
    )
    merged.reconnectMaxAttempts = clampSetting(
      merged.reconnectMaxAttempts,
      defaults.reconnectMaxAttempts,
      RECONNECT_ATTEMPTS_RANGE,
    )
    merged.reconnectMaxSeconds = clampSetting(
      merged.reconnectMaxSeconds,
      defaults.reconnectMaxSeconds,
      RECONNECT_SECONDS_RANGE,
    )
    // An unknown blend mode would make the shader draw nothing.
    if (!TEXT_BLENDINGS.includes(merged.textBlending)) {
      merged.textBlending = defaults.textBlending
    }
    merged.keybindings = sanitizeKeybindings(merged.keybindings)
    if (!PROXY_KINDS.includes(merged.proxyKind)) merged.proxyKind = defaults.proxyKind
    if (typeof merged.proxyHost !== 'string') merged.proxyHost = defaults.proxyHost
    if (!Number.isInteger(merged.proxyPort) || merged.proxyPort < 0 || merged.proxyPort > 65535) {
      merged.proxyPort = defaults.proxyPort
    }
    if (typeof merged.logDirectory !== 'string') merged.logDirectory = defaults.logDirectory
    if (typeof merged.autoLogSessions !== 'boolean') merged.autoLogSessions = defaults.autoLogSessions
    const migrated = FONT_STACK_MIGRATIONS[merged.fontFamily]
    if (migrated !== undefined) merged.fontFamily = migrated
    if (typeof merged.ligatures !== 'boolean') merged.ligatures = defaults.ligatures
    // Non-strings would become "[object Object]" in CSS.
    for (const key of [
      'fontFamilyBold',
      'fontFamilyItalic',
      'fontFamilyBoldItalic',
      'fontFeatures',
      'fontVariations',
    ] as const) {
      if (typeof merged[key] !== 'string') merged[key] = defaults[key]
    }
    merged.fontRanges = sanitizeRanges(merged.fontRanges)
    // Malformed colors would reach the renderer as NaN.
    merged.customThemes = sanitizeCustomThemes(merged.customThemes)
    delete merged.scrollback
    setCustomThemes(merged.customThemes)
    return merged
  } catch {
    // An unreadable blob starts like a first launch.
    setCustomThemes(defaults.customThemes)
    return { ...defaults, ...firstRunAppearance }
  }
}

/** The proxy an SSH connection should use, or null. A kind with no host is
 * treated as none. */
export function proxyConfigFrom(
  settings: Pick<TerminalSettings, 'proxyKind' | 'proxyHost' | 'proxyPort'>,
): ProxyConfig | null {
  const host = settings.proxyHost.trim()
  if (settings.proxyKind === 'none' || !host) return null
  return {
    kind: settings.proxyKind,
    host,
    port: settings.proxyPort || DEFAULT_PROXY_PORT[settings.proxyKind],
  }
}

export function saveSettings(settings: TerminalSettings) {
  // Update the theme registry first, regardless of whether the write
  // succeeds, so the next render can resolve custom themes.
  setCustomThemes(settings.customThemes)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Best-effort; a settings-persistence failure shouldn't break the app.
  }
}
