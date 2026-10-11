/**
 * The terminal state a program on the far end turns on and is trusted to turn
 * off again on its way out — which it never gets to do when the connection
 * drops underneath it.
 *
 * Auto-reconnect keeps the pane, and with it the core, so that the scrollback
 * survives. Without this the new shell inherits whatever the dead program left
 * behind. The case that prompted it: Claude Code had any-motion mouse tracking
 * and the Kitty keyboard protocol on when the link went, so after reconnecting
 * every pointer movement arrived at bash as `35;39;1M…` text, and every
 * keystroke as a CSI-u sequence readline cannot read — a pane that spewed
 * codes and ignored its user.
 *
 * Not RIS. A full reset would fix all of it and also throw away the scrollback,
 * which is the one thing reconnecting in place exists to keep.
 */

/** Every mouse-reporting mode, both the event sets and the encodings. */
const MOUSE_OFF = ['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016']
  .map((m) => `\x1b[?${m}l`)
  .join('')

/**
 * Pops the whole Kitty keyboard flag stack. Popping more entries than the
 * stack holds empties it, which is what the protocol specifies and what the
 * core does, so the count only has to be large.
 */
const KITTY_KEYBOARD_OFF = '\x1b[<99u'

/**
 * The DEC private modes a program turns on for itself and a shell prompt has
 * no use for, with the sequence that turns each back off. Cursor visibility is
 * the odd one out, since a program *clears* it — see `ModeSnapshot.modes`.
 */
const PROGRAM_MODES: ReadonlyArray<readonly [mode: number, off: string]> = [
  ...['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016'].map(
    (m) => [Number(m), `\x1b[?${m}l`] as const,
  ),
  [1004, '\x1b[?1004l'],
  [2004, '\x1b[?2004l'],
  [1, '\x1b[?1l'],
  // DECNKM, which is where the core keeps `ESC =`; `ESC >` is its reset.
  [66, '\x1b>'],
  [2026, '\x1b[?2026l'],
]
const CURSOR_VISIBLE = 25

/** The modes `PROGRAM_MODES` and cursor visibility are read through. */
export const SNAPSHOT_MODES: readonly number[] = [...PROGRAM_MODES.map(([m]) => m), CURSOR_VISIBLE]

/**
 * What a program could leave behind, read off the core when a command starts
 * and again when the next prompt arrives.
 */
export interface ModeSnapshot {
  alt: boolean
  /** Each of `SNAPSHOT_MODES`, set or not. */
  modes: ReadonlyMap<number, boolean>
  /** `KeyEncoder.probeProtocol` — compared, never interpreted. */
  keyboard: string
}

/**
 * Leaves the alternate screen a program died on, before the comparison that
 * `leftoverModeReset` makes — which has to be made against the primary
 * screen, since the Kitty stack is kept per screen.
 */
export const LEAVE_ALT_SCREEN = KITTY_KEYBOARD_OFF + '\x1b[?1049l'

/**
 * The sequence that turns off what a command turned on and never turned off
 * again, judged at the shell's next prompt — the case `sessionModeReset` can't
 * reach, where the connection is fine and only the program died: a SIGKILL, a
 * crash, a `kill -9` from another pane. Bash then reads mouse reports as typed
 * text and Kitty-encoded keys as garbage, exactly as after a dropped link.
 *
 * Only modes that were off when the command started and are on now. That is
 * what keeps a shell's own modes safe: bash turns bracketed paste on for its
 * prompt and off before running anything, fish does the same with the Kitty
 * protocol and focus reports, so whatever the shell owns is already off at the
 * command's start and is not on again yet at the marker that ends it. A mode
 * the shell left on through the command is never touched.
 *
 * The alternate screen is not handled here — see `LEAVE_ALT_SCREEN`.
 */
export function leftoverModeReset(before: ModeSnapshot, now: ModeSnapshot): string {
  let seq = ''
  if (now.keyboard !== before.keyboard) seq += KITTY_KEYBOARD_OFF + '\x1b[>4m'
  for (const [mode, off] of PROGRAM_MODES) {
    if (now.modes.get(mode) && !before.modes.get(mode)) seq += off
  }
  if (!now.modes.get(CURSOR_VISIBLE) && before.modes.get(CURSOR_VISIBLE)) seq += '\x1b[?25h'
  return seq
}

/**
 * The sequence that puts a pane back to how a fresh shell expects to find it.
 *
 * `onAltScreen` decides whether to leave the alternate screen, rather than
 * leaving it unconditionally, because `?1049l` restores the cursor saved on the
 * way in: sent from the primary screen it restores whatever was last saved, and
 * the status line written after it lands on top of old output. And the Kitty
 * stack is per screen, so on the alternate screen it is popped on both sides of
 * the switch — the alternate screen's own, then the primary's.
 */
export function sessionModeReset(onAltScreen: boolean): string {
  return [
    onAltScreen ? KITTY_KEYBOARD_OFF + '\x1b[?1049l' : '',
    KITTY_KEYBOARD_OFF,
    // modifyOtherKeys, the other way a program can change what keys send.
    '\x1b[>4m',
    MOUSE_OFF,
    // Focus reports, bracketed paste, application cursor keys, application
    // keypad. Bracketed paste is harmless to bash but not to a shell without
    // it, and the cursor-key modes turn arrows into `^[OA` at a plain prompt.
    '\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>',
    // A synchronized update left open freezes the pane until the core times it
    // out.
    '\x1b[?2026l',
    // Scroll region and origin mode, both of which home the cursor when set —
    // origin mode even when it was already off — so between a save and a
    // restore, to keep the status line where the output stopped. The restore
    // brings back an origin mode that was on, but against a full-screen region
    // that is the same as absolute addressing, and the next program to set a
    // region sets the mode it wants alongside it.
    '\x1b7\x1b[?6l\x1b[r\x1b8',
    // Line-drawing charset, a hidden cursor, and whatever colors were set.
    '\x0f\x1b(B\x1b[?25h\x1b[0m',
    // The palette, if the program recoloured it with OSC 4. Back to the
    // theme, which the core holds as the palette's default.
    '\x1b]104\x07',
  ].join('')
}
