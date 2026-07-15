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
    name: 'wr-shell Dark',
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
