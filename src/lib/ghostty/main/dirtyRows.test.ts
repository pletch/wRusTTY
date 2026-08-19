/**
 * The two layers of render-state dirty, and the shim's handling of both.
 *
 * `render.h` calls this "an extremely important detail": the global dirty flag
 * and the per-row dirty flags are independent, and clearing one does not clear
 * the other. `mark_clean` used to set only the global one, which left every row
 * of the viewport reading dirty forever after a frame was marked clean.
 *
 * Nothing in the app read per-row dirty, so nothing broke. That is precisely
 * why it needs a test rather than a comment: the failure is invisible until
 * someone adopts dirty-row rendering, at which point the first frame is correct
 * and every frame after it redraws everything while looking like it is being
 * selective.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'
import { shimMainWasm } from './shim'

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, '../vendor/ghostty-vt.wasm')

const COLS = 80
const ROWS = 24

const run = existsSync(WASM) ? describe : describe.skip

run('render-state dirty', () => {
  function boot() {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {
      env: { log: () => {} },
    })
    const ex = inst.exports as unknown as abi.GhosttyMainExports
    const dv = () => new DataView(ex.memory.buffer)

    const slot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_terminal_new(0, slot, COLS, ROWS), 'terminal_new')
    const term = dv().getUint32(slot, true)
    abi.expectOk(ex.ghostty_render_state_new(0, slot), 'render_state_new')
    const state = dv().getUint32(slot, true)
    const iterSlot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_render_state_row_iterator_new(0, iterSlot), 'row_iterator_new')
    const iterHandle = dv().getUint32(iterSlot, true)
    const out = ex.ghostty_wasm_alloc(16)

    const write = (s: string) => {
      const b = new TextEncoder().encode(s)
      const p = ex.ghostty_wasm_alloc(b.length)
      new Uint8Array(ex.memory.buffer).set(b, p)
      ex.ghostty_terminal_vt_write(term, p, b.length)
      ex.ghostty_wasm_free(p, b.length)
    }

    /** A fresh iterator seeded from the current state. */
    const seed = () => {
      dv().setUint32(iterSlot, iterHandle, true)
      abi.expectOk(
        ex.ghostty_render_state_get(state, abi.RS_DATA_ROW_ITERATOR, iterSlot),
        'get ROW_ITERATOR',
      )
      return dv().getUint32(iterSlot, true)
    }

    /** Per-row flags, counted the long way round. */
    const dirtyRowCount = () => {
      const it = seed()
      let n = 0
      while (ex.ghostty_render_state_row_iterator_next(it)) {
        abi.expectOk(ex.ghostty_render_state_row_get(it, abi.RS_ROW_DATA_DIRTY, out), 'row_get DIRTY')
        if (new DataView(ex.memory.buffer).getUint8(out) !== 0) n++
      }
      return n
    }

    /** The y of every row `next_dirty` offers, and how many calls it took. */
    const dirtyYs = () => {
      const it = seed()
      const ys: number[] = []
      let calls = 0
      while ((calls++, ex.ghostty_render_state_row_iterator_next_dirty(it, out))) {
        ys.push(new DataView(ex.memory.buffer).getUint16(out, true))
      }
      return { ys, calls }
    }

    return { ex, term, state, write, dirtyRowCount, dirtyYs, out }
  }

  it('clears both layers, where setting the global flag clears only one', () => {
    const { ex, term, state, write, dirtyRowCount, out } = boot()
    write('hello')
    abi.expectOk(ex.ghostty_render_state_update(state, term), 'update')
    expect(dirtyRowCount()).toBe(ROWS)

    // What `mark_clean` used to do: the global layer, and only that.
    new DataView(ex.memory.buffer).setUint32(out, abi.RS_DIRTY_FALSE, true)
    ex.ghostty_render_state_set(state, abi.RS_OPTION_DIRTY, out)
    expect(dirtyRowCount(), 'per-row flags survive a global clear').toBe(ROWS)

    // What it does now.
    abi.expectOk(ex.ghostty_render_state_clean(state), 'render_state_clean')
    expect(dirtyRowCount(), 'render_state_clean gets both layers').toBe(0)
  })

  it('offers the edited row, and the row the cursor left', () => {
    const { ex, term, state, write, dirtyYs } = boot()
    write('first frame')
    abi.expectOk(ex.ghostty_render_state_update(state, term), 'update')
    abi.expectOk(ex.ghostty_render_state_clean(state), 'clean')

    // One row edited, mid-screen, so a wrong answer cannot coincide with 0.
    const y = ROWS >> 1
    write(`\x1b[${y + 1};1Hchanged`)
    abi.expectOk(ex.ghostty_render_state_update(state, term), 'update')

    // **Two rows, not one.** The cursor was on row 0 and is now on row `y`, and
    // the row it left has to be repainted without it — so a consumer that
    // redraws only what this offers still gets a correct screen, while one that
    // assumed "rows whose text changed" would leave a cursor behind. Worth
    // asserting rather than tolerating: the second entry looks like a bug the
    // first time you see it, and it is the engine being right.
    const { ys, calls } = dirtyYs()
    expect(ys).toEqual([0, y])
    expect(calls).toBeLessThanOrEqual(3)
  })

  it('offers exactly one row when the cursor does not move', () => {
    const { ex, term, state, write, dirtyYs } = boot()
    // Park the cursor on the row that is about to change, *before* the clean,
    // so the edit is the only thing the next frame has to redraw. This is the
    // control for the test above: it isolates the cursor's contribution.
    const y = ROWS >> 1
    write(`first frame\x1b[${y + 1};1H`)
    abi.expectOk(ex.ghostty_render_state_update(state, term), 'update')
    abi.expectOk(ex.ghostty_render_state_clean(state), 'clean')

    write('changed')
    abi.expectOk(ex.ghostty_render_state_update(state, term), 'update')

    const { ys, calls } = dirtyYs()
    expect(ys).toEqual([y])
    // The point of the API: finding that one row costs two calls, not one per
    // row of the viewport. Upstream quotes 50 -> 2 for this exact shape.
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('leaves outY untouched when it returns false, so a stale y cannot be read', () => {
    const { ex, term, state, write, out } = boot()
    write('x')
    abi.expectOk(ex.ghostty_render_state_update(state, term), 'update')
    abi.expectOk(ex.ghostty_render_state_clean(state), 'clean')

    const sentinel = 0xbeef
    new DataView(ex.memory.buffer).setUint16(out, sentinel, true)
    const iterSlot = ex.ghostty_wasm_alloc_opaque()
    abi.expectOk(ex.ghostty_render_state_row_iterator_new(0, iterSlot), 'row_iterator_new')
    const handle = new DataView(ex.memory.buffer).getUint32(iterSlot, true)
    new DataView(ex.memory.buffer).setUint32(iterSlot, handle, true)
    abi.expectOk(ex.ghostty_render_state_get(state, abi.RS_DATA_ROW_ITERATOR, iterSlot), 'get iter')
    const it = new DataView(ex.memory.buffer).getUint32(iterSlot, true)

    // Nothing is dirty, so this must report false and write nothing.
    expect(ex.ghostty_render_state_row_iterator_next_dirty(it, out)).toBeFalsy()
    expect(new DataView(ex.memory.buffer).getUint16(out, true)).toBe(sentinel)
  })
})

