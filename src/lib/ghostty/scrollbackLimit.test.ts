import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scrollbackBudgetBytesFor, estimateScrollbackRows } from './GhosttyEngine'
import { SCROLLBACK_FOOTPRINT_TIERS_MB } from '../settings'
import { instantiateGhosttyModule, createTerminal, writeBytes, type GhosttyWasm } from './wasmBindings'

/**
 * Guards the unit, the range and the labelling of the value handed to the core
 * as `scrollbackLimit`.
 *
 * The field is a **byte budget** — it reaches upstream Ghostty's `PageList` as
 * `max_size` — and getting it wrong is silent in both directions, which is why
 * this is pinned rather than left to review.
 *
 * Both directions have shipped. A row-shaped value sits under the core's
 * ~530 KB minimum page, so *every* setting collapsed to the same two-page
 * floor: 1000 and 100000 both retained ~1100 rows at 80 columns and the
 * scrollback picker did nothing at all. And zero is not a small budget but
 * *unlimited*, so any path that can produce 0 removes the cap rather than
 * tightening it.
 *
 * The tier labels carry a second promise on top of that: the number in Settings
 * is the pane's total WASM footprint, not the scrollback budget. `stays inside
 * the footprint its label promises` is what holds that honest, and it drives
 * the real core because the heap is a staircase that no arithmetic predicts.
 */

const U32_MAX = 4294967295
const MB = 1024 * 1024

describe('scrollbackBudgetBytesFor', () => {
  it('returns a byte budget, not a row count', () => {
    // The regression in one assertion: a row count would be a few thousand.
    expect(scrollbackBudgetBytesFor(16)).toBeGreaterThan(1 * MB)
  })

  it('gives every offered tier a distinct, ascending budget', () => {
    const budgets = SCROLLBACK_FOOTPRINT_TIERS_MB.map(scrollbackBudgetBytesFor)
    expect(new Set(budgets).size).toBe(budgets.length)
    for (let i = 1; i < budgets.length; i++) expect(budgets[i]).toBeGreaterThan(budgets[i - 1])
  })

  it('keeps every tier the picker offers mapped to a real budget', () => {
    // The tier list lives in settings.ts and the budgets here, to keep the
    // module dependency one-way. Nothing but this stops them drifting apart —
    // an unmapped tier would silently fall back to the smallest, so choosing
    // "64 MB" would quietly give you 8 MB of history.
    const smallest = scrollbackBudgetBytesFor(SCROLLBACK_FOOTPRINT_TIERS_MB[0])
    for (const tier of SCROLLBACK_FOOTPRINT_TIERS_MB.slice(1)) {
      expect(scrollbackBudgetBytesFor(tier)).not.toBe(smallest)
    }
  })

  it('falls back to the smallest tier for anything unknown', () => {
    // Never the largest: an unreadable setting must not cost more memory than
    // the user last agreed to.
    const smallest = scrollbackBudgetBytesFor(SCROLLBACK_FOOTPRINT_TIERS_MB[0])
    for (const bad of [0, -1, 7, 24, 1e9, NaN, Infinity]) {
      expect(scrollbackBudgetBytesFor(bad)).toBe(smallest)
    }
  })

  it('returns a positive integer inside u32 for any input', () => {
    // Written with setUint32; a fraction or out-of-range value is truncated
    // somewhere far less visible than here, and NaN lands on 0 — which this
    // core reads as *unlimited*.
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
    // It is rendered directly into the status bar, where a NaN would show.
    for (const cols of [0, -1, NaN, Infinity]) {
      expect(Number.isFinite(estimateScrollbackRows(4 * MB, cols))).toBe(true)
    }
    for (const bytes of [0, -1, NaN]) {
      expect(Number.isFinite(estimateScrollbackRows(bytes, 80))).toBe(true)
    }
  })
})

/**
 * The unit and the tier labels are only checkable against the binary that
 * consumes them, so this feeds the real core and measures what comes back.
 */
describe('against the core', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  let compiled: WebAssembly.Module

  beforeAll(async () => {
    // Compiled once, instantiated per flood: the heap *is* the measurement
    // here, so two terminals must never share linear memory. Compiling per
    // call instead would dominate the runtime of this file.
    compiled = await WebAssembly.compile(
      readFileSync(join(here, 'vendor/ghostty-vt.wasm')).buffer as ArrayBuffer,
    )
  })

  /** Floods a fresh instance to saturation, returning rows retained and the
   *  peak heap in MB. */
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
    // The promise the tier labels make, and the only thing holding it. WASM
    // memory grows in doubling steps, so the heap is a staircase against the
    // budget — every budget from 13 to 28 MB lands on the same ~30.7 MB heap
    // and one more megabyte doubles it. The budgets were picked just under
    // each step; nothing but this notices if a later edit nudges one over.
    for (const tier of SCROLLBACK_FOOTPRINT_TIERS_MB) {
      for (const cols of [80, 200]) {
        const { heapMB } = await flood(scrollbackBudgetBytesFor(tier), cols)
        expect(heapMB).toBeLessThanOrEqual(tier)
      }
    }
  })

  it('retains roughly the depth the estimate advertises', async () => {
    // Two bands, because the error is not uniform and one band wide enough for
    // the smallest tier would stop checking the others at all. The core evicts
    // whole pages, so the estimate is worst where the budget is only a few
    // pages wide: measured against `main`, -5% to +8% from the 16 MB tier up
    // and as much as -27% at the smallest. Anything outside these is a change
    // in the core's per-row cost, which is exactly what a rebuild can do —
    // re-measure and move SCROLLBACK_BYTES_PER_CELL rather than the band.
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
    // The single assertion the row-count regression could not have passed:
    // under it every tier retained the same ~1100 rows.
    const small = (await flood(scrollbackBudgetBytesFor(8), 80)).held
    const large = (await flood(scrollbackBudgetBytesFor(64), 80)).held
    expect(large).toBeGreaterThan(small * 5)
  })
})
