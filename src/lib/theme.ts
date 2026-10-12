export interface TerminalTheme {
  name: string
  background: string
  foreground: string
  cursor: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const PRESET_THEMES: TerminalTheme[] = [
  {
    name: 'wRusTTY Dark',
    background: '#16171d',
    foreground: '#e5e4e7',
    cursor: '#e5e4e7',
    black: '#1f2028',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#c8ccd4',
    brightBlack: '#4b4f5b',
    brightRed: '#e88fa2',
    brightGreen: '#b2e59e',
    brightYellow: '#f0d68c',
    brightBlue: '#8cc6f0',
    brightMagenta: '#d9a3e8',
    brightCyan: '#7cd0dc',
    brightWhite: '#ffffff',
  },
  {
    name: 'Dracula',
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  {
    name: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  {
    name: 'Solarized Dark',
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  {
    name: 'Campbell',
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
  {
    name: 'Gruvbox Dark',
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  {
    name: 'Tokyo Night',
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  {
    name: 'Catppuccin Mocha',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  {
    name: 'One Half Dark',
    background: '#282c34',
    foreground: '#dcdfe4',
    cursor: '#a3b3cc',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#dcdfe4',
    brightBlack: '#5a6374',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#dcdfe4',
  },
  {
    name: 'Solarized Light',
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#657b83',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  {
    name: 'Light',
    background: '#ffffff',
    foreground: '#1f2028',
    cursor: '#1f2028',
    black: '#1f2028',
    red: '#c4453a',
    green: '#3a8f3a',
    yellow: '#a3720a',
    blue: '#2266c4',
    magenta: '#9b3fa8',
    cyan: '#1a8b9e',
    white: '#6a6f7a',
    brightBlack: '#8a8f9a',
    brightRed: '#e0685c',
    brightGreen: '#4fae4f',
    brightYellow: '#c98f1f',
    brightBlue: '#4a86e0',
    brightMagenta: '#bb5fc8',
    brightCyan: '#2ba9be',
    brightWhite: '#000000',
  },
]

/** Every color field of a theme, in editor order: the three non-palette
 * colors, the eight ANSI colors, then their bright halves. Written out because
 * stored themes carry arbitrary key order and `name` isn't a color. Both the
 * editor and the loader's validation walk this list; `theme.test.ts` checks it
 * matches `TerminalTheme`. */
export const THEME_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number]

/** The three non-palette colors, labeled by what they paint. */
export const SURFACE_FIELDS: ReadonlyArray<{ label: string; key: ThemeColorKey }> = [
  { label: 'Background', key: 'background' },
  { label: 'Text', key: 'foreground' },
  { label: 'Cursor', key: 'cursor' },
]

/**
 * The palette as eight colors, each with its normal and bright slot side by
 * side, which keeps labels to one short word in a narrow column.
 */
export const PALETTE_ROWS: ReadonlyArray<{
  label: string
  normal: ThemeColorKey
  bright: ThemeColorKey
}> = [
  { label: 'Black', normal: 'black', bright: 'brightBlack' },
  { label: 'Red', normal: 'red', bright: 'brightRed' },
  { label: 'Green', normal: 'green', bright: 'brightGreen' },
  { label: 'Yellow', normal: 'yellow', bright: 'brightYellow' },
  { label: 'Blue', normal: 'blue', bright: 'brightBlue' },
  { label: 'Magenta', normal: 'magenta', bright: 'brightMagenta' },
  { label: 'Cyan', normal: 'cyan', bright: 'brightCyan' },
  { label: 'White', normal: 'white', bright: 'brightWhite' },
]

/**
 * The user's own themes, which `findTheme` resolves alongside the presets. A
 * module-level registry because some callers hold only a theme name
 * (`GhosttyEngine`, the benchmark harness). Kept in step synchronously by
 * `loadSettings` and `saveSettings`.
 */
let customThemes: readonly TerminalTheme[] = []

export function setCustomThemes(themes: readonly TerminalTheme[]) {
  customThemes = themes
}

export function getCustomThemes(): readonly TerminalTheme[] {
  return customThemes
}

/** The theme a name refers to, presets first (a custom theme can't shadow a
 * built-in). An unknown name falls back to the default. */
export function findTheme(name: string): TerminalTheme {
  return (
    PRESET_THEMES.find((t) => t.name === name) ??
    customThemes.find((t) => t.name === name) ??
    PRESET_THEMES[0]
  )
}

/** Whether this is a 6-digit `#rrggbb` string, the only form `hexToRgb` reads
 * and `<input type="color">` emits. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * Custom themes from storage, made safe to render. Per field, like the rest of
 * `loadSettings`: a bad color falls back to the default theme's. Only an entry
 * with no usable name is dropped. Names are made unique and never collide with
 * a preset; later duplicates are renamed.
 */
export function sanitizeCustomThemes(value: unknown): TerminalTheme[] {
  if (!Array.isArray(value)) return []
  const fallback = PRESET_THEMES[0]
  const taken = new Set(PRESET_THEMES.map((t) => t.name))
  const out: TerminalTheme[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Partial<TerminalTheme>
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue
    const theme = { name: uniqueThemeName(raw.name.trim(), taken) } as TerminalTheme
    for (const key of THEME_COLOR_KEYS) {
      theme[key] = isHexColor(raw[key]) ? raw[key].toLowerCase() : fallback[key]
    }
    taken.add(theme.name)
    out.push(theme)
  }
  return out
}

/** `name` if nothing has it, else `name 2`, `name 3`, and so on. */
export function uniqueThemeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** An editable copy of `theme` under an unused name: how every custom theme
 * starts. */
export function copyOfTheme(theme: TerminalTheme, existing: readonly TerminalTheme[]): TerminalTheme {
  const taken = new Set([...PRESET_THEMES, ...existing].map((t) => t.name))
  return { ...theme, name: uniqueThemeName(`${theme.name} copy`, taken) }
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace('#', '')
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}

/** `theme.background` as #RRGGBBAA with the given alpha (0-1), for xterm's
 * theme (with `allowTransparency`) and the DOM chrome around it, so the layers
 * match. Hex8 hits xterm's color parser fast path, unlike `rgba()`. */
export function backgroundWithOpacity(theme: TerminalTheme, opacity: number): string {
  const alphaHex = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0')
  return `${theme.background}${alphaHex}`
}

/** The tab strip overlay's alpha: roughly 15-20 levels on any background. */
const STRIP_OVERLAY_ALPHA = 0.08

/** The wash the tab strip is painted with, over the window background.
 *
 * Added away from the background (lighter on dark themes, as in Windows
 * Terminal) rather than multiplied, which has nowhere to go on near-black and
 * takes a slab out of white. An overlay so a translucent window stays
 * translucent. */
export function stripOverlay(theme: TerminalTheme): string {
  return wash(theme, STRIP_OVERLAY_ALPHA)
}

/** The layer a quiet tab lays over the terminal's color on hover: half the
 * strip's wash over the background (the caller sets the background color), so
 * the tab sits midway between strip and active tab.
 *
 * An image rather than a color so the two can be separate properties: in one
 * `background` shorthand Chrome drops the color. A one-stop gradient is a flat
 * layer. */
export function tabHoverWash(theme: TerminalTheme): string {
  const half = wash(theme, STRIP_OVERLAY_ALPHA / 2)
  return `linear-gradient(${half}, ${half})`
}

/** The tab strip's color as a solid hex (background plus wash). Unfocused
 * windows are painted in it (see `effectiveBackgroundLayers` in settings.ts). */
export function stripColor(theme: TerminalTheme): string {
  const tone = backgroundIsDark(theme) ? 255 : 0
  const mix = (c: number) => Math.round(c + (tone - c) * STRIP_OVERLAY_ALPHA)
  return `#${hexToRgb(theme.background)
    .map((c) => mix(c).toString(16).padStart(2, '0'))
    .join('')}`
}

/** A translucent black or white, whichever this theme's background is
 * further from, at the given alpha. */
function wash(theme: TerminalTheme, alpha: number): string {
  const tone = backgroundIsDark(theme) ? 255 : 0
  return `rgba(${tone}, ${tone}, ${tone}, ${alpha})`
}

/** Whether this theme's background is nearer black than white, which decides
 * the tone of everything painted around the terminal. Rec. 709 luma; a plain
 * average would misjudge Solarized Dark. */
function backgroundIsDark(theme: TerminalTheme): boolean {
  const [r, g, b] = hexToRgb(theme.background)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/** The tone the app's chrome (labels, hairlines, hover washes) is drawn in, as
 * the RGB triplet Tailwind's `chrome` color reads from `--chrome-rgb`. Text on
 * a saturated accent fill stays white, since it contrasts with the button. */
export function chromeRgb(theme: TerminalTheme): string {
  return backgroundIsDark(theme) ? '255 255 255' : '0 0 0'
}

/** How far a floating surface sits from the terminal behind it, in levels per
 * channel. */
const SURFACE_LEVELS = 10

/**
 * The tone of every floating surface (dialogs, menus, popovers, toasts), as
 * the triplet Tailwind's `surface` color reads from `--surface-rgb`. A flat
 * step away from the background, like `stripOverlay`. Opaque, since these
 * float over arbitrary terminal content.
 */
export function surfaceRgb(theme: TerminalTheme): string {
  const step = backgroundIsDark(theme) ? SURFACE_LEVELS : -SURFACE_LEVELS
  return hexToRgb(theme.background)
    .map((channel) => Math.min(255, Math.max(0, channel + step)))
    .join(' ')
}

/**
 * The page's `color-scheme`, so browser-drawn widgets (range tracks,
 * `<select>` drop-downs, scrollbars) follow the terminal theme rather than the
 * OS preference.
 */
export function themeColorScheme(theme: TerminalTheme): 'dark' | 'light' {
  return backgroundIsDark(theme) ? 'dark' : 'light'
}

/** The background as an (r, g, b, a 0-255) tuple for window-vibrancy's
 * acrylic tint, kept in sync with the DOM alpha. */
export function backgroundTint(theme: TerminalTheme, opacity: number): [number, number, number, number] {
  const [r, g, b] = hexToRgb(theme.background)
  return [r, g, b, Math.round(opacity * 255)]
}
