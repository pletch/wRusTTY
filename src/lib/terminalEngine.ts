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

  /**
   * Re-establish the input element's connection to the OS input method after the
   * app window regains focus. WebView2 can leave a hidden textarea's IME/input
   * context severed on window deactivation so that a plain focus() no longer
   * delivers printable input (only keydown-routed keys like Enter still reach the
   * wire). Optional — engines whose input survives a window switch omit it.
   */
  resetInputContext?(): void

  /**
   * Report that the engine failed to start and will never draw anything.
   * Optional — only engines with asynchronous startup that can fail
   * (Ghostty, whose core is a WASM module fetched and compiled at
   * construction) implement it; xterm is ready the moment it is constructed.
   * Callers must treat its absence as "cannot fail this way", not as "cannot
   * fail".
   */
  onInitError?(cb: (message: string) => void): IDisposable

  // Search Addon related
  search(query: string, options?: SearchOptions): void
  clearSearchDecorations(): void
  onSearchResult(cb: (result: SearchResult) => void): IDisposable
}
