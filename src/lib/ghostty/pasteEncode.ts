/**
 * Paste, encoded by the engine.
 *
 * The encoder replaces every ESC with a space, so an embedded `ESC [ 201 ~`
 * can't end a bracketed paste early and turn the rest into typed commands,
 * and converts newlines to carriage returns when bracketing is off.
 *
 * Upstream exposes free functions, not an encoder object: bracketing is the
 * only terminal state involved, and the caller reads and passes it.
 * Allocations happen per paste, a human-scale event.
 */

import * as abi from './main/abi'
import type { GhosttyWasm } from './wasmBindings'

/** Bracketing adds `ESC [ 200 ~` and `ESC [ 201 ~`: six bytes at each end. */
const BRACKET_OVERHEAD = 12

const utf8 = new TextEncoder()

/**
 * CRLF collapsed to LF. `CF_UNICODETEXT` is CRLF-delimited and arboard passes
 * it through, and the encoder doesn't expect it: unbracketed, CR and LF each
 * become a carriage return; bracketed, bash maps the CR to a newline. Either
 * way every line is doubled, which changes a command after a `\`
 * continuation. A lone CR is left alone (see `pasteIsSafe`).
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function exportsOf(wasm: GhosttyWasm): abi.GhosttyMainExports {
  return wasm.instance.exports as unknown as abi.GhosttyMainExports
}

/** Whether the binary has the paste API (false only on the v1.3.1 oracle). */
export function hasPasteEncoder(wasm: GhosttyWasm): boolean {
  return typeof exportsOf(wasm).ghostty_paste_encode === 'function'
}

/**
 * Whether this text can be pasted without asking. Upstream's rule: false for
 * any newline or an embedded bracketed-paste terminator (a single-line paste
 * carrying `ESC [ 201 ~` looks ordinary).
 */
export function pasteIsSafe(wasm: GhosttyWasm, text: string): boolean {
  const ex = exportsOf(wasm)
  const bytes = utf8.encode(normalizeNewlines(text))
  if (bytes.length === 0) return true
  const ptr = ex.ghostty_wasm_alloc(bytes.length)
  if (ptr === 0) return false
  try {
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes)
    return ex.ghostty_paste_is_safe(ptr, bytes.length) !== 0
  } finally {
    ex.ghostty_wasm_free(ptr, bytes.length)
  }
}

/**
 * The bytes a paste should send: unsafe controls replaced by spaces, wrapped
 * in bracketed-paste sequences when `bracketed`, otherwise with newlines as
 * carriage returns.
 */
export function encodePaste(wasm: GhosttyWasm, text: string, bracketed: boolean): Uint8Array {
  const ex = exportsOf(wasm)
  const bytes = utf8.encode(normalizeNewlines(text))

  // Modified in place, so a retry re-copies from `bytes`.
  const dataLen = bytes.length
  const dataPtr = ex.ghostty_wasm_alloc(Math.max(1, dataLen))
  const lenSlot = ex.ghostty_wasm_alloc(abi.USIZE_BYTES)
  // Usually one call: stripping never grows the text; only bracketing adds.
  let outSize = dataLen + BRACKET_OVERHEAD
  let outPtr = ex.ghostty_wasm_alloc(outSize)

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
      ex.ghostty_wasm_free(outPtr, outSize)
      outSize = written
      outPtr = ex.ghostty_wasm_alloc(Math.max(1, outSize))
      // Refilled, since the call consumed it in place.
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
    // Copied out: the next paste reuses the buffer, and memory can move.
    return new Uint8Array(ex.memory.buffer, outPtr, written).slice()
  } finally {
    ex.ghostty_wasm_free(dataPtr, Math.max(1, dataLen))
    ex.ghostty_wasm_free(outPtr, Math.max(1, outSize))
    ex.ghostty_wasm_free(lenSlot, abi.USIZE_BYTES)
  }
}
