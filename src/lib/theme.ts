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

/** Every colour field of a theme, in the order the editor lays them out:
 * the three that are not palette entries, then the eight ANSI colours, then
 * their bright halves.
 *
 * Written out rather than taken from `Object.keys` of a preset, for two
 * reasons: a custom theme parsed back out of storage carries whatever key
 * order it happened to be written with, and `name` is not a colour. This is
 * the list both the editor's grid and the loader's validation walk, so a
 * field added to `TerminalTheme` and forgotten here is a field the editor
 * cannot reach — `theme.test.ts` checks the two agree. */
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

/** The three colours that are not palette entries, named for what they
 *  paint rather than for their field: nobody choosing a colour thinks of
 *  the background as "background" and of black as "black" in the same
 *  breath. */
export const SURFACE_FIELDS: ReadonlyArray<{ label: string; key: ThemeColorKey }> = [
  { label: 'Background', key: 'background' },
  { label: 'Text', key: 'foreground' },
  { label: 'Cursor', key: 'cursor' },
]

/**
 * The palette, as the eight colours it actually is, each with its normal and
 * bright slot side by side.
 *
 * Laid out this way because the alternative -- one flat list of nineteen
 * fields -- has to write "Bright magenta" in a label column narrow enough
 * that it arrives as "Bright ma...", and "Bright bla..." and "Bright blue"
 * are then the same string. Pairing them says which is which by position and
 * leaves the label as one short word. It is also how a palette is actually
 * organised, so the editor stops fighting the thing it is editing.
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
 * The user's own themes, which `findTheme` resolves alongside the presets.
 *
 * A module-level registry rather than an argument, because the callers that
 * need to resolve a name are not all places a settings object reaches:
 * `GhosttyEngine` holds a theme *name* and nothing else, and the benchmark
 * harness builds an xterm theme from a name with no React tree around it.
 * Threading a list through all of them to serve a feature none of them have
 * an opinion about would cost more than it explains.
 *
 * Kept in step by `loadSettings` and `saveSettings`, which between them are
 * every path that can change what themes exist, and both of which are
 * synchronous — so a `findTheme` in the render that follows a save already
 * sees the theme that save created.
 */
let customThemes: readonly TerminalTheme[] = []

export function setCustomThemes(themes: readonly TerminalTheme[]) {
  customThemes = themes
}

export function getCustomThemes(): readonly TerminalTheme[] {
  return customThemes
}

/** The theme this name refers to, presets first: a custom theme can never
 * shadow a built-in one, whatever it calls itself. An unknown name — a
 * custom theme that has since been deleted, or a blob from a newer version —
 * lands on the default rather than leaving the terminal unpainted. */
export function findTheme(name: string): TerminalTheme {
  return (
    PRESET_THEMES.find((t) => t.name === name) ??
    customThemes.find((t) => t.name === name) ??
    PRESET_THEMES[0]
  )
}

/** Whether this is a 6-digit `#rrggbb` string — the only form `hexToRgb`
 * reads, and the only form `<input type="color">` emits. Anything else
 * parses to NaN components (see `hexToRgb`), which is a colour no renderer
 * can do anything sensible with, so the loader substitutes rather than
 * passing it on. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * Custom themes as they come back out of storage, made safe to render.
 *
 * Hand-edited, half-written and version-skewed blobs all arrive here. The
 * rule is per-field, matching how the rest of `loadSettings` treats a bad
 * value: a colour that is not a colour falls back to the default theme's,
 * so a user whose file lost one field gets that field reset rather than the
 * theme they built deleted out from under them. Only an entry with no
 * usable name at all is dropped, since a nameless theme is one the picker
 * cannot offer and `findTheme` can never resolve.
 *
 * Names are made unique, and never collide with a preset: `themeName` is a
 * name, so two themes sharing one means the second is unreachable. Later
 * duplicates are the ones renamed.
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

/** An editable copy of `theme` under a name nothing else is using — how
 * every custom theme starts, since building one from a palette that already
 * works is a far shorter road than filling in nineteen colours from black. */
