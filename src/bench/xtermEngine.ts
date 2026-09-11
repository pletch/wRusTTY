import type { CursorStyleSetting } from '../lib/settings'
/**
 * The xterm.js implementation of `TerminalEngine`. It lives under `src/bench/`
 * rather than `src/lib/` because it is no longer a renderer the app can be
 * asked to use — it is the **reference implementation** the Ghostty path is
 * measured and tested against: the second engine in the A/B harness, and the
 * oracle `gridSnapshot.ts` compares grid state with. See parity.ts's header
 * for the decision that put it here and what it costs.
 *
 * It still satisfies the full `TerminalEngine` interface, deliberately. That
 * interface is what makes the two comparable at all, and a cut-down version
 * would only be able to answer questions about the parts someone remembered
 * to keep.
 */
import { Terminal as XTerm } from '@xterm/xterm'
import { scrollbackBudgetBytesFor, estimateScrollbackRows } from '../lib/ghostty/GhosttyEngine'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'

import type { FontSelection } from '../lib/fontStack'
import type { TerminalEngine, SearchOptions, SearchResult } from '../lib/terminalEngine'
import { findTheme, backgroundWithOpacity } from '../lib/theme'

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

  onData(cb: (data: Uint8Array) => void) {
    // xterm hands out a string; the engine contract is bytes. UTF-8 is the
    // right encoding for everything xterm produces here, and this class never
    // reaches a wire anyway (see `onInput` below).
    return this.term.onData((s) => cb(new TextEncoder().encode(s)))
  }

  /**
   * Aliased to `onData`, which over-delivers: xterm folds replies and reports
   * into the same event and exposes no user-input-only signal. Acceptable
   * only because this engine exists for the benchmark harness, which never
   * connects a session — nothing here reaches a wire, let alone another
   * pane's. A real consumer of this class would need the split.
   */
  onInput(cb: (data: Uint8Array) => void) {
    return this.term.onData((s) => cb(new TextEncoder().encode(s)))
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

  registerResetHandler(cb: () => void) {
    // `false` so the sequence still reaches xterm's own handling: this is a
    // notification, not a replacement for the reset.
    return this.term.parser.registerEscHandler({ final: 'c' }, () => {
      cb()
      return false
    })
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

  // The unfocused tint is an app concern; the bench compares engines focused.
  setTheme(themeName: string, opacity: number, _background?: string | null) {
    this.term.options.theme = themeWithOpacity(themeName, opacity)
  }

  /**
   * Takes the same selection the Ghostty engine does, and uses the regular
   * face out of it. xterm.js has one family option and does its own shaping,
   * so the per-style faces, the OpenType features and the codepoint ranges
   * have nowhere to go here -- which is fine, since this engine exists to be
   * compared against rather than configured.
   */
  setFont(fonts: FontSelection, fontSize: number) {
    this.term.options.fontFamily = fonts.regular
    this.term.options.fontSize = fontSize
  }

  setCursorStyle(style: CursorStyleSetting, blink: boolean) {
    // xterm has its own options for this rather than taking DECSCUSR from us,
    // and its names line up one-for-one.
    this.term.options.cursorStyle = style === 'bar' ? 'bar' : style === 'underline' ? 'underline' : 'block'
    this.term.options.cursorBlink = blink
  }

  // xterm takes a line count, so the tier is converted at this boundary rather
  // than the app carrying two units around. Estimated at the current width,
  // which is the best available answer: unlike Ghostty, xterm's limit is a
  // plain row cap with no width term, so it cannot express "this much memory".
  setScrollbackBudget(footprintMB: number) {
    this._budgetBytes = scrollbackBudgetBytesFor(footprintMB)
    this.term.options.scrollback = estimateScrollbackRows(this._budgetBytes, this.term.cols)
  }

  private _budgetBytes = scrollbackBudgetBytesFor(8)

  get scrollbackBudgetBytes(): number {
    return this._budgetBytes
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
