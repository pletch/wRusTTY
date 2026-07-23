import type { IDisposable } from '@xterm/xterm'

export interface SearchOptions {
  caseSensitive?: boolean
  regex?: boolean
  incremental?: boolean
  back?: boolean
}

export interface SearchResult {
  index: number
  count: number
}

export interface TerminalEngine {
  readonly cols: number
  readonly rows: number
  readonly scrollbackLength: number
  readonly viewportY: number

  mount(container: HTMLElement): void
  dispose(): void
  focus(): void
  refresh(start: number, end: number): void

  write(data: Uint8Array | string): void
  writeln(data: string): void
  paste(text: string): void

  getSelection(): string
  onSelectionChange(cb: () => void): IDisposable

  onData(cb: (data: string) => void): IDisposable
  onWriteParsed(cb: () => void): IDisposable
  onScroll(cb: (newPos: number) => void): IDisposable
  onBufferChange(cb: (isAlternate: boolean) => void): IDisposable
  onBell(cb: () => void): IDisposable
  registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): IDisposable

  resize(cols: number, rows: number): void
  /** Re-measures the container and updates the terminal size to fit. */
  fit(force?: boolean): void
  
  scrollLines(amount: number): void
  scrollToLine(line: number): void

  setTheme(themeName: string, opacity: number): void
  setFont(fontFamily: string, fontSize: number): void
  setScrollback(scrollback: number): void
  
  rebuildWebglRenderer(): void

  // Search Addon related
  search(query: string, options?: SearchOptions): void
  clearSearchDecorations(): void
  onSearchResult(cb: (result: SearchResult) => void): IDisposable
}
