import { PRESET_THEMES, THEME_COLOR_KEYS, type TerminalTheme, type ThemeColorKey } from './theme'

/**
 * Reading a color scheme written for iTerm2 or VS Code. Pure text in, palette
 * out, so it's testable against real files' shapes.
 *
 * Takes what the file names and fills the rest from the default theme,
 * reporting which were filled; neither format owes this app a full palette.
 */

/** The formats this understands, as named in messages to the user. */
export type ThemeFormat = 'iTerm2' | 'VS Code'

export interface ParsedTheme {
  /** Complete and ready to use; `missing` says what didn't come from the file. */
  theme: TerminalTheme
  /** Colors the file did not name, filled from the default theme. */
  missing: ThemeColorKey[]
  format: ThemeFormat
}

/** Fills gaps: the one palette known to be complete. */
const FALLBACK = PRESET_THEMES[0]

type PartialPalette = Partial<Record<ThemeColorKey, string>>

/**
 * Reads `text` as whichever format it turns out to be, sniffed from content
 * since the extension is the likeliest thing to be wrong.
 *
 * `fallbackName` is used when the file carries no name (every `.itermcolors`
 * and many VS Code themes). Throws with a message meant for a toast.
 */
export function parseThemeFile(text: string, fallbackName: string): ParsedTheme {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('that file is empty')

  const { name, colors, format } = trimmed.startsWith('<')
    ? { ...parseItermColors(trimmed), format: 'iTerm2' as const }
    : { ...parseVsCodeTheme(trimmed), format: 'VS Code' as const }

  const named = THEME_COLOR_KEYS.filter((key) => colors[key] !== undefined)
  // Any XML parses as a plist and any object as a VS Code theme; naming no
  // color at all means it isn't a color scheme.
  if (named.length === 0) {
    throw new Error(`that ${format} file doesn't contain any terminal colors`)
  }

  const theme = { name: name?.trim() || fallbackName } as TerminalTheme
  for (const key of THEME_COLOR_KEYS) theme[key] = colors[key] ?? FALLBACK[key]
  return {
    theme,
    missing: THEME_COLOR_KEYS.filter((key) => colors[key] === undefined),
    format,
  }
}

/**
 * A path's file name without its extension. Splits on both separators, since
 * a WSL or network path can mix them.
 */
export function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.[^.]*$/, '') || base
}

// --- iTerm2 -----------------------------------------------------------------

/**
 * Which plist key feeds which slot. `Ansi 0`-`15` are the palette in the usual
 * order. iTerm's other colors (selection, badge, bold, link, light mode) have
 * nowhere to go here.
 */
const ITERM_KEYS: ReadonlyArray<readonly [plistKey: string, slot: ThemeColorKey]> = [
  ['Background Color', 'background'],
  ['Foreground Color', 'foreground'],
  ['Cursor Color', 'cursor'],
  ['Ansi 0 Color', 'black'],
  ['Ansi 1 Color', 'red'],
  ['Ansi 2 Color', 'green'],
  ['Ansi 3 Color', 'yellow'],
  ['Ansi 4 Color', 'blue'],
  ['Ansi 5 Color', 'magenta'],
  ['Ansi 6 Color', 'cyan'],
  ['Ansi 7 Color', 'white'],
  ['Ansi 8 Color', 'brightBlack'],
  ['Ansi 9 Color', 'brightRed'],
  ['Ansi 10 Color', 'brightGreen'],
  ['Ansi 11 Color', 'brightYellow'],
  ['Ansi 12 Color', 'brightBlue'],
  ['Ansi 13 Color', 'brightMagenta'],
  ['Ansi 14 Color', 'brightCyan'],
  ['Ansi 15 Color', 'brightWhite'],
]

function parseItermColors(text: string): { name?: string; colors: PartialPalette } {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  // DOM XML parsers report a syntax error as this element, not an exception.
  if (doc.querySelector('parsererror')) {
    throw new Error("that file isn't valid XML, so it isn't an iTerm color scheme")
  }
  const root = doc.querySelector('plist > dict')
  if (!root) throw new Error("that XML file isn't an iTerm color scheme")

  const entries = plistEntries(root)
  const colors: PartialPalette = {}
  for (const [plistKey, slot] of ITERM_KEYS) {
    const value = entries.get(plistKey)
    const rgb = value ? plistColor(value) : null
    if (rgb) colors[slot] = rgb
  }
  // `.itermcolors` files carry no name; iTerm uses the file name, as does this.
  return { colors }
}

/**
 * A plist `<dict>`'s children as a map. A dict is a flat run of alternating
 * key and value elements.
 */
function plistEntries(dict: Element): Map<string, Element> {
  const out = new Map<string, Element>()
  const children = Array.from(dict.children)
  for (let i = 0; i < children.length; i++) {
    if (children[i].tagName !== 'key') continue
    const value = children[i + 1]
    const key = children[i].textContent?.trim()
    // A trailing `<key>` with no value is skipped; the color reads as missing.
    if (key && value) out.set(key, value)
  }
  return out
}

/** One iTerm color dict as `#rrggbb`, or null if it isn't one. */
function plistColor(value: Element): string | null {
  const parts = plistEntries(value)
  const channels = ['Red Component', 'Green Component', 'Blue Component'].map((key) => {
    const el = parts.get(key)
    // `<integer>` is legal plist for an exact 0 or 1.
    if (!el || (el.tagName !== 'real' && el.tagName !== 'integer')) return NaN
    return Number(el.textContent)
  })
  if (channels.some((c) => !Number.isFinite(c))) return null

  // Display P3 read as sRGB would look desaturated, so it's converted. Anything
  // else, including "Calibrated" (Apple generic RGB, gamma 1.8), is taken as
  // sRGB, which is what hex-authored schemes meant.
  const space = parts.get('Color Space')?.textContent?.trim()
  const [r, g, b] = space === 'P3' ? p3ToSrgb(channels as [number, number, number]) : channels
  return rgbToHex(r, g, b)
}

