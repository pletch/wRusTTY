/**
 * Prices the scrollback SEARCH path — the one thing iter.mjs never measured.
 *
 * iter.mjs priced the render path: the viewport, redrawn. Search is a different
 * shape and a different API. `SearchController` calls `readRows(0, total - 1)`,
 * which walks the WHOLE scrollback, and on the vendored build that is one
 * `get_scrollback_line` per ROW — a whole row of packed 16-byte cells per call.
 * On ghostty main there is no such call: scrollback is addressed through
 * grid_ref, which resolves a point and hands back one cell.
 *
 * Modes (one per child process, per iter.mjs's megamorphism lesson):
 *   today          vendored: 1 call/row, JS unpacks cols x 16 bytes
 *   gridref        main: 1 grid_ref/row, then mutate ref.x + grid_ref_cell/cell,
 *                  unpacking the u64 in JS (the RAW-equivalent fast path)
 *   gridref-cellget main: as above but using ghostty_cell_get per cell, the
 *                  accessor upstream actually documents
 *   gridref-naive  main: re-resolve grid_ref per CELL, which is what a direct
 *                  transliteration of readRows would do
 *
 * ABI facts established by layout.mjs / gridprobe.mjs, none of them guessable:
 *   GhosttyPoint  = { tag u32 @0; pad; x u16 @8; y u32 @12 }  (16 bytes)
 *   GhosttyGridRef= { size u32 @0; node ptr @4; x u16 @8; y u16 @10 }
 *   GhosttyCell   = uint64_t, passed to ghostty_cell_get BY VALUE (i64 arg)
 *   packed cell: codepoint = (lo >>> 2) & 0x1FFFFF
 *
 * usage: node search.mjs <main.wasm> [vendored.wasm] [mode]
 */
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const WASM = process.argv[2]
if (!WASM) throw new Error('usage: search.mjs <main.wasm> [vendored.wasm] [mode]')
// See the note in `iter.mjs`: this must be the **v1.3.1** build, and defaulting
// it to `vendor/ghostty-vt.wasm` broke both probes when the port put a main
// binary at that path.
const VENDORED = process.argv[3] ?? 'src/lib/ghostty/vendor-131/ghostty-vt.wasm'
const ONLY = process.argv[4] ?? null

const enc = new TextEncoder()
const CELL_BYTES = 16

/** cols x rows, and how many rows of scrollback to search. */
const CASES = process.env.DEEP
  ? [{ cols: 200, rows: 60, sb: Number(process.env.DEEP) }]
  : [
      { cols: 80, rows: 24, sb: 2000 },
      { cols: 200, rows: 60, sb: 10000 },
    ]

const TAG_SCREEN = 2
const CELL_DATA_CODEPOINT = 1

function corpus(cols, n) {
  // Real-ish log lines, long enough to fill the width, with a needle that is
  // never found so the walk cannot terminate early.
  let s = '\x1b[H'
  for (let r = 0; r < n; r++) {
    const line = `2026-08-04T14:${String(r % 60).padStart(2, '0')}:00 INFO  worker[${r % 8}] processed batch ${r} in ${(r % 97) + 3}ms `
    s += line.repeat(Math.ceil(cols / line.length)).slice(0, cols) + '\r\n'
  }
  return s
}

const bench = (fn, iters) => {
  for (let i = 0; i < Math.max(1, Math.min(iters, 2)); i++) fn()
  let best = Infinity
  for (let r = 0; r < 3; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, Number(t1 - t0) / iters)
  }
  return best
}

function boot(file) {
  const mod = new WebAssembly.Module(readFileSync(file))
  const inst = new WebAssembly.Instance(mod, { env: { log: () => {} } })
  const ex = inst.exports
  const mem = ex.memory
  let view = new DataView(mem.buffer)
  const dv = () => { if (view.buffer !== mem.buffer) view = new DataView(mem.buffer); return view }
  return { ex, mem, dv }
}

// ---- vendored: one packed row per call --------------------------------------

