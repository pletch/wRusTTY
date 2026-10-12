/**
 * The key-encoding half of ghostty `main`'s C API, as constants. Separate
 * from `abi.ts` (the terminal and screen); transcribed from
 * `include/ghostty/vt/key/{event,encoder}.h` at the pin in `../vendorPin.ts`.
 * See `../KeyEncoder.ts` for the wrapper.
 */

/**
 * Physical keys in header order; the index is the `GhosttyKey` value. These
 * are W3C `code` values, the same vocabulary as `KeyboardEvent.code`, and
 * layout-independent. `Unidentified` (0) is what an unknown `code` maps to.
 */
export const KEY_CODES: readonly string[] = [
  'Unidentified', 'Backquote', 'Backslash', 'BracketLeft', 'BracketRight', 'Comma', 'Digit0',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Equal', 'IntlBackslash', 'IntlRo', 'IntlYen', 'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE',
  'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP',
  'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ', 'Minus',
  'Period', 'Quote', 'Semicolon', 'Slash', 'AltLeft', 'AltRight', 'Backspace', 'CapsLock',
  'ContextMenu', 'ControlLeft', 'ControlRight', 'Enter', 'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight', 'Space', 'Tab', 'Convert', 'KanaMode', 'NonConvert', 'Delete',
  'End', 'Help', 'Home', 'Insert', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowLeft',
  'ArrowRight', 'ArrowUp', 'NumLock', 'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4',
  'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'NumpadAdd', 'NumpadBackspace',
  'NumpadClear', 'NumpadClearEntry', 'NumpadComma', 'NumpadDecimal', 'NumpadDivide',
  'NumpadEnter', 'NumpadEqual', 'NumpadMemoryAdd', 'NumpadMemoryClear', 'NumpadMemoryRecall',
  'NumpadMemoryStore', 'NumpadMemorySubtract', 'NumpadMultiply', 'NumpadParenLeft',
  'NumpadParenRight', 'NumpadSubtract', 'NumpadSeparator', 'NumpadUp', 'NumpadDown',
  'NumpadRight', 'NumpadLeft', 'NumpadBegin', 'NumpadHome', 'NumpadEnd', 'NumpadInsert',
  'NumpadDelete', 'NumpadPageUp', 'NumpadPageDown', 'Escape', 'F1', 'F2', 'F3', 'F4', 'F5',
  'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18',
  'F19', 'F20', 'F21', 'F22', 'F23', 'F24', 'F25', 'Fn', 'FnLock', 'PrintScreen',
  'ScrollLock', 'Pause', 'BrowserBack', 'BrowserFavorites', 'BrowserForward', 'BrowserHome',
  'BrowserRefresh', 'BrowserSearch', 'BrowserStop', 'Eject', 'LaunchApp1', 'LaunchApp2',
  'LaunchMail', 'MediaPlayPause', 'MediaSelect', 'MediaStop', 'MediaTrackNext',
  'MediaTrackPrevious', 'Power', 'Sleep', 'AudioVolumeDown', 'AudioVolumeMute',
  'AudioVolumeUp', 'WakeUp', 'Copy', 'Cut', 'Paste',
]

export const KEY_UNIDENTIFIED = 0

/** `code` → `GhosttyKey`, built once from the order above. */
const KEY_BY_CODE = new Map(KEY_CODES.map((code, value) => [code, value]))

/**
 * The numeric keypad with Num Lock off. Upstream has a distinct key for each
 * (`NumpadEnd` is neither `End` nor `Numpad1`), but the DOM keeps `code` at
 * `Numpad1` and changes only `key`, so the pair identifies it. Without this,
 * the keypad does nothing with Num Lock off.
 */
const NUMPAD_NAV: Readonly<Record<string, string>> = {
  Insert: 'NumpadInsert',
  End: 'NumpadEnd',
  ArrowDown: 'NumpadDown',
  PageDown: 'NumpadPageDown',
  ArrowLeft: 'NumpadLeft',
  Clear: 'NumpadBegin',
  ArrowRight: 'NumpadRight',
  Home: 'NumpadHome',
  ArrowUp: 'NumpadUp',
  PageUp: 'NumpadPageUp',
  Delete: 'NumpadDelete',
}