/**
 * Display P3 to sRGB, as 0-1 components with the shared sRGB transfer curve:
 * linearize, apply the standard matrix, re-encode. Out-of-gamut results are
 * clamped. Rows sum to 1 (shared white point), so grays stay exact
 * (`themeImport.test.ts` pins this).
 */
function p3ToSrgb([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear)
  // Nine significant figures: a double can't hold more exactly, and rounding
  // makes the first two rows sum to exactly 1.
  return [
    1.22494018 * lr - 0.22494018 * lg,
    -0.04205695 * lr + 1.04205695 * lg,
    -0.01963766 * lr - 0.07863611 * lg + 1.09827378 * lb,
  ].map((channel) => linearToSrgb(Math.min(1, Math.max(0, channel)))) as [number, number, number]
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

/** 0-1 components as `#rrggbb`, clamped and rounded. */
function rgbToHex(r: number, g: number, b: number): string {
  const byte = (channel: number) =>
    Math.min(255, Math.max(0, Math.round(channel * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

// --- VS Code ----------------------------------------------------------------

/** Which workbench color feeds which slot. */
const VSCODE_KEYS: ReadonlyArray<readonly [colorKey: string, slot: ThemeColorKey]> = [
  ['terminal.background', 'background'],
  ['terminal.foreground', 'foreground'],
  ['terminalCursor.foreground', 'cursor'],
  ['terminal.ansiBlack', 'black'],
  ['terminal.ansiRed', 'red'],
  ['terminal.ansiGreen', 'green'],
  ['terminal.ansiYellow', 'yellow'],
  ['terminal.ansiBlue', 'blue'],
  ['terminal.ansiMagenta', 'magenta'],
  ['terminal.ansiCyan', 'cyan'],
  ['terminal.ansiWhite', 'white'],
  ['terminal.ansiBrightBlack', 'brightBlack'],
  ['terminal.ansiBrightRed', 'brightRed'],
  ['terminal.ansiBrightGreen', 'brightGreen'],
  ['terminal.ansiBrightYellow', 'brightYellow'],
  ['terminal.ansiBrightBlue', 'brightBlue'],
  ['terminal.ansiBrightMagenta', 'brightMagenta'],
  ['terminal.ansiBrightCyan', 'brightCyan'],
  ['terminal.ansiBrightWhite', 'brightWhite'],
]

/**
 * Where terminal colors come from when the theme doesn't name them. Most VS
 * Code themes leave `terminal.background` out and use the editor's, as VS
 * Code itself does.
 */
const VSCODE_FALLBACKS: ReadonlyArray<readonly [colorKey: string, slot: ThemeColorKey]> = [
  ['editor.background', 'background'],
  ['editor.foreground', 'foreground'],
  ['editorCursor.foreground', 'cursor'],
]

function parseVsCodeTheme(text: string): { name?: string; colors: PartialPalette } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new Error(`that file isn't valid JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error("that JSON file isn't a VS Code theme")
  }
  const root = parsed as Record<string, unknown>

  // A published theme uses `colors`, settings.json uses
  // `workbench.colorCustomizations`, and a pasted snippet is the bare map. Take
  // the first that holds a color, so an empty `colors` key doesn't win.
  const candidates = [root.colors, root['workbench.colorCustomizations'], root]
  const source =
    candidates.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        Object.keys(candidate).some((key) => key.startsWith('terminal') || key.startsWith('editor')),
    ) ?? {}

  const colors: PartialPalette = {}
  for (const [colorKey, slot] of VSCODE_KEYS) {
    const hex = normalizeHex(source[colorKey])
    if (hex) colors[slot] = hex
  }
  for (const [colorKey, slot] of VSCODE_FALLBACKS) {
    if (colors[slot] !== undefined) continue
    const hex = normalizeHex(source[colorKey])
    if (hex) colors[slot] = hex
  }
  return { name: typeof root.name === 'string' ? root.name : undefined, colors }
}

/**
 * A VS Code color as `#rrggbb`, from any of its four hex forms. Alpha is
 * dropped rather than blended: palette slots have none, and there's nothing
 * behind a terminal background here to show through.
 */
function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim()
  if (/^#[0-9a-fA-F]{3,4}$/.test(hex)) {
    const [r, g, b] = [hex[1], hex[2], hex[3]]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return hex.slice(0, 7).toLowerCase()
  return null
}

/**
 * Strips comments and trailing commas (VS Code's JSON dialect), which
 * `JSON.parse` rejects. One pass that tracks strings, since a regex would
 * break `"https://..."` and strings containing `,}`.
 */
function stripJsonComments(text: string): string {
  const out: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      out.push(char)
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out.push(char)
      continue
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      // Keep the newline so error positions stay on the right line.
      out.push('\n')
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    if (char === '}' || char === ']') {
      // Walk back over whitespace since the last real character; a comma there is
      // trailing.
      let last = out.length - 1
      while (last >= 0 && /\s/.test(out[last])) last--
      if (last >= 0 && out[last] === ',') out.splice(last, 1)
    }
    out.push(char)
  }
  return out.join('')
}
