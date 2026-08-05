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

/**
 * Width of the custom scrollbar's visible controls, matching
 * `.term-scrollbar-inner` in index.css.
 *
 * Here rather than in either place that uses it, because both have to agree
 * and they sit in different layers: `Terminal.tsx` sizes the overlay that
 * masks the gutter, and an engine deriving its own column count has to
 * reserve that gutter (see `fitGrid`). While only the overlay knew the
 * number, the Ghostty grid ran underneath it and lost its last column.
 */
export const SCROLLBAR_GUTTER_PX = 8

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
  /**
   * Whether `paste` can be called without asking the user first, or null when
   * the engine cannot say. Optional because it is the vt core's judgement and
   * an engine without one has nothing to answer with — the caller falls back
   * to counting lines, which is the part of the rule that is obvious.
   */
  isPasteSafe?(text: string): boolean | null

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
  /** Per-pane scrollback memory tier in MB (8/16/32/64), as chosen in
   *  Settings. Depth in rows falls out of this and the pane's width rather than
   *  being set directly — see `scrollbackBudgetBytesFor`. */
  setScrollbackBudget(footprintMB: number): void
  /** Bytes of scrollback this engine was actually built with. Fixed at
   *  construction, so it can differ from the current setting. */
  readonly scrollbackBudgetBytes: number
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

  /**
   * Keyboard selection ("mark mode"): a mode rather than a shift-arrow binding,
   * because the modified arrows are sequences the running program owns.
   *
   * Optional as a group — an engine either takes the keyboard for selection or
   * it doesn't, and one that doesn't omits all four. Callers must treat their
   * absence as "no keyboard selection here", not as "not selecting right now".
   */
  toggleMarkMode?(): void
  isMarkMode?(): boolean
  onMarkModeChange?(cb: (active: boolean) => void): IDisposable
  /**
   * The engine is asking for text to be put on the clipboard — currently only
   * mark mode's copy. The engine has no clipboard of its own: the app's is
   * Tauri's, and reaching it from inside the engine would put a platform
   * dependency where there is otherwise none.
   */
  onCopyRequest?(cb: (text: string) => void): IDisposable

  /**
   * Clickable URLs: the engine detects them in its own buffer, decides when
   * one has been activated, and asks the frontend to open it — the same
   * division as `onCopyRequest`, and for the same reason. Opening a URL is
   * the platform's business, and the engine has no platform dependency.
   *
   * Optional as a group, like mark mode above: an engine either offers links
   * or it doesn't, and one that doesn't omits all three. `xtermEngine` — the
   * benchmark harness's comparison engine, and its only remaining user — is
   * exactly such an engine.
   */
  onLinkActivate?(cb: (url: string) => void): IDisposable
  /**
   * Hint mode: a label over every link on screen, opened by typing its label.
   * Part of the same optional group — and the only link path that works while
   * a full-screen program owns the mouse, or with no pointing device at all.
   */
  toggleHintMode?(): void
  isHintMode?(): boolean
  onHintModeChange?(cb: (active: boolean) => void): IDisposable
  /** The URL under a pointer event, for a context menu. */
  linkAtPointer?(e: MouseEvent): string | null
  /** Open a URL that came back from `linkAtPointer`. Goes through the engine
   *  rather than straight to the opener so every route takes the same scheme
   *  check. */
  openLink?(url: string): void
}
