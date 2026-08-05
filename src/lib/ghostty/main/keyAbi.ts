/**
 * The key-encoding half of ghostty `main`'s C API, as constants.
 *
 * Sibling to `abi.ts`, kept separate because it describes a different object:
 * `abi.ts` is the terminal and its screen, this is the encoder that turns key
 * events into the bytes a program expects. Both are transcribed from the
 * headers at the pin in `../vendorPin.ts` — here,
 * `include/ghostty/vt/key/{event,encoder}.h`.
 *
 * The encoder is the reason this app does not own a keyboard table at all.
 * Legacy xterm encoding, xterm's `modifyOtherKeys`, and the Kitty keyboard
 * protocol are three overlapping specs whose differences are exactly the
 * cases nobody thinks to test — Ctrl+Shift+letter, Alt on a key that has no
 * unmodified byte, what a function key does once an application has pushed
 * flags. Ghostty implements all three, against its own test suite, and
 * `setopt_from_terminal` keeps the choice in step with the modes the far end
 * has actually set. See `../KeyEncoder.ts` for the wrapper.
 */

/**
 * Physical keys, in header order — the index *is* the `GhosttyKey` value.
 *
 * These are W3C UI Events `code` values, which is the same vocabulary the DOM
 * hands us on `KeyboardEvent.code`, so the mapping is a lookup rather than a
 * translation. They are layout-*independent*: `KeyQ` is the physical key in
 * that position whatever it prints, and the character it produces travels
 * separately as UTF-8 text.
 *
 * `Unidentified` at index 0 is upstream's own name for "no key", and is the
 * value a `code` we don't recognise maps to.
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
 * The numeric keypad with Num Lock **off**, where `code` alone is not enough.
 *
 * Upstream has a distinct key for each of these — `NumpadEnd` is not `End` and
 * not `Numpad1` — because a terminal encodes them differently under
 * application keypad mode. Every other platform Ghostty runs on reports which
 * one it is. The DOM does not: `code` stays `Numpad1` whatever Num Lock is
 * doing, and the only thing that changes is `key`, which becomes the
 * navigation name. So the pair is what identifies the key here.
 *
 * Getting this wrong is silent and total: without it the encoder is handed
 * `Numpad1`, decides that is a digit key that produced no digit, and returns
 * nothing — a numpad that does nothing at all with Num Lock off.
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
 * The `code` a `key` name implies, for events that carry no `code` at all.
 *
 * Chromium derives `code` from the hardware scan code, so an event with no
 * scan code behind it arrives with `code: ""`. That is not hypothetical and it
 * is not only automation (`SendInput` without `KEYEVENTF_SCANCODE`, which is
 * what caught this): on-screen and virtual keyboards, and some remote-desktop
 * and KVM stacks, inject virtual keys the same way. The table this file
 * replaced keyed off `key`, so those sources used to work — without a fallback
 * the swap would have made every control key on them dead, silently.
 *
 * Deliberately narrow. For every non-printable key the W3C `code` and `key`
 * names are the same string (`ArrowUp`, `Enter`, `F5`), so the main table
 * already answers those; this only has to cover letters and digits, where
 * `key` is the character and `code` is `KeyA`/`Digit1`. Punctuation is left
 * out on purpose — `/` is `Slash` only on a US layout, and guessing wrong
 * sends a different key rather than none.
 */
function codeFromKeyName(keyName: string): string | null {
  if (keyName.length !== 1) return null
  const c = keyName.charCodeAt(0)
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) return `Key${keyName.toUpperCase()}`
  if (c >= 48 && c <= 57) return `Digit${keyName}`
  return null
}

/**
 * The `GhosttyKey` for a DOM key event, or `KEY_UNIDENTIFIED`.
 *
 * A `code` we don't know is not an error worth reporting: the table covers
 * every key upstream has a name for, and what is left is a vendor key on a
 * gaming keyboard. Encoding it as "unidentified" is how it produces nothing.
 */
export function keyFor(code: string, keyName: string): number {
  if (code.startsWith('Numpad')) {
    const nav = NUMPAD_NAV[keyName]
    if (nav !== undefined) return KEY_BY_CODE.get(nav) ?? KEY_UNIDENTIFIED
  }
  const byCode = KEY_BY_CODE.get(code)
  if (byCode !== undefined) return byCode
  // Only once `code` has failed, so a keyboard that reports one is never
  // second-guessed by a layout assumption.
  const implied = codeFromKeyName(keyName)
  if (implied !== null) return KEY_BY_CODE.get(implied) ?? KEY_UNIDENTIFIED
  return KEY_BY_CODE.get(keyName) ?? KEY_UNIDENTIFIED
}

/** `GhosttyMods`, a `uint16_t`. The side bits above bit 5 are deliberately
 *  unused here — see `../KeyEncoder.ts`. */
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
 * `GhosttyKeyEncoderOption`. Every one of these is set for us by
 * `ghostty_key_encoder_setopt_from_terminal` except `MACOS_OPTION_AS_ALT`,
 * which has no terminal state behind it and no meaning on Windows.
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
 * `GhosttyKittyKeyFlags`, the progressive-enhancement bits an application
 * pushes with `CSI > flags u`. Read from the terminal rather than chosen here;
 * they are named because the status of a pane's keyboard is worth being able
 * to inspect and test against.
 */
export const KITTY_KEY_DISABLED = 0
export const KITTY_KEY_DISAMBIGUATE = 1 << 0
export const KITTY_KEY_REPORT_EVENTS = 1 << 1
export const KITTY_KEY_REPORT_ALTERNATES = 1 << 2
export const KITTY_KEY_REPORT_ALL = 1 << 3
export const KITTY_KEY_REPORT_ASSOCIATED = 1 << 4
