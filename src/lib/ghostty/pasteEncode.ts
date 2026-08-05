/**
 * Paste, encoded by the engine rather than by us.
 *
 * ## Why this exists
 *
 * `GhosttyEngine.paste` used to be four lines: read DEC 2004, and if it was
 * set, concatenate `ESC [ 200 ~` and `ESC [ 201 ~` around the text. Both
 * halves of that were wrong.
 *
 * - **It pasted the terminator.** Text containing `ESC [ 201 ~` ends the
 *   bracketed paste early, and everything after it arrives as *typing* — at a
 *   shell prompt, as a command line the user never ran. That is the standard
 *   bracketed-paste breakout, and copying from a web page is exactly how the
 *   bytes get into a clipboard. The encoder replaces every ESC with a space,
 *   so the sequence arrives inert as `[201~`.
 * - **It sent newlines raw when bracketing was off.** A PTY wants a carriage
 *   return for Enter; a bare `\n` is not what a terminal sends and not what
 *   the line discipline is waiting for. The encoder converts.
 *
 * Neither is a formatting nicety, which is why this went the way of the key
 * and mouse encoders rather than being patched in place.
 *
 * ## Not an encoder object
 *
 * Unlike its two siblings these are free functions upstream: no handle, no
 * terminal, no state to keep in step. Bracketing is a mode the *caller* reads
 * and passes in, because it is the only piece of terminal state involved. So
 * this is a module of functions rather than a class, and the allocations
 * happen per paste — which is a human-scale event, not a keystroke.
 */

import * as abi from './main/abi'
import type { GhosttyWasm } from './wasmBindings'

/** Bracketing adds `ESC [ 200 ~` and `ESC [ 201 ~`: six bytes at each end. */
const BRACKET_OVERHEAD = 12

const utf8 = new TextEncoder()

function exportsOf(wasm: GhosttyWasm): abi.GhosttyMainExports {
  return wasm.instance.exports as unknown as abi.GhosttyMainExports
}

/** Whether the binary carries the paste API — false only on the v1.3.1 oracle
 *  build, which the app never loads. Same contract as the other two encoders. */
export function hasPasteEncoder(wasm: GhosttyWasm): boolean {
  return typeof exportsOf(wasm).ghostty_paste_encode === 'function'
}

/**
 * Whether this text can be pasted without asking first.
 *
 * Upstream's rule, and deliberately conservative: false for any newline, and
 * false for an embedded bracketed-paste terminator. The second is the one a
 * line count cannot see — a single-line paste carrying `ESC [ 201 ~` looks
 * completely ordinary and is the dangerous case.
 */
export function pasteIsSafe(wasm: GhosttyWasm, text: string): boolean {
  const ex = exportsOf(wasm)
  const bytes = utf8.encode(text)
  if (bytes.length === 0) return true
  const ptr = ex.ghostty_wasm_alloc_u8_array(bytes.length)
  if (ptr === 0) return false
  try {
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes)
    return ex.ghostty_paste_is_safe(ptr, bytes.length) !== 0
  } finally {
    ex.ghostty_wasm_free_u8_array(ptr, bytes.length)
  }
}

/**
 * The bytes a paste should put on the wire: unsafe control bytes replaced by
 * spaces, wrapped in the bracketed-paste sequences when `bracketed`, and with
 * newlines turned into carriage returns when it is not.
 *
 * `bracketed` is the caller's to read — see the note above.
 */
export function encodePaste(wasm: GhosttyWasm, text: string, bracketed: boolean): Uint8Array {
  const ex = exportsOf(wasm)
  const bytes = utf8.encode(text)

  // The input is modified in place, so the buffer has to be writable and has
  // to be refillable: a retry re-copies from `bytes` rather than reusing
  // whatever the failed call left behind.
  const dataLen = bytes.length
  const dataPtr = ex.ghostty_wasm_alloc_u8_array(Math.max(1, dataLen))
  const lenSlot = ex.ghostty_wasm_alloc_usize()
  // Sized so the common case is a single call: stripping never grows the text
  // and bracketing is the only thing that adds to it.
  let outSize = dataLen + BRACKET_OVERHEAD
  let outPtr = ex.ghostty_wasm_alloc_u8_array(outSize)

  try {
    if (dataLen > 0) new Uint8Array(ex.memory.buffer, dataPtr, dataLen).set(bytes)
    let result = ex.ghostty_paste_encode(
      dataPtr,
      dataLen,
      bracketed ? 1 : 0,
      outPtr,
      outSize,
      lenSlot,
    )
    let written = new DataView(ex.memory.buffer).getUint32(lenSlot, true)

    if (result === abi.GHOSTTY_OUT_OF_SPACE) {
      ex.ghostty_wasm_free_u8_array(outPtr, outSize)
      outSize = written
      outPtr = ex.ghostty_wasm_alloc_u8_array(Math.max(1, outSize))
      // Refilled, because the call above consumed it in place.
      if (dataLen > 0) new Uint8Array(ex.memory.buffer, dataPtr, dataLen).set(bytes)
      result = ex.ghostty_paste_encode(
        dataPtr,
        dataLen,
        bracketed ? 1 : 0,
        outPtr,
        outSize,
        lenSlot,
      )
      written = new DataView(ex.memory.buffer).getUint32(lenSlot, true)
    }

    if (result !== abi.GHOSTTY_SUCCESS) return new Uint8Array(0)
    // Copied out: the next paste writes over this buffer, and linear memory
    // can move under a view that outlives the call.
    return new Uint8Array(ex.memory.buffer, outPtr, written).slice()
  } finally {
    ex.ghostty_wasm_free_u8_array(dataPtr, Math.max(1, dataLen))
    ex.ghostty_wasm_free_u8_array(outPtr, Math.max(1, outSize))
    ex.ghostty_wasm_free_usize(lenSlot)
  }
}
