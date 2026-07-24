import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'

import type { TerminalEngine, SearchOptions, SearchResult } from './terminalEngine'
import { findTheme, backgroundWithOpacity } from './theme'

const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a1c',
  matchOverviewRuler: '#d9a441',
  activeMatchBackground: '#d9a441',
  activeMatchColorOverviewRuler: '#ffd479',
}

function themeWithOpacity(themeName: string, opacity: number) {
  const theme = findTheme(themeName)
  return { ...theme, background: backgroundWithOpacity(theme, opacity) }
}

export interface EngineOptions {
  fontFamily: string
  fontSize: number
  scrollback: number
  themeName: string
  backgroundOpacity: number
}

export class XtermEngine implements TerminalEngine {
  private term: XTerm
  private fitAddon: FitAddon
  private searchAddon: SearchAddon
  private webglAddon: WebglAddon | null = null

  constructor(options: EngineOptions) {
    this.term = new XTerm({
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      scrollback: options.scrollback,
      allowTransparency: true,
      allowProposedApi: true,
      theme: themeWithOpacity(options.themeName, options.backgroundOpacity),
    })

    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)

    this.searchAddon = new SearchAddon()
    this.term.loadAddon(this.searchAddon)
  }

  get cols() { return this.term.cols }
  get rows() { return this.term.rows }
  get scrollbackLength() { return this.term.buffer.active.length }
  get viewportY() { return this.term.buffer.active.viewportY }

  mount(container: HTMLElement) {
    this.term.open(container)
    this.webglAddon = this.loadWebgl()
  }

  dispose() {
    this.term.dispose()
  }

  focus() {
    this.term.focus()
  }

  refresh(start: number, end: number) {
    this.term.refresh(start, end)
  }

  write(data: Uint8Array | string) {
    this.term.write(data)
  }

  /**
   * Writes and resolves when the parser has consumed it — xterm parses
   * asynchronously off its write queue, so this is the only fair way to time
   * its throughput against Ghostty's synchronous parse. Benchmark-only.
   */
  parse(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, () => resolve()))
  }

  writeln(data: string) {
    this.term.writeln(data)
  }

  paste(text: string) {
    this.term.paste(text)
  }

  getSelection() {
    return this.term.getSelection()
  }

  onSelectionChange(cb: () => void) {
    return this.term.onSelectionChange(cb)
  }

  onData(cb: (data: string) => void) {
    return this.term.onData(cb)
  }

  onWriteParsed(cb: () => void) {
    return this.term.onWriteParsed(cb)
  }

  /**
   * Fires after the renderer has painted a frame. Not part of the
   * `TerminalEngine` contract — the benchmark harness (src/bench) is the only
   * caller, and it needs a per-engine "a frame was drawn" signal to stop the
   * clock at presentation. xterm surfaces exactly this natively.
   */
  onRender(cb: () => void) {
    return this.term.onRender(() => cb())
  }

  /**
   * Whether the GPU (WebGL) renderer is actually in use, rather than the DOM
   * fallback WebglAddon drops to when a context can't be created. The harness
   * reports this so a "GPU" number measured on a software path is never
   * mistaken for the real thing.
   */
  get usingWebgl(): boolean {
    return this.webglAddon !== null
  }

  onScroll(cb: (newPos: number) => void) {
    return this.term.onScroll(cb)
  }

  onBufferChange(cb: (isAlternate: boolean) => void) {
    return this.term.buffer.onBufferChange(() => {
      cb(this.term.buffer.active.type === 'alternate')
    })
  }

  onBell(cb: () => void) {
    return this.term.onBell(cb)
  }

  registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>) {
    return this.term.parser.registerOscHandler(ident, cb)
  }

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows)
  }

  fit() {
    this.fitAddon.fit()
  }

  scrollLines(amount: number) {
    this.term.scrollLines(amount)
  }

  scrollToLine(line: number) {
    this.term.scrollToLine(line)
  }

  setTheme(themeName: string, opacity: number) {
    this.term.options.theme = themeWithOpacity(themeName, opacity)
  }

  setFont(fontFamily: string, fontSize: number) {
    this.term.options.fontFamily = fontFamily
    this.term.options.fontSize = fontSize
  }

  setScrollback(scrollback: number) {
    this.term.options.scrollback = scrollback
  }

  rebuildWebglRenderer() {
    if (this.webglAddon) {
      this.webglAddon.dispose()
      this.webglAddon = this.loadWebgl()
    }
  }

  private loadWebgl(): WebglAddon | null {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        if (this.webglAddon === addon) this.webglAddon = null
      })
      this.term.loadAddon(addon)
      return addon
    } catch {
      return null
    }
  }

  search(query: string, options?: SearchOptions) {
    if (!query) {
      this.clearSearchDecorations()
      return
    }
    const searchOpts = {
      caseSensitive: options?.caseSensitive ?? false,
      regex: options?.regex ?? false,
      incremental: options?.incremental ?? false,
      decorations: SEARCH_DECORATIONS,
    }
    if (options?.back) {
      this.searchAddon.findPrevious(query, searchOpts)
    } else {
      this.searchAddon.findNext(query, searchOpts)
    }
  }

  clearSearchDecorations() {
    this.searchAddon.clearDecorations()
  }

  onSearchResult(cb: (result: SearchResult) => void) {
    return this.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      cb({ index: resultIndex, count: resultCount })
    })
  }
}
