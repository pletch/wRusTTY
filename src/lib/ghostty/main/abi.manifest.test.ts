/**
 * `abi.ts`'s struct layouts, checked against the binary's own description of
 * them.
 *
 * The offsets in `abi.ts` were *probed* — write a known value, read it back,
 * move the offset until the grid agrees — because the C headers do not say what
 * the wasm32 layout is and several of them read as something it is not
 * (`GhosttyPoint` especially; see the comment there). Probing works, and every
 * offset it found is correct. What it cannot find is where a struct *ends*: a
 * field you never read has no observable position, so a union with an unused
 * tail is invisible to it.
 *
 * That is exactly what went wrong. `POINT_SIZE` was 16 for the whole life of
 * the port while the struct is 24, so `ScrollbackReader` handed the core a
 * 16-byte allocation to read 24 bytes from, and its zeroing loop cleared two
 * thirds of the union it was written to clear. Nothing looked wrong, because
 * the eight missing bytes are the arm nobody reads.
 *
 * The binary has been able to settle this the whole time: `ghostty_type_json`
 * returns a machine-readable manifest of every public struct — size, alignment,
 * and every field's offset. This asserts our constants against it. It is a
 * different *kind* of check from `abi.parity.test.ts`: that one proves the
 * values behave, this one proves they are the values upstream says they are, so
 * a constant that is wrong in a way no current call path exercises still fails.
 *
 * When a rebuild moves a layout, this fails with both numbers rather than
 * leaving it to be rediscovered by probing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'

const here = dirname(fileURLToPath(import.meta.url))
/** The shipped binary — the one whose layouts `abi.ts` has to be right about. */
const WASM = join(here, '../vendor/ghostty-vt.wasm')

interface ManifestField {
  offset: number
  size: number
  type: string
}
interface ManifestType {
  size: number
  align: number
  fields?: Record<string, ManifestField>
}

/** Reads the manifest out of a fresh instance. */
function manifest(): Record<string, ManifestType> {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {
    env: { log: () => {} },
  })
  const ex = inst.exports as unknown as {
    memory: WebAssembly.Memory
    ghostty_type_json(): number
  }
  const ptr = ex.ghostty_type_json()
  expect(ptr, 'ghostty_type_json returned NULL').not.toBe(0)
  // Null-terminated, and valid for the life of the module.
  const bytes = new Uint8Array(ex.memory.buffer)
  let end = ptr
  while (bytes[end] !== 0) end++
  return JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, end)))
}

const run = existsSync(WASM) ? describe : describe.skip

