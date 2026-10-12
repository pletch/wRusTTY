/**
 * `abi.ts`'s struct layouts, checked against the binary's own manifest
 * (`ghostty_type_json`: size, alignment and every field's offset).
 *
 * The offsets in `abi.ts` were probed (write a value, read it back), which
 * can't find where a struct ends: an unread union tail has no observable
 * position. Unlike `abi.parity.test.ts`, which proves the values behave, this
 * proves they match upstream, so a wrong constant no call path exercises
 * still fails, with both numbers.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abi from './abi'

const here = dirname(fileURLToPath(import.meta.url))
/** The shipped binary, whose layouts `abi.ts` must match. */
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
 * The whole document. Since the `d9ffbbf17` pin it's
 * `{ schema, abi, library_version, commit, dirty, types }`; older binaries
 * emit a bare map of type name to layout. `schema` discriminates, so both are
 * accepted.
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
  // Null-terminated, valid for the module's life.
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
    // If a rebuild stopped emitting these, every assertion below would pass on
    // an empty object.
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
      'GhosttySelection',
      'GhosttySelectionBuffer',
      'GhosttyString',
    ]) {
      expect(m[t], `manifest is missing ${t}`).toBeDefined()
    }
  })

  it('agrees with us about what a wasm32 pointer and size_t are', () => {
    const { abi: a } = document()
    // Older binaries carry no abi block.
    if (!a) return
    expect(a.target).toBe('wasm32')
    expect(a.pointer_size).toBe(4)
    // Replaced `ghostty_wasm_alloc_usize`; call sites now use
    // `alloc(USIZE_BYTES)`.
    expect(abi.USIZE_BYTES).toBe(a.usize_size)
    // This alignment makes `ghostty_wasm_alloc` buffers safe as struct
    // out-parameters.
    expect(a.max_alignment).toBeGreaterThanOrEqual(m.GhosttyPoint.align)
  })

  it('GhosttyPoint — the one probing got wrong', () => {
    expect(abi.POINT_SIZE).toBe(m.GhosttyPoint.size)
    expect(abi.POINT_OFF_TAG).toBe(field('GhosttyPoint', 'tag').offset)

    // x and y belong to the union's coordinate arm, so offsets add up.
    const value = field('GhosttyPoint', 'value')
    expect(abi.POINT_OFF_X).toBe(value.offset + field('GhosttyPointCoordinate', 'x').offset)
    expect(abi.POINT_OFF_Y).toBe(value.offset + field('GhosttyPointCoordinate', 'y').offset)

    // The union is wider than the arm we read, so the struct extends past the
    // probed fields.
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

  /**
   * The native search path's types, written by us and read by the core (the
   * selection and each buffer element carry a `size` field).
   */
  it('GhosttySelection and its buffer', () => {
    expect(abi.SELECTION_SIZE).toBe(m.GhosttySelection.size)
    expect(abi.SELECTION_OFF_SIZE).toBe(field('GhosttySelection', 'size').offset)
    expect(abi.SELECTION_OFF_START).toBe(field('GhosttySelection', 'start').offset)
    expect(abi.SELECTION_OFF_END).toBe(field('GhosttySelection', 'end').offset)
    expect(abi.SELECTION_OFF_RECTANGLE).toBe(field('GhosttySelection', 'rectangle').offset)
    // Endpoints are grid refs, convertible with point_from_grid_ref.
    expect(field('GhosttySelection', 'start').size).toBe(abi.GRID_REF_SIZE)

    expect(abi.SELECTION_BUFFER_SIZE).toBe(m.GhosttySelectionBuffer.size)
    expect(abi.SELECTION_BUFFER_OFF_PTR).toBe(field('GhosttySelectionBuffer', 'ptr').offset)
    expect(abi.SELECTION_BUFFER_OFF_CAP).toBe(field('GhosttySelectionBuffer', 'cap').offset)
    expect(abi.SELECTION_BUFFER_OFF_LEN).toBe(field('GhosttySelectionBuffer', 'len').offset)
  })

  /** The needle, and `point_from_grid_ref`'s out-parameter (a
   *  `GhosttyPointCoordinate`, not `GhosttyPoint`). `y` is at +4: a u32 after a
   *  u16 is aligned. */
  it('GhosttyString and GhosttyPointCoordinate', () => {
    expect(abi.STRING_SIZE).toBe(m.GhosttyString.size)
    expect(abi.STRING_OFF_PTR).toBe(field('GhosttyString', 'ptr').offset)
    expect(abi.STRING_OFF_LEN).toBe(field('GhosttyString', 'len').offset)

    expect(abi.POINT_COORDINATE_SIZE).toBe(m.GhosttyPointCoordinate.size)
    expect(abi.POINT_COORDINATE_OFF_X).toBe(field('GhosttyPointCoordinate', 'x').offset)
    expect(abi.POINT_COORDINATE_OFF_Y).toBe(field('GhosttyPointCoordinate', 'y').offset)
  })

  it('GhosttyStyle — size, colors and the attribute bytes', () => {
    expect(abi.STYLE_SIZE).toBe(m.GhosttyStyle.size)
    expect(abi.STYLE_OFF_SIZE).toBe(field('GhosttyStyle', 'size').offset)

    // Each color is a nested GhosttyStyleColor, so offsets add up.
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

    // Upstream's `underline`; ours says UNDERLINE_STYLE to keep it apart from
    // the color.
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

    // Alignment gaps: a `uint16_t` can't follow a `bool` at +5, nor a 4-byte
    // enum at +14, though counting fields off the header suggests it.
    expect(abi.RS_CURSOR_OFF_VIEWPORT_X).toBeGreaterThan(
      field('GhosttyRenderStateCursor', 'viewport_has_value').offset + 1,
    )
    expect(abi.RS_CURSOR_OFF_VISUAL_STYLE).toBeGreaterThan(
      field('GhosttyRenderStateCursor', 'password_input').offset + 1,
    )
  })

  it('GhosttyRenderStateColors — three packed colors, then the palette', () => {
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

    // A 3-byte stride, not 4; a 4-byte stride would shift every color after the
    // first.
    const rgb = m.GhosttyColorRgb.size
    expect(abi.RS_COLORS_OFF_FOREGROUND).toBe(abi.RS_COLORS_OFF_BACKGROUND + rgb)
    expect(abi.RS_COLORS_OFF_CURSOR).toBe(abi.RS_COLORS_OFF_FOREGROUND + rgb)

    // The inline palette is most of the struct, hence its own buffer in the
    // shim.
    expect(field('GhosttyRenderStateColors', 'palette').size).toBe(abi.PALETTE_ENTRIES * rgb)
  })

  it('GhosttyColorRgb is the unit PALETTE_BYTES counts in', () => {
    expect(abi.COLOR_RGB_BYTES).toBe(m.GhosttyColorRgb.size)
    expect(abi.PALETTE_BYTES).toBe(abi.PALETTE_ENTRIES * m.GhosttyColorRgb.size)
  })
})