/**
 * The same two behaviours, but asserted *through the shim*, which is what
 * actually ships.
 *
 * The block above pins what the engine does. It would pass just as happily with
 * the shim reverted to clearing only the global flag, because it never calls
 * the shim — so on its own it guards the wrong thing.
 */
run('the shim, over the dirty API', () => {
  function boot() {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {
      env: { log: () => {} },
    })
    const raw = inst.exports as unknown as abi.GhosttyMainExports
    const wasm = shimMainWasm(inst)
    const term = wasm.exports.ghostty_terminal_new(COLS, ROWS)
    const out = raw.ghostty_wasm_alloc(16)

    const write = (t: string) => {
      const b = new TextEncoder().encode(t)
      const p = raw.ghostty_wasm_alloc(b.length)
      new Uint8Array(raw.memory.buffer).set(b, p)
      raw.ghostty_terminal_vt_write(term, p, b.length)
      raw.ghostty_wasm_free(p, b.length)
    }
    return { raw, wasm, term, write, out }
  }

  /**
   * There is deliberately no "mark_clean leaves zero flags" test here.
   *
   * It cannot be written through the shim: the shim owns its render state
   * privately, and asking `is_row_dirty` right after `mark_clean` answers
   * "clean" either way, because `next_dirty` reports nothing while the global
   * flag is false. A global-only clear hides behind that gate for exactly one
   * frame. The engine-level block above proves `render_state_clean` clears both
   * layers; the test below is what catches the shim failing to call it, because
   * the stale flags resurface the moment anything dirties the frame again.
   */
  it('sees one dirty row on the frame after a mark_clean, not all of them', () => {
    const { wasm, term, write } = boot()
    const y = ROWS >> 1
    // Park the cursor on the target row first, so the cursor's old row does not
    // also come back dirty — see the control test above.
    write(`first\x1b[${y + 1};1H`)
    wasm.exports.ghostty_render_state_update(term)
    wasm.exports.ghostty_render_state_mark_clean(term)

    write('changed')
    wasm.exports.ghostty_render_state_update(term)

    expect(wasm.exports.ghostty_render_state_is_row_dirty(term, y), `row ${y}`).toBeTruthy()
    expect(wasm.exports.ghostty_render_state_is_row_dirty(term, y - 1), `row ${y - 1}`).toBeFalsy()
    expect(wasm.exports.ghostty_render_state_is_row_dirty(term, y + 1), `row ${y + 1}`).toBeFalsy()
    // Past the last dirty row, so the walk runs out rather than finding a match.
    expect(wasm.exports.ghostty_render_state_is_row_dirty(term, ROWS - 1), 'last row').toBeFalsy()
  })
})
