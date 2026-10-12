import type { PathFlavor } from './pathDetect'
import type { CursorStyleSetting, TextBlending } from './settings'
import type { FontSelection } from './fontStack'
import type { RowText } from './ghostty/rowText'
import type { ModeSnapshot } from './ghostty/sessionModes'

/**
 * Structurally identical to xterm's `IDisposable`, declared here so the engine
 * interface doesn't depend on xterm (only the benchmark's comparison engine
 * uses it).
 */
export interface IDisposable {
  dispose(): void
}

/**
 * Width of the custom scrollbar's controls (`.term-scrollbar-inner` in
 * index.css). Shared because `Terminal.tsx` sizes the gutter overlay and an
 * engine fitting its grid must reserve the gutter (see `fitGrid`).
 */
export const SCROLLBAR_GUTTER_PX = 10

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
  /**
   * Turns off modes a far-end program left on (mouse reporting, Kitty keyboard,
   * alternate screen) without a full reset that would clear scrollback, so the
   * next session in the pane starts clean. Optional.
   */
  resetSessionModes?(): void
  /**
   * The same cleanup for a program that died with the connection up: capture
   * when a command starts, reset what it left on at the next prompt (from the
   * OSC 133 handler). See `sessionModes.leftoverModeReset`. Optional; the
   * snapshot is opaque.
   */
  captureModes?(): ModeSnapshot | null
  resetLeftoverModes?(before: ModeSnapshot): void
  paste(text: string): void
  /**
   * Whether `paste` can proceed without asking, or null when the engine can't
   * judge (the caller then counts lines).
   */
  isPasteSafe?(text: string): boolean | null
  /**
   * Whether Backspace sends `^H` instead of `^?` for this session. The engine's
   * job, since only it can tell keystrokes from mouse reports (where 0x7f is
   * column 95).
   */
  setBackspaceSendsCtrlH?(enabled: boolean | null | undefined): void
  /**
   * Whether making the pane taller may pull rows back from scrollback (the
   * default). False behind a ConPTY, which repaints its own buffer after a
   * resize and would overwrite them.
   */
  setResizePullsScrollback?(pull: boolean): void

  getSelection(): string
  onSelectionChange(cb: () => void): IDisposable

  /**
   * Everything the engine sends toward the wire: typing, paste, mouse reports,
   * focus reports and replies to host queries.
   *
   * **Bytes, not a string**: a legacy mouse report past column 95 isn't valid
   * UTF-8, and a decode/encode round trip would corrupt it.
   */
  onData(cb: (data: Uint8Array) => void): IDisposable
  /**
   * User-originated input only (typing and paste), a subset of `onData`. Use
   * this for anything that redirects input elsewhere.
   */
  onInput(cb: (data: Uint8Array) => void): IDisposable
  onWriteParsed(cb: () => void): IDisposable
  onScroll(cb: (newPos: number) => void): IDisposable
  onBufferChange(cb: (isAlternate: boolean) => void): IDisposable
  onBell(cb: () => void): IDisposable
  registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): IDisposable
  /**
   * `ESC c` (RIS) seen in the stream, for host-side state the engine doesn't
   * know about (e.g. a progress report). Register only while needed; see
   * `GhosttyEngine.registerResetHandler`.
   */
  registerResetHandler(cb: () => void): IDisposable

  resize(cols: number, rows: number): void
  /** Re-measures the container and updates the terminal size to fit. */
  fit(force?: boolean): void
  
  scrollLines(amount: number): void
  scrollToLine(line: number): void

  /** `background` replaces the theme background when given (the unfocused
   *  tint; see `TerminalSettings.backgroundOverride`). */
  setTheme(themeName: string, opacity: number, background?: string | null): void
  setFont(fonts: FontSelection, fontSize: number): void
  /** Per-pane scrollback memory tier in MB (8/16/32/64). Rows follow from this
   *  and the width; see `scrollbackBudgetBytesFor`. */
  setScrollbackBudget(footprintMB: number): void
  /** Scrollback bytes this engine was built with (fixed at construction). */
  readonly scrollbackBudgetBytes: number
  /** Default cursor shape and blink, until an application sets DECSCUSR. */
  setCursorStyle(style: CursorStyleSetting, blink: boolean): void
  /**
   * Color space glyph coverage is blended in. Optional: specific to this
   * renderer.
   */
  setTextBlending?(mode: TextBlending): void
  /**
   * Whether operator runs are shaped together for ligatures. Optional, likewise.
   */
  setLigatures?(on: boolean): void
  
  rebuildWebglRenderer(): void

  /**
   * Re-establish the input element's IME/input context after the window regains
   * focus (WebView2 can sever it, leaving printable keys dead). Optional.
   */
  resetInputContext?(): void

  /**
   * Report that the engine failed to start (or died). Optional: only engines
   * with asynchronous startup implement it; absence means "can't fail this
   * way", not "can't fail".
   */
  onInitError?(cb: (message: string) => void): IDisposable

  // Search Addon related
  search(query: string, options?: SearchOptions): void
  clearSearchDecorations(): void
  onSearchResult(cb: (result: SearchResult) => void): IDisposable

  /**
   * Keyboard selection ("mark mode"), a mode because modified arrows belong to
   * the running program. Optional as a group; absence means no keyboard
   * selection.
   */
  toggleMarkMode?(): void
  /**
   * Hide these spans' glyphs (paint them in their background color), or null to
   * show them; the history flicker's rendering (lib/historyFlicker.ts). Optional.
   */
  setHiddenSpans?(spans: { row: number; from: number; to: number }[] | null): void
  isMarkMode?(): boolean
  onMarkModeChange?(cb: (active: boolean) => void): IDisposable
  /**
   * The engine asks for text to be copied (mark mode). The clipboard is the
   * platform's, so the frontend does it.
   */
  onCopyRequest?(cb: (text: string) => void): IDisposable

  /**
   * Clickable URLs: the engine detects activation and the frontend opens the
   * URL (the platform's job). Optional as a group; `xtermEngine` omits it.
   */
  onLinkActivate?(cb: (url: string) => void): IDisposable
  /**
   * Hint mode: labels over every link, opened by typing a label. The only link
   * path that works while a program owns the mouse.
   */
  toggleHintMode?(): void
  isHintMode?(): boolean
  onHintModeChange?(cb: (active: boolean) => void): IDisposable
  /** Cell size in CSS pixels, for placing DOM overlays; null before the renderer
   * exists. */
  cellSize?(): { width: number; height: number } | null
  /** Rebuild the read snapshot before `cursorCell`/`readRowText` when not
   * riding on a drawn frame. */
  syncReadState?(): void
  /** The terminal cursor in absolute buffer coordinates (stable as output
   * scrolls). With `readRowText`, lets prompt input be read off the screen; see
   * lib/promptInput.ts. */
  cursorCell?(): { x: number; y: number }
  /**
   * The text of rows `fromAbs..=toAbs` (absolute), with per-column offsets for
   * grapheme clusters and wide characters.
   */
  readRowText?(fromAbs: number, toAbs: number): RowText[]

  /**
   * Everything copy reads, as a diagnostic dump; see `GhosttyEngine.dumpState`.
   */
  dumpState?(): string

  /** The URL under a pointer event, for a context menu. */
  linkAtPointer?(e: MouseEvent): string | null
  /** Open a URL from `linkAtPointer`, with the same scheme check as every other
   *  route. */
  openLink?(url: string): void
  /**
   * File paths as links, in the pane host's syntax (null turns them off). The
   * frontend resolves the activated text on the remote host. Optional as a group.
   */
  setPathLinks?(flavor: PathFlavor | null): void
  onPathActivate?(cb: (path: string) => void): IDisposable
  /** The path under a pointer event, as written, for a context menu. */
  pathAtPointer?(e: MouseEvent): string | null
}