function measureToday() {
  const { ex, mem, dv } = boot(VENDORED)
  const write = (t, s) => {
    const b = enc.encode(s)
    const p = ex.ghostty_wasm_alloc_u8_array(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    ex.ghostty_terminal_write(t, p, b.length)
    ex.ghostty_wasm_free_u8_array(p, b.length)
  }
  const out = {}
  for (const { cols, rows, sb } of CASES) {
    // scrollback_limit is a BYTE budget on this ABI (see vendor/README.md).
    // Size it generously so the corpus is retained rather than pruned.
    const cfg = ex.ghostty_wasm_alloc_u8_array(80)
    const d = dv()
    d.setUint32(cfg, 256 * 1024 * 1024, true)
    for (let i = 4; i < 80; i += 4) d.setUint32(cfg + i, 0, true)
    const term = ex.ghostty_terminal_new_with_config(cols, rows, cfg)
    ex.ghostty_wasm_free_u8_array(cfg, 80)
    write(term, corpus(cols, sb))
    // REQUIRED: get_scrollback_line reads through RenderState.row_data (patch
    // #177), so without this every row reads back blank and the baseline times
    // an empty loop. Done once, outside the timed pass, because that is the
    // real shape — search runs against the state the last frame already built.
    ex.ghostty_render_state_update(term)

    const sbLen = ex.ghostty_terminal_get_scrollback_length(term)
    const linePtr = ex.ghostty_wasm_alloc_u8_array(cols * CELL_BYTES)
    const pass = () => {
      let acc = 0
      for (let abs = 0; abs < sbLen; abs++) {
        ex.ghostty_terminal_get_scrollback_line(term, abs, linePtr, cols)
        const v = dv()
        for (let c = 0; c < cols; c++) {
          const cp = v.getUint32(linePtr + c * CELL_BYTES, true)
          acc += cp
        }
      }
      return acc
    }
    out[`${cols}x${rows}`] = { us: bench(pass, 3) / 1000, rows: sbLen, cells: sbLen * cols }
    ex.ghostty_terminal_free(term)
  }
  return out
}

// ---- main: grid_ref -----------------------------------------------------------

function measureMain(mode) {
  const { ex, mem, dv } = boot(WASM)
  const ok = (r, w) => { if (r !== 0) throw new Error(`${w} -> ${r}`) }
  const make = (fn, w) => { const s = ex.ghostty_wasm_alloc_opaque(); ok(fn(s), w); return dv().getUint32(s, true) }
  const write = (t, s) => {
    const b = enc.encode(s)
    const p = ex.ghostty_wasm_alloc_u8_array(b.length)
    new Uint8Array(mem.buffer).set(b, p)
    ex.ghostty_terminal_vt_write(t, p, b.length)
    ex.ghostty_wasm_free_u8_array(p, b.length)
  }

  const out = {}
  for (const { cols, rows, sb } of CASES) {
    const term = make((s) => ex.ghostty_terminal_new(0, s, cols, rows), 'terminal_new')
    // Both caps bind independently: MAX_LINES alone left 456 rows of a
    // requested 10,000 at 200 cols, byte-pruned. Raise both.
    const vptr = ex.ghostty_wasm_alloc_usize()
    dv().setUint32(vptr, 512 * 1024 * 1024, true)
    ok(ex.ghostty_terminal_set(term, 27 /* OPT_SCROLLBACK_MAX_BYTES */, vptr), 'set scrollback bytes')
    dv().setUint32(vptr, sb + rows + 1000, true)
    ok(ex.ghostty_terminal_set(term, 28 /* OPT_SCROLLBACK_MAX_LINES */, vptr), 'set scrollback lines')
    write(term, corpus(cols, sb))

    const outp = ex.ghostty_wasm_alloc_u8_array(16)
    ok(ex.ghostty_terminal_get(term, 15 /* DATA_SCROLLBACK_ROWS */, outp), 'get sb rows')
    const sbLen = dv().getUint32(outp, true)

    const ptPtr = ex.ghostty_wasm_alloc_u8_array(16)
    const refPtr = ex.ghostty_wasm_alloc_u8_array(16)
    const cellPtr = ex.ghostty_wasm_alloc_u8_array(8)

    const setPoint = (x, y) => {
      const d = dv()
      d.setUint32(ptPtr, TAG_SCREEN, true)
      d.setUint32(ptPtr + 4, 0, true)
      d.setUint32(ptPtr + 8, x, true)
      d.setUint32(ptPtr + 12, y, true)
    }

    /** 1 resolve per row, then walk by mutating ref.x; unpack the u64 in JS. */
    const rowWalk = () => {
      let acc = 0
      for (let y = 0; y < sbLen; y++) {
        setPoint(0, y)
        if (ex.ghostty_terminal_grid_ref(term, ptPtr, refPtr) !== 0) continue
        const d = dv()
        for (let x = 0; x < cols; x++) {
          d.setUint16(refPtr + 8, x, true)
          if (ex.ghostty_grid_ref_cell(refPtr, cellPtr) !== 0) continue
          acc += (d.getUint32(cellPtr, true) >>> 2) & 0x1fffff
        }
      }
      return acc
    }

    /** Same, but through the documented accessor rather than bit-twiddling. */
    const rowWalkCellGet = () => {
      let acc = 0
      for (let y = 0; y < sbLen; y++) {
        setPoint(0, y)
        if (ex.ghostty_terminal_grid_ref(term, ptPtr, refPtr) !== 0) continue
        const d = dv()
        for (let x = 0; x < cols; x++) {
          d.setUint16(refPtr + 8, x, true)
          if (ex.ghostty_grid_ref_cell(refPtr, cellPtr) !== 0) continue
          const lo = d.getUint32(cellPtr, true), hi = d.getUint32(cellPtr + 4, true)
          if (ex.ghostty_cell_get((BigInt(hi) << 32n) | BigInt(lo), CELL_DATA_CODEPOINT, outp) === 0) {
            acc += d.getUint32(outp, true)
          }
        }
      }
      return acc
    }

    /** Re-resolve per cell: the direct transliteration of today's readRows. */
    const naive = () => {
      let acc = 0
      for (let y = 0; y < sbLen; y++) {
        for (let x = 0; x < cols; x++) {
          setPoint(x, y)
          if (ex.ghostty_terminal_grid_ref(term, ptPtr, refPtr) !== 0) continue
          if (ex.ghostty_grid_ref_cell(refPtr, cellPtr) !== 0) continue
          acc += (dv().getUint32(cellPtr, true) >>> 2) & 0x1fffff
        }
      }
      return acc
    }

    const fn = mode === 'gridref-cellget' ? rowWalkCellGet : mode === 'gridref-naive' ? naive : rowWalk
    const iters = mode === 'gridref-naive' ? 1 : 3
    out[`${cols}x${rows}`] = { us: bench(fn, iters) / 1000, rows: sbLen, cells: sbLen * cols }
    ex.ghostty_terminal_free(term)
  }
  return out
}

// ---- driver -----------------------------------------------------------------

const MODES = ['today', 'gridref', 'gridref-cellget', 'gridref-naive']

/**
 * The gate that makes the rest of this file mean anything: both engines must
 * read the SAME text out of the same corpus.
 *
 * This is not ceremony. The first run of this probe had `today` measuring an
 * empty loop — `get_scrollback_line` reads through `RenderState.row_data`, so
 * without a `render_state_update` first every row comes back blank. The
 * benchmark happily reported grid_ref at 5.2x SLOWER than a baseline that was
 * doing nothing. Run this whenever the harness changes.
 */
function check() {
  const A = boot(VENDORED)
  const { cols, rows, sb } = CASES[0]
  const cfg = A.ex.ghostty_wasm_alloc_u8_array(80)
  A.dv().setUint32(cfg, 256 * 1024 * 1024, true)
  for (let i = 4; i < 80; i += 4) A.dv().setUint32(cfg + i, 0, true)
  const ta = A.ex.ghostty_terminal_new_with_config(cols, rows, cfg)
  let b = enc.encode(corpus(cols, sb))
  let p = A.ex.ghostty_wasm_alloc_u8_array(b.length)
  new Uint8Array(A.mem.buffer).set(b, p)
  A.ex.ghostty_terminal_write(ta, p, b.length)
  A.ex.ghostty_render_state_update(ta)
  const sbA = A.ex.ghostty_terminal_get_scrollback_length(ta)
  const linePtr = A.ex.ghostty_wasm_alloc_u8_array(cols * CELL_BYTES)

  const B = boot(WASM)
  const slot = B.ex.ghostty_wasm_alloc_opaque()
  B.ex.ghostty_terminal_new(0, slot, cols, rows)
  const tb = B.dv().getUint32(slot, true)
  const vp = B.ex.ghostty_wasm_alloc_usize()
  B.dv().setUint32(vp, 512 * 1024 * 1024, true)
  B.ex.ghostty_terminal_set(tb, 27, vp)
  B.dv().setUint32(vp, sb + rows + 1000, true)
  B.ex.ghostty_terminal_set(tb, 28, vp)
  b = enc.encode(corpus(cols, sb))
  p = B.ex.ghostty_wasm_alloc_u8_array(b.length)
  new Uint8Array(B.mem.buffer).set(b, p)
  B.ex.ghostty_terminal_vt_write(tb, p, b.length)
  const o = B.ex.ghostty_wasm_alloc_u8_array(16)
  B.ex.ghostty_terminal_get(tb, 15, o)
  const sbB = B.dv().getUint32(o, true)
  const ptPtr = B.ex.ghostty_wasm_alloc_u8_array(16)
  const refPtr = B.ex.ghostty_wasm_alloc_u8_array(16)
  const cellPtr = B.ex.ghostty_wasm_alloc_u8_array(8)

  console.log(`vendored rows = ${sbA}, main rows = ${sbB}`)
  let bad = 0, fails = 0, n = 0
  const N = Math.min(sbA, sbB)
  for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 400))) {
    A.ex.ghostty_terminal_get_scrollback_line(ta, i, linePtr, cols)
    let sa = ''
    for (let c = 0; c < cols; c++) {
      const cp = A.dv().getUint32(linePtr + c * CELL_BYTES, true)
      sa += cp > 0 ? String.fromCodePoint(cp) : ' '
    }
    const d = B.dv()
    d.setUint32(ptPtr, TAG_SCREEN, true); d.setUint32(ptPtr + 4, 0, true)
    d.setUint32(ptPtr + 8, 0, true); d.setUint32(ptPtr + 12, i, true)
    let sb2 = ''
    if (B.ex.ghostty_terminal_grid_ref(tb, ptPtr, refPtr) === 0) {
      for (let x = 0; x < cols; x++) {
        d.setUint16(refPtr + 8, x, true)
        if (B.ex.ghostty_grid_ref_cell(refPtr, cellPtr) !== 0) { sb2 += ' '; fails++; continue }
        const cp = (d.getUint32(cellPtr, true) >>> 2) & 0x1fffff
        sb2 += cp > 0 ? String.fromCodePoint(cp) : ' '
      }
    } else fails += cols
    n++
    if (sa !== sb2) {
      if (bad < 3) {
        console.log(`\nrow ${i} MISMATCH\n  today: ${JSON.stringify(sa.slice(0, 70))}\n  grid : ${JSON.stringify(sb2.slice(0, 70))}`)
      }
      bad++
    }
  }
  console.log(`\nrows compared: ${n}, mismatches: ${bad}, failed cell reads: ${fails}`)
  console.log(bad === 0 && fails === 0 ? 'PASS — both engines read identical text' : 'FAIL')
  if (bad !== 0 || fails !== 0) process.exit(1)
}

