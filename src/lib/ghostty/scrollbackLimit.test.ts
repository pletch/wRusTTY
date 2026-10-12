import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scrollbackBudgetBytesFor, estimateScrollbackRows } from './GhosttyEngine'
import { SCROLLBACK_FOOTPRINT_TIERS_MB } from '../settings'
import { instantiateGhosttyModule, createTerminal, writeBytes, type GhosttyWasm } from './wasmBindings'

/**
 * Guards the unit, range and labeling of `scrollbackLimit`: a byte budget
 * (upstream's `PageList` `max_size`), wrong silently in both directions. A
 * row-shaped value sits under the core's ~530 KB minimum page, so every
 * setting collapses to the same floor; zero means unlimited.
 *
 * The tier labels promise the pane's total WASM footprint, checked against
 * the real core, since the heap grows in steps no arithmetic predicts.
 */

const U32_MAX = 4294967295
const MB = 1024 * 1024

describe('scrollbackBudgetBytesFor', () => {
  it('returns a byte budget, not a row count', () => {
    // A row count would be a few thousand.
    expect(scrollbackBudgetBytesFor(16)).toBeGreaterThan(1 * MB)
  })

  it('gives every offered tier a distinct, ascending budget', () => {
    const budgets = SCROLLBACK_FOOTPRINT_TIERS_MB.map(scrollbackBudgetBytesFor)
    expect(new Set(budgets).size).toBe(budgets.length)
    for (let i = 1; i < budgets.length; i++) expect(budgets[i]).toBeGreaterThan(budgets[i - 1])
  })

  it('keeps every tier the picker offers mapped to a real budget', () => {
    // Tiers live in settings.ts and budgets here (a one-way dependency); an
    // unmapped tier would silently fall back to the smallest.
    const smallest = scrollbackBudgetBytesFor(SCROLLBACK_FOOTPRINT_TIERS_MB[0])
    for (const tier of SCROLLBACK_FOOTPRINT_TIERS_MB.slice(1)) {
      expect(scrollbackBudgetBytesFor(tier)).not.toBe(smallest)
    }
  })

  it('falls back to the smallest tier for anything unknown', () => {
    // Never the largest: an unreadable setting mustn't cost more memory.
    const smallest = scrollbackBudgetBytesFor(SCROLLBACK_FOOTPRINT_TIERS_MB[0])
    for (const bad of [0, -1, 7, 24, 1e9, NaN, Infinity]) {
      expect(scrollbackBudgetBytesFor(bad)).toBe(smallest)
    }
  })

  it('returns a positive integer inside u32 for any input', () => {
    // Written with setUint32; NaN would land on 0, which means unlimited.
    for (const input of [...SCROLLBACK_FOOTPRINT_TIERS_MB, 0, -1, NaN, Infinity, 3.5]) {
      const bytes = scrollbackBudgetBytesFor(input)
      expect(Number.isInteger(bytes)).toBe(true)
      expect(bytes).toBeGreaterThan(0)
      expect(bytes).toBeLessThan(U32_MAX)
    }
  })
})

describe('estimateScrollbackRows', () => {
  it('trades depth against width', () => {
    const budget = scrollbackBudgetBytesFor(32)
    expect(estimateScrollbackRows(budget, 200)).toBeLessThan(estimateScrollbackRows(budget, 80))
  })

  it('scales with the budget at a fixed width', () => {
    expect(estimateScrollbackRows(scrollbackBudgetBytesFor(64), 80)).toBeGreaterThan(
      estimateScrollbackRows(scrollbackBudgetBytesFor(8), 80),
    )
  })

  it('survives degenerate inputs rather than returning NaN', () => {
    // Rendered into the status bar, where NaN would show.
    for (const cols of [0, -1, NaN, Infinity]) {
      expect(Number.isFinite(estimateScrollbackRows(4 * MB, cols))).toBe(true)
    }
    for (const bytes of [0, -1, NaN]) {
      expect(Number.isFinite(estimateScrollbackRows(bytes, 80))).toBe(true)
    }
  })
})

/**
 * The unit and tier labels, checked by feeding the real core.
 */
describe('against the core', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  let compiled: WebAssembly.Module

  beforeAll(async () => {
    // Compiled once, instantiated per flood: the heap is the measurement, so
    // terminals can't share linear memory.
    compiled = await WebAssembly.compile(
      readFileSync(join(here, 'vendor/ghostty-vt.wasm')).buffer as ArrayBuffer,
    )
  })

  /** Floods a fresh instance to saturation, returning rows retained and peak
   *  heap in MB. */
  async function flood(budgetBytes: number, cols: number): Promise<{ held: number; heapMB: number }> {
    const local: GhosttyWasm = await instantiateGhosttyModule(compiled)
    const ex = local.exports
    const ptr = createTerminal(local, cols, 24, {
      scrollbackLimit: budgetBytes,
      fgColor: 0xcccccc,
      bgColor: 0,
      cursorColor: 0,
    })
    if (ptr === 0) throw new Error('terminal_new failed')
    const enc = new TextEncoder()
    const filler = 'x'.repeat(Math.min(20, cols - 8))
    const feed = estimateScrollbackRows(budgetBytes, cols) * 2 + 3000
    for (let i = 0; i < feed; i += 500) {
      let s = ''
      for (let j = 0; j < 500 && i + j < feed; j++) s += `${i + j} ${filler}\r\n`
      writeBytes(local, ptr, enc.encode(s))
    }
    return {
      held: ex.ghostty_terminal_get_scrollback_length(ptr),
      heapMB: ex.memory.buffer.byteLength / MB,
    }
  }

  it('stays inside the footprint its label promises', async () => {
    // WASM memory grows in doubling steps (every budget from 13 to 28 MB lands
    // on ~30.7 MB), so budgets sit just under each step; this catches one
    // nudged over.
    for (const tier of SCROLLBACK_FOOTPRINT_TIERS_MB) {
      for (const cols of [80, 200]) {
        const { heapMB } = await flood(scrollbackBudgetBytesFor(tier), cols)
        expect(heapMB).toBeLessThanOrEqual(tier)
      }
    }
  })

  it('retains roughly the depth the estimate advertises', async () => {
    // Two bands: whole-page eviction makes the estimate worst for small budgets
    // (measured -5% to +8% from 16 MB up, down to -27% at the smallest).
    // Outside them, the core's per-row cost changed: re-measure and move
    // SCROLLBACK_BYTES_PER_CELL rather than the band.
    const smallest = SCROLLBACK_FOOTPRINT_TIERS_MB[0]
    for (const tier of SCROLLBACK_FOOTPRINT_TIERS_MB) {
      for (const cols of [80, 200]) {
        const budget = scrollbackBudgetBytesFor(tier)
        const { held } = await flood(budget, cols)
        const predicted = estimateScrollbackRows(budget, cols)
        expect(held).toBeGreaterThan(predicted * (tier === smallest ? 0.65 : 0.9))
        expect(held).toBeLessThan(predicted * 1.15)
      }
    }
  })

  it('gives a bigger tier more depth at the same width', async () => {
    // A row-shaped budget would retain the same ~1100 rows at every tier.
    const small = (await flood(scrollbackBudgetBytesFor(8), 80)).held
    const large = (await flood(scrollbackBudgetBytesFor(64), 80)).held
    expect(large).toBeGreaterThan(small * 5)
  })
})