/**
 * The `code` a `key` name implies, for events with `code: ""`. Chromium
 * derives `code` from the scan code, so injected keys (`SendInput` without
 * `KEYEVENTF_SCANCODE`, on-screen keyboards, some remote-desktop and KVM
 * stacks) have none.
 *
 * Only letters and digits: for non-printable keys `code` and `key` already
 * match (`ArrowUp`, `F5`). Punctuation is layout-dependent, and guessing wrong
 * sends a different key.
 */
function codeFromKeyName(keyName: string): string | null {
  if (keyName.length !== 1) return null
  const c = keyName.charCodeAt(0)
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) return `Key${keyName.toUpperCase()}`
  if (c >= 48 && c <= 57) return `Digit${keyName}`
  return null
}

/**
 * The `GhosttyKey` for a DOM key event, or `KEY_UNIDENTIFIED` (a vendor key
 * upstream has no name for), which produces nothing.
 */
export function keyFor(code: string, keyName: string): number {
  if (code.startsWith('Numpad')) {
    const nav = NUMPAD_NAV[keyName]
    if (nav !== undefined) return KEY_BY_CODE.get(nav) ?? KEY_UNIDENTIFIED
  }
  const byCode = KEY_BY_CODE.get(code)
  if (byCode !== undefined) return byCode
  // Only after `code` fails, so a reported code is never second-guessed.
  const implied = codeFromKeyName(keyName)
  if (implied !== null) return KEY_BY_CODE.get(implied) ?? KEY_UNIDENTIFIED
  return KEY_BY_CODE.get(keyName) ?? KEY_UNIDENTIFIED
}

/** `GhosttyMods`, a `uint16_t`. The side bits above bit 5 are unused (see
 *  `../KeyEncoder.ts`). */
export const MODS_SHIFT = 1 << 0
export const MODS_CTRL = 1 << 1
export const MODS_ALT = 1 << 2
export const MODS_SUPER = 1 << 3
export const MODS_CAPS_LOCK = 1 << 4
export const MODS_NUM_LOCK = 1 << 5

/** `GhosttyKeyAction`. */
export const KEY_ACTION_RELEASE = 0
export const KEY_ACTION_PRESS = 1
export const KEY_ACTION_REPEAT = 2

/**
 * `GhosttyKeyEncoderOption`. `setopt_from_terminal` sets all of these except
 * `MACOS_OPTION_AS_ALT`, which has no meaning on Windows.
 */
export const KEY_ENCODER_OPT_CURSOR_KEY_APPLICATION = 0
export const KEY_ENCODER_OPT_KEYPAD_KEY_APPLICATION = 1
export const KEY_ENCODER_OPT_IGNORE_KEYPAD_WITH_NUMLOCK = 2
export const KEY_ENCODER_OPT_ALT_ESC_PREFIX = 3
export const KEY_ENCODER_OPT_MODIFY_OTHER_KEYS_STATE_2 = 4
export const KEY_ENCODER_OPT_KITTY_FLAGS = 5
export const KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT = 6
export const KEY_ENCODER_OPT_BACKARROW_KEY_MODE = 7

/**
 * `GhosttyKittyKeyFlags`, the bits an application pushes with `CSI > flags u`.
 * Read from the terminal; named for inspection and tests.
 */
export const KITTY_KEY_DISABLED = 0
export const KITTY_KEY_DISAMBIGUATE = 1 << 0
export const KITTY_KEY_REPORT_EVENTS = 1 << 1
export const KITTY_KEY_REPORT_ALTERNATES = 1 << 2
export const KITTY_KEY_REPORT_ALL = 1 << 3
export const KITTY_KEY_REPORT_ASSOCIATED = 1 << 4
