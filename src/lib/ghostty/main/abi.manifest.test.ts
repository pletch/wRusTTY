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
interface ManifestAbi {
  target: string
  pointer_size: number
  usize_size: number
  max_alignment: number
}

/**
 * The whole document, which gained a wrapper in the `d9ffbbf17` pin.
 *
 * It used to be a bare map of type name to layout. It is now
 * `{ schema, abi, library_version, commit, dirty, types }`, so the layouts live
 * under `types`. Both shapes are accepted: the `schema` key is the discriminator
 * upstream added for exactly this, and checking out an older binary should not
 * fail this suite in a way that looks like a layout change.
 */
interface Manifest {
  schema?: number
  abi?: ManifestAbi
  types?: Record<string, ManifestType>
}

function document(): Manifest {
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

/** The layouts, from either document shape. */
function manifest(): Record<string, ManifestType> {
  const doc = document()
  return (doc.types ?? (doc as unknown as Record<string, ManifestType>)) as Record<string, ManifestType>
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
      'GhosttyRenderStateCursor',
      'GhosttyRenderStateColors',
    ]) {
      expect(m[t], `manifest is missing ${t}`).toBeDefined()
    }
  })

  it('agrees with us about what a wasm32 pointer and size_t are', () => {
    const { abi: a } = document()
    // Older binaries carry no abi block; there is nothing to check against.
    if (!a) return
    expect(a.target).toBe('wasm32')
    expect(a.pointer_size).toBe(4)
    // The constant that replaced the retired `ghostty_wasm_alloc_usize`, which
    // reserved exactly this much. Asserted rather than assumed because every
    // call site that used to say `alloc_usize()` now says `alloc(USIZE_BYTES)`.
    expect(abi.USIZE_BYTES).toBe(a.usize_size)
    // `ghostty_wasm_alloc` promises this alignment, which is what makes it safe
    // to hand one of its buffers to a struct-shaped out-parameter.
    expect(a.max_alignment).toBeGreaterThanOrEqual(m.GhosttyPoint.align)
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

  it('GhosttyRenderStateCursor — including the holes alignment leaves', () => {
    expect(abi.RS_CURSOR_SIZE).toBe(m.GhosttyRenderStateCursor.size)
    for (const [name, ours] of [
      ['size', abi.RS_CURSOR_OFF_SIZE],
      ['viewport_has_value', abi.RS_CURSOR_OFF_VIEWPORT_HAS_VALUE],
      ['viewport_x', abi.RS_CURSOR_OFF_VIEWPORT_X],
      ['viewport_y', abi.RS_CURSOR_OFF_VIEWPORT_Y],
      ['wide_tail', abi.RS_CURSOR_OFF_WIDE_TAIL],
      ['visible', abi.RS_CURSOR_OFF_VISIBLE],
      ['blinking', abi.RS_CURSOR_OFF_BLINKING],
      ['password_input', abi.RS_CURSOR_OFF_PASSWORD_INPUT],
      ['visual_style', abi.RS_CURSOR_OFF_VISUAL_STYLE],
    ] as const) {
      expect(ours, name).toBe(field('GhosttyRenderStateCursor', name).offset)
    }

    // The two gaps are the whole reason this is transcribed rather than counted:
    // a `uint16_t` cannot follow a `bool` at +5, nor a 4-byte enum at +14.
    // Counting the fields off the header gives 5 and 14 and reads plausible.
    expect(abi.RS_CURSOR_OFF_VIEWPORT_X).toBeGreaterThan(
      field('GhosttyRenderStateCursor', 'viewport_has_value').offset + 1,
    )
    expect(abi.RS_CURSOR_OFF_VISUAL_STYLE).toBeGreaterThan(
      field('GhosttyRenderStateCursor', 'password_input').offset + 1,
    )
  })

  it('GhosttyRenderStateColors — three packed colours, then the palette', () => {
    expect(abi.RS_COLORS_SIZE).toBe(m.GhosttyRenderStateColors.size)
    for (const [name, ours] of [
      ['size', abi.RS_COLORS_OFF_SIZE],
      ['background', abi.RS_COLORS_OFF_BACKGROUND],
      ['foreground', abi.RS_COLORS_OFF_FOREGROUND],
      ['cursor', abi.RS_COLORS_OFF_CURSOR],
      ['cursor_has_value', abi.RS_COLORS_OFF_CURSOR_HAS_VALUE],
      ['palette', abi.RS_COLORS_OFF_PALETTE],
    ] as const) {
      expect(ours, name).toBe(field('GhosttyRenderStateColors', name).offset)
    }

    // Packed at a 3-byte stride, not padded to 4. At a 4-byte stride the
    // foreground's red would be read as part of the background and every colour
    // after it would shift — which looks like a theme bug, not a layout one.
    const rgb = m.GhosttyColorRgb.size
    expect(abi.RS_COLORS_OFF_FOREGROUND).toBe(abi.RS_COLORS_OFF_BACKGROUND + rgb)
    expect(abi.RS_COLORS_OFF_CURSOR).toBe(abi.RS_COLORS_OFF_FOREGROUND + rgb)

    // The palette is inline and is most of the struct, which is why this gets
    // its own buffer in the shim rather than borrowing the 16-byte scratch.
    expect(field('GhosttyRenderStateColors', 'palette').size).toBe(abi.PALETTE_ENTRIES * rgb)
  })

  it('GhosttyColorRgb is the unit PALETTE_BYTES counts in', () => {
    expect(abi.COLOR_RGB_BYTES).toBe(m.GhosttyColorRgb.size)
    expect(abi.PALETTE_BYTES).toBe(abi.PALETTE_ENTRIES * m.GhosttyColorRgb.size)
  })
})
