import type { CursorStyleSetting } from './settings'

/**
 * Structurally identical to xterm's `IDisposable`, declared here rather than
 * imported so the app's engine interface doesn't depend on the xterm package
 * at all — xterm exists in this repo only as the benchmark harness's
 * comparison engine, and this type was its last thread into `src/lib`.
 * xterm's own disposables still satisfy it, which is what `xtermEngine.ts`
 * relies on.
 */
export interface IDisposable {
  dispose(): void
}

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

  /**
   * Everything the engine sends towards the wire: typing, paste, mouse
   * tracking reports, DEC 1004 focus reports, and the replies the core
   * generates for host queries (DSR, DA, OSC colour). A single session's
   * writer wants all of it.
   */
  onData(cb: (data: string) => void): IDisposable
  /**
   * User-originated input only — typing and paste. A strict subset of
   * `onData`, and the one anything that *redirects* input has to use: a mouse
   * report carries this pane's geometry, and a query reply belongs to the host
   * that asked. Sending either somewhere else is wrong in both directions.
   */
  onInput(cb: (data: string) => void): IDisposable
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
  /** Default cursor shape and blink, until the remote application overrides it
   *  with its own DECSCUSR. */
  setCursorStyle(style: CursorStyleSetting, blink: boolean): void
  
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
   * construction) implement it; a synchronously-constructed engine has no
   * such failure mode and omits it.
   * Callers must treat its absence as "cannot fail this way", not as "cannot
   * fail".
   */
  onInitError?(cb: (message: string) => void): IDisposable

  // Search Addon related
  search(query: string, options?: SearchOptions): void
  clearSearchDecorations(): void
  onSearchResult(cb: (result: SearchResult) => void): IDisposable
}
