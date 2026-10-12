/**
 * The mouse-encoding half of ghostty `main`'s C API, as constants,
 * transcribed from `include/ghostty/vt/mouse/{event,encoder}.h` at the pin in
 * `../vendorPin.ts`. Five wire formats (X10, its UTF-8 extension, urxvt, SGR,
 * SGR pixels) and five tracking modes, chosen by the far end at runtime. See
 * `../MouseEncoder.ts` for the wrapper.
 */

/** `GhosttyMouseAction`. */
export const MOUSE_ACTION_PRESS = 0
export const MOUSE_ACTION_RELEASE = 1
export const MOUSE_ACTION_MOTION = 2

/**
 * `GhosttyMouseButton`: 1 left, 2 right, 3 middle, unlike the DOM's 0 left,
 * 1 middle, 2 right. Always go through `mouseButtonFor`. "No button" is
 * `clear_button`, not a value.
 */
export const MOUSE_BUTTON_LEFT = 1
export const MOUSE_BUTTON_RIGHT = 2
export const MOUSE_BUTTON_MIDDLE = 3
export const MOUSE_BUTTON_FOUR = 4
export const MOUSE_BUTTON_FIVE = 5
export const MOUSE_BUTTON_SIX = 6
export const MOUSE_BUTTON_SEVEN = 7

/**
 * The wheel, reported as buttons: four and five are a line up and down, six
 * and seven a column left and right. The encoder adds the wire form's +64.
 */
export const MOUSE_BUTTON_WHEEL_UP = MOUSE_BUTTON_FOUR
export const MOUSE_BUTTON_WHEEL_DOWN = MOUSE_BUTTON_FIVE
export const MOUSE_BUTTON_WHEEL_LEFT = MOUSE_BUTTON_SIX
export const MOUSE_BUTTON_WHEEL_RIGHT = MOUSE_BUTTON_SEVEN

/**
 * `MouseEvent.button` to `GhosttyMouseButton`. Past the fifth button there's
 * no agreed meaning, so it's unknown.
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
 * `GhosttyMouseEncoderSize` field offsets on wasm32 (four-byte `size_t`).
 * Padding is top, bottom, right, left; swapping the last two misplaces the
 * origin with asymmetric padding.
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
