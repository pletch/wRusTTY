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

export function findTheme(name: string): TerminalTheme {
  return PRESET_THEMES.find((t) => t.name === name) ?? PRESET_THEMES[0]
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
  const [r, g, b] = hexToRgb(theme.background)
  // Rec. 709 luma. The exact coefficients matter little at this job — the
  // question is only "is this closer to black or to white" — but a plain
  // channel average would call Solarized Dark (#002b36, two thirds of its
  // light in the blue channel) lighter than it looks.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const tone = luma < 128 ? 255 : 0
  return `rgba(${tone}, ${tone}, ${tone}, ${STRIP_OVERLAY_ALPHA})`
}

/** Same color as an (r, g, b, a 0-255) tuple, for window-vibrancy's acrylic
 * tint — a separate, OS-compositor-level parameter from the DOM alpha
 * above, but kept in sync with it so the whole window reads as one
 * consistent translucency rather than two different alpha layers. */
export function backgroundTint(theme: TerminalTheme, opacity: number): [number, number, number, number] {
  const [r, g, b] = hexToRgb(theme.background)
  return [r, g, b, Math.round(opacity * 255)]
}