if (ONLY === 'check') {
  check()
} else if (ONLY) {
  const r = ONLY === 'today' ? measureToday() : measureMain(ONLY)
  console.log(JSON.stringify(r))
} else {
  const self = fileURLToPath(import.meta.url)
  const res = {}
  for (const m of MODES) {
    process.stderr.write(`  measuring ${m} ...\n`)
    const raw = execFileSync(process.execPath, [self, WASM, VENDORED, m], {
      encoding: 'utf8', maxBuffer: 1 << 24,
    })
    res[m] = JSON.parse(raw.trim().split('\n').pop())
  }
  const keys = Object.keys(res.today)
  console.log('\nFull scrollback search pass, ms (lower is better)\n')
  const pad = (s, n) => String(s).padStart(n)
  console.log(pad('', 18), keys.map((k) => pad(k, 16)).join(''))
  for (const m of MODES) {
    const cells = keys.map((k) => {
      const a = res[m][k], b = res.today[k]
      if (!a) return pad('-', 16)
      const ms = (a.us / 1000).toFixed(2)
      return pad(m === 'today' ? `${ms} ms` : `${ms} ms  ${(a.us / b.us).toFixed(1)}x`, 16)
    })
    console.log(pad(m, 18), cells.join(''))
  }
  console.log('\nrows searched / cells walked:')
  for (const k of keys) console.log(`  ${k}: ${res.today[k].rows} rows, ${res.today[k].cells} cells (main saw ${res.gridref[k].rows})`)
}