export function copyOfTheme(theme: TerminalTheme, existing: readonly TerminalTheme[]): TerminalTheme {
  const taken = new Set([...PRESET_THEMES, ...existing].map((t) => t.name))
  return { ...theme, name: uniqueThemeName(`${theme.name} copy`, taken) }
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace('#', '')
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}

/** `theme.background` as an 8-digit #RRGGBBAA hex string carrying the given
 * alpha (0-1) — used both for xterm's own theme (with `allowTransparency`
 * on, it respects alpha instead of flattening to opaque) and for the DOM
 * chrome painted around it, so the two layers match. Hex8 rather than
 * `rgba()`: xterm's color parser matches hex on an exact fast path, while
 * `rgba()` goes through a separate regex — functionally equivalent for the
 * alpha values this app actually produces, but hex sidesteps that second
 * path entirely. */
export function backgroundWithOpacity(theme: TerminalTheme, opacity: number): string {
  const alphaHex = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0')
  return `${theme.background}${alphaHex}`
}

/** How much of the overlay below the tab strip gets, as a 0-1 alpha. Flat
 * addition of roughly 15-20 levels on any background, which is enough to
 * separate two surfaces and little enough not to look like a panel. */
const STRIP_OVERLAY_ALPHA = 0.08

/** The wash the tab strip is painted with, over the window's own background,
 * as a CSS color.
 *
 * Which way it goes depends on how dark the theme is, because a fixed
 * direction cannot work for all of them. This was `bg-black/20` — a
 * *multiply*, which scales with what it is given and so has nowhere to go on
 * a background that is already near black: Campbell (#0c0c0c) came out two
 * levels darker, invisible, and the strip, the quiet tabs and the active tab
 * all collapsed into one flat field. The same 20% took 51 levels out of the
 * Light theme, a slab. Adding a fixed amount instead, away from whatever the
 * background is, lands within a few levels of the same separation on every
 * preset.
 *
 * On a dark theme this puts the strip *lighter* than the terminal rather
 * than darker, which is the arrangement Windows Terminal uses.
 *
 * Returned as an overlay rather than a finished colour so the strip keeps
 * compositing over the window the way it always has, and a translucent
 * window stays translucent up here too. */
export function stripOverlay(theme: TerminalTheme): string {
  return wash(theme, STRIP_OVERLAY_ALPHA)
}

/** The layer a quiet tab lays over the terminal's colour while the pointer
 * is over it: half the strip's wash, which puts the tab midway between the
 * strip it sits in and the active tab it would become.
 *
 * Half a wash *over the background* rather than any amount over the strip,
 * because washing the strip further only ever moves away from the active
 * tab — on a dark theme that made hovering a tab lighter when the thing it
 * is reaching towards is darker. Painting the background again underneath
 * (the caller sets it as the background-color) hides the strip, and this
 * then measures from the same place the active tab does.
 *
 * An image rather than a finished colour so the two can be set as separate
 * properties. As one `background` shorthand — `linear-gradient(...), <color>`
 * — Chrome keeps the gradient and silently drops the colour, leaving the
 * wash sitting on the strip after all, which is the bug this is shaped to
 * avoid. A one-stop gradient is how CSS states a flat layer. */
export function tabHoverWash(theme: TerminalTheme): string {
  const half = wash(theme, STRIP_OVERLAY_ALPHA / 2)
  return `linear-gradient(${half}, ${half})`
}

/** The tab strip's own colour, as a solid hex: the theme's background with
 * the strip's wash already laid over it. What an unfocused window's surfaces
 * are painted in — see `effectiveBackgroundLayers` in settings.ts — so that
 * clicking away moves the window towards the lighter strip and inactive tabs
 * rather than towards whatever happens to be behind it. */
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

/** Whether this theme's background is nearer black than white — the one
 * question everything the app paints *around* the terminal has to answer,
 * since all of it is drawn as some alpha of a single tone over that
 * background.
 *
 * Rec. 709 luma. The exact coefficients matter little for a yes/no this
 * coarse, but a plain channel average would call Solarized Dark (#002b36,
 * two thirds of its light in the blue channel) lighter than it looks. */
