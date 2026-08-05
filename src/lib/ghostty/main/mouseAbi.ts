/**
 * The mouse-encoding half of ghostty `main`'s C API, as constants.
 *
 * Third sibling to `abi.ts` and `keyAbi.ts`, and transcribed the same way:
 * from the headers at the pin in `../vendorPin.ts`, here
 * `include/ghostty/vt/mouse/{event,encoder}.h`.
 *
 * The encoder exists for the same reason the key one does. There are five
 * wire formats for a mouse report — the original one-byte X10 form, its UTF-8
 * extension, urxvt's, SGR, and SGR in pixels — and five tracking modes that
 * decide *which* events are worth reporting at all. The far end picks both at
 * runtime with DEC private modes, and the combinations are where hand-rolled
 * reporting goes wrong: X10 is press-only, the legacy form cannot describe a
 * column past 223, and a release in that form cannot say which button came up.
 * See `../MouseEncoder.ts` for the wrapper.
 */

/** `GhosttyMouseAction`. */
export const MOUSE_ACTION_PRESS = 0
export const MOUSE_ACTION_RELEASE = 1
export const MOUSE_ACTION_MOTION = 2

/**
 * `GhosttyMouseButton`. **Not** the DOM's numbering, which is the trap here:
 * `MouseEvent.button` is 0 left, 1 middle, 2 right, and this is 1 left,
 * 2 right, 3 middle. Going through `mouseButtonFor` is what keeps a
 * middle-click from being reported as a right-click.
 *
 * There is no button 0; "no button" is `clear_button`, not a value.
 */
export const MOUSE_BUTTON_LEFT = 1
export const MOUSE_BUTTON_RIGHT = 2
export const MOUSE_BUTTON_MIDDLE = 3
export const MOUSE_BUTTON_FOUR = 4
export const MOUSE_BUTTON_FIVE = 5
export const MOUSE_BUTTON_SIX = 6
export const MOUSE_BUTTON_SEVEN = 7

/**
 * The wheel, which the protocols report as buttons rather than as an axis:
 * four and five are one line up and down, six and seven one column left and
 * right. The encoder adds the +64 that marks them as wheel in the wire form.
 */
export const MOUSE_BUTTON_WHEEL_UP = MOUSE_BUTTON_FOUR
export const MOUSE_BUTTON_WHEEL_DOWN = MOUSE_BUTTON_FIVE
export const MOUSE_BUTTON_WHEEL_LEFT = MOUSE_BUTTON_SIX
export const MOUSE_BUTTON_WHEEL_RIGHT = MOUSE_BUTTON_SEVEN

/**
 * `MouseEvent.button` to `GhosttyMouseButton`.
 *
 * Anything past the fifth button is reported as unknown rather than guessed
 * at: the DOM's numbering runs out of agreed meaning there, and inventing one
 * would put a button on the wire that nobody pressed.
 */
export function mouseButtonFor(domButton: number): number | null {
  switch (domButton) {
    case 0:
      return MOUSE_BUTTON_LEFT
    case 1:
      return MOUSE_BUTTON_MIDDLE
    case 2:
      return MOUSE_BUTTON_RIGHT
    case 3:
      return MOUSE_BUTTON_FOUR
    case 4:
      return MOUSE_BUTTON_FIVE
    default:
      return null
  }
}

/** `GhosttyMouseEncoderOption`. */
export const MOUSE_ENCODER_OPT_EVENT = 0
export const MOUSE_ENCODER_OPT_FORMAT = 1
export const MOUSE_ENCODER_OPT_SIZE = 2
export const MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED = 3
export const MOUSE_ENCODER_OPT_TRACK_LAST_CELL = 4

/**
 * `GhosttyMouseEncoderSize`, field offsets in bytes on wasm32 where `size_t`
 * is four bytes wide.
 *
 * The padding order is the header's — top, bottom, **right, left** — which is
 * not the order anyone writes CSS in, and swapping the last two puts the
 * origin in the wrong place on any pane with asymmetric padding.
 */
export const MOUSE_SIZE_BYTES = 36
export const MOUSE_SIZE_OFF_SIZE = 0
export const MOUSE_SIZE_OFF_SCREEN_WIDTH = 4
export const MOUSE_SIZE_OFF_SCREEN_HEIGHT = 8
export const MOUSE_SIZE_OFF_CELL_WIDTH = 12
export const MOUSE_SIZE_OFF_CELL_HEIGHT = 16
export const MOUSE_SIZE_OFF_PADDING_TOP = 20
export const MOUSE_SIZE_OFF_PADDING_BOTTOM = 24
export const MOUSE_SIZE_OFF_PADDING_RIGHT = 28
export const MOUSE_SIZE_OFF_PADDING_LEFT = 32

/** `GhosttyMousePosition`: two `f32`, surface pixels. */
export const MOUSE_POSITION_BYTES = 8