run('abi.ts against ghostty_type_json', () => {
  const m = manifest()

  /** Fails with the field name rather than a bare number pair. */
  const field = (type: string, name: string): ManifestField => {
    const t = m[type]
    expect(t, `manifest has no type ${type}`).toBeDefined()
    const f = t.fields?.[name]
    expect(f, `${type} has no field ${name}`).toBeDefined()
    return f as ManifestField
  }

  it('describes the types we transcribe', () => {
    // A guard on the manifest itself: if a rebuild stops emitting these, every
    // assertion below would vacuously pass on an empty object.
    for (const t of [
      'GhosttyPoint',
      'GhosttyPointCoordinate',
      'GhosttyGridRef',
      'GhosttyStyle',
      'GhosttyStyleColor',
      'GhosttyColorRgb',
      'GhosttyTerminalModeConfig',
    ]) {
      expect(m[t], `manifest is missing ${t}`).toBeDefined()
    }
  })

  it('GhosttyPoint — the one probing got wrong', () => {
    expect(abi.POINT_SIZE).toBe(m.GhosttyPoint.size)
    expect(abi.POINT_OFF_TAG).toBe(field('GhosttyPoint', 'tag').offset)

    // x and y are not fields of the point — they are fields of the coordinate
    // arm of its union, so their absolute offsets are the union's plus theirs.
    const value = field('GhosttyPoint', 'value')
    expect(abi.POINT_OFF_X).toBe(value.offset + field('GhosttyPointCoordinate', 'x').offset)
    expect(abi.POINT_OFF_Y).toBe(value.offset + field('GhosttyPointCoordinate', 'y').offset)

    // The tail that made the under-allocation invisible: the union is wider
    // than the arm we read, so the struct outlives the fields we probed.
    expect(value.offset + value.size).toBe(m.GhosttyPoint.size)
    expect(value.size).toBeGreaterThan(m.GhosttyPointCoordinate.size)
  })

  it('GhosttyGridRef', () => {
    expect(abi.GRID_REF_SIZE).toBe(m.GhosttyGridRef.size)
    expect(abi.GRID_REF_OFF_SIZE).toBe(field('GhosttyGridRef', 'size').offset)
    expect(abi.GRID_REF_OFF_NODE).toBe(field('GhosttyGridRef', 'node').offset)
    expect(abi.GRID_REF_OFF_X).toBe(field('GhosttyGridRef', 'x').offset)
    expect(abi.GRID_REF_OFF_Y).toBe(field('GhosttyGridRef', 'y').offset)
  })

  it('GhosttyStyle — size, colours and the attribute bytes', () => {
    expect(abi.STYLE_SIZE).toBe(m.GhosttyStyle.size)
    expect(abi.STYLE_OFF_SIZE).toBe(field('GhosttyStyle', 'size').offset)

    // Each colour is a nested GhosttyStyleColor, so our flat tag/value offsets
    // are the member's offset plus the tag/value offsets inside it.
    const tag = field('GhosttyStyleColor', 'tag').offset
    const val = field('GhosttyStyleColor', 'value').offset
    for (const [member, offTag, offValue] of [
      ['fg_color', abi.STYLE_OFF_FG_TAG, abi.STYLE_OFF_FG_VALUE],
      ['bg_color', abi.STYLE_OFF_BG_TAG, abi.STYLE_OFF_BG_VALUE],
      ['underline_color', abi.STYLE_OFF_UNDERLINE_TAG, abi.STYLE_OFF_UNDERLINE_VALUE],
    ] as const) {
      const base = field('GhosttyStyle', member).offset
      expect(offTag, `${member} tag`).toBe(base + tag)
      expect(offValue, `${member} value`).toBe(base + val)
    }

    for (const [name, ours] of [
      ['bold', abi.STYLE_OFF_BOLD],
      ['italic', abi.STYLE_OFF_ITALIC],
      ['faint', abi.STYLE_OFF_FAINT],
      ['blink', abi.STYLE_OFF_BLINK],
      ['inverse', abi.STYLE_OFF_INVERSE],
      ['invisible', abi.STYLE_OFF_INVISIBLE],
      ['strikethrough', abi.STYLE_OFF_STRIKETHROUGH],
      ['overline', abi.STYLE_OFF_OVERLINE],
    ] as const) {
      expect(ours, name).toBe(field('GhosttyStyle', name).offset)
    }

    // Named `underline` upstream; ours says UNDERLINE_STYLE to keep it apart
    // from the colour above, which is the pair most likely to be confused.
    expect(abi.STYLE_OFF_UNDERLINE_STYLE).toBe(field('GhosttyStyle', 'underline').offset)
  })

  it('GhosttyTerminalModeConfig — the in/out struct behind T_DATA_MODE', () => {
    expect(abi.MODE_CONFIG_SIZE).toBe(m.GhosttyTerminalModeConfig.size)
    expect(abi.MODE_CONFIG_MODE_OFFSET).toBe(field('GhosttyTerminalModeConfig', 'mode').offset)
    expect(abi.MODE_CONFIG_VALUE_OFFSET).toBe(field('GhosttyTerminalModeConfig', 'value').offset)
  })

  it('GhosttyColorRgb is the unit PALETTE_BYTES counts in', () => {
    expect(abi.COLOR_RGB_BYTES).toBe(m.GhosttyColorRgb.size)
    expect(abi.PALETTE_BYTES).toBe(abi.PALETTE_ENTRIES * m.GhosttyColorRgb.size)
  })
})