function backgroundIsDark(theme: TerminalTheme): boolean {
  const [r, g, b] = hexToRgb(theme.background)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/** The tone the app's chrome — every label, hairline and hover wash outside
 * the terminal itself — is drawn in, as the space-separated RGB triplet
 * Tailwind's `chrome` color reads from `--chrome-rgb`.
 *
 * All of that chrome was a literal `white/N`, which is right over five of
 * the six presets and invisible over the sixth: a `text-white/45` label on
 * the Light theme's #ffffff is one nobody can read. Naming the tone once and
 * flipping it here is what lets one set of classes serve both.
 *
 * Text sitting on a saturated accent fill — a sky or a red button — stays
 * literally white, since what it needs contrast against is the button, not
 * the window. */
export function chromeRgb(theme: TerminalTheme): string {
  return backgroundIsDark(theme) ? '255 255 255' : '0 0 0'
}

/** How far a floating surface sits from the terminal behind it, in levels
 * per channel.
 *
 * Ten because that is what the hardcoded #1f2028 already was: against
 * wRusTTY Dark's #16171d it is (9, 9, 11) lighter. Deriving it rather than
 * keeping the literal changes nothing on the dark presets -- the default
 * lands within two levels of the colour it replaces -- and is what lets a
 * light theme get a light dialog instead of a dark one. */
const SURFACE_LEVELS = 10

/**
 * The tone every floating surface is painted with -- dialogs, menus,
 * popovers, toasts -- as the triplet Tailwind's `surface` color reads from
 * `--surface-rgb`.
 *
 * All of it was a literal `bg-[#1f2028]`, in twenty-one places. That is
 * right over the dark presets and unreadable over a light one: `chromeRgb`
 * flips the text inside these surfaces to black, so a Light or Solarized
 * Light theme got black labels on a near-black dialog. Naming the surface
 * and moving it with the theme is what lets one set of classes serve both,
 * exactly as `chrome` already does for the text.
 *
 * A flat step *away from* the background rather than a multiply, and for
 * the same reason `stripOverlay` is: a multiply has nowhere to go on
 * Campbell's #0c0c0c, and takes a slab out of a white one.
 *
 * Opaque, unlike the washes above. These surfaces float over arbitrary
 * terminal content, and one you can read the scrollback through is one
 * nobody can read.
 */
export function surfaceRgb(theme: TerminalTheme): string {
  const step = backgroundIsDark(theme) ? SURFACE_LEVELS : -SURFACE_LEVELS
  return hexToRgb(theme.background)
    .map((channel) => Math.min(255, Math.max(0, channel + step)))
    .join(' ')
}

/**
 * What to tell the engine the page's own colour scheme is, so the widgets
 * this app does not paint itself follow the theme too.
 *
 * A range track, a `<select>` drop-down and a native scrollbar are drawn by
 * the browser, not by any class here, and they take their light or dark
 * appearance from `color-scheme`. That was the static `light dark` in
 * index.css, which resolves against the *OS* preference — so on a machine
 * set to dark, picking a light terminal theme left a black slider track and
 * a black drop-down sitting in a cream dialog.
 *
 * The terminal theme is the honest answer here: it is what the surface
 * around these widgets is painted from.
 */
export function themeColorScheme(theme: TerminalTheme): 'dark' | 'light' {
  return backgroundIsDark(theme) ? 'dark' : 'light'
}

/** Same color as an (r, g, b, a 0-255) tuple, for window-vibrancy's acrylic
 * tint — a separate, OS-compositor-level parameter from the DOM alpha
 * above, but kept in sync with it so the whole window reads as one
 * consistent translucency rather than two different alpha layers. */
export function backgroundTint(theme: TerminalTheme, opacity: number): [number, number, number, number] {
  const [r, g, b] = hexToRgb(theme.background)
  return [r, g, b, Math.round(opacity * 255)]
}
