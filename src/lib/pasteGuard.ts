/**
 * Whether a paste goes straight to the terminal or asks first.
 *
 * Two checks, and a paste has to pass both. The engine's (`isPasteSafe`)
 * knows the cases a line count can't see, like a single line carrying a
 * bracketed-paste terminator. Ours counts lines the way a shell does: CR, LF
 * and CRLF each end one.
 *
 * Ours exists because trusting the engine alone was a hole. Until upstream
 * 5c9a3d8a9 it treated a lone CR as harmless, so `cd /tmp\rrm -rf build` came
 * back safe and ran both commands on a shell without bracketed paste. A CR is
 * what the Enter key sends.
 */

/**
 * Removes the one trailing newline that copy buttons on documentation sites
 * add, so a paste doesn't submit the command. Only one is removed.
 */
export function stripTrailingNewline(text: string): string {
  return text.replace(/(\r\n|\r|\n)$/, '')
}

/** Lines as a shell sees them: CR, LF and CRLF each end one. */
export function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

/**
 * True when the text can be pasted without asking.
 *
 * @param engineVerdict the engine's `isPasteSafe`, or null/undefined when the
 *                      engine can't say. Either way the line count still has
 *                      to be one.
 */
export function pasteNeedsNoConfirm(text: string, engineVerdict: boolean | null | undefined): boolean {
  return countLines(text) === 1 && engineVerdict !== false
}
