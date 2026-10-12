/**
 * Terminal state a far-end program turns on and is trusted to turn off, which
 * it can't when the connection drops or it dies.
 *
 * Auto-reconnect keeps the pane and core so the scrollback survives, so the
 * new shell would inherit leftover modes (mouse reports arriving as text,
 * Kitty-encoded keys readline can't read). Not RIS, which would discard the
 * scrollback.
 */

/** Every mouse-reporting mode, both the event sets and the encodings. */
const MOUSE_OFF = ['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016']
  .map((m) => `\x1b[?${m}l`)
  .join('')

/**
 * Pops the whole Kitty keyboard flag stack (popping more than it holds
 * empties it, per the protocol and the core).
 */
const KITTY_KEYBOARD_OFF = '\x1b[<99u'

/**
 * DEC private modes a program sets and a prompt doesn't want, with each one's
 * off sequence. Cursor visibility is the exception, since programs clear it
 * (see `ModeSnapshot.modes`).
 */
const PROGRAM_MODES: ReadonlyArray<readonly [mode: number, off: string]> = [
  ...['9', '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016'].map(
    (m) => [Number(m), `\x1b[?${m}l`] as const,
  ),
  [1004, '\x1b[?1004l'],
  [2004, '\x1b[?2004l'],
  [1, '\x1b[?1l'],
  // DECNKM, where the core keeps `ESC =`; `ESC >` resets it.
  [66, '\x1b>'],
  [2026, '\x1b[?2026l'],
]
const CURSOR_VISIBLE = 25

/** The modes `PROGRAM_MODES` and cursor visibility are read through. */
export const SNAPSHOT_MODES: readonly number[] = [...PROGRAM_MODES.map(([m]) => m), CURSOR_VISIBLE]

/**
 * What a program could leave behind, read when a command starts and at the
 * next prompt.
 */
export interface ModeSnapshot {
  alt: boolean
  /** Each of `SNAPSHOT_MODES`, set or not. */
  modes: ReadonlyMap<number, boolean>
  /** `KeyEncoder.probeProtocol`; compared, never interpreted. */
  keyboard: string
}

/**
 * Leaves the alternate screen a program died on, before `leftoverModeReset`'s
 * comparison, which must run on the primary screen (the Kitty stack is per
 * screen).
 */
export const LEAVE_ALT_SCREEN = KITTY_KEYBOARD_OFF + '\x1b[?1049l'

/**
 * Turns off what a command turned on and left on, judged at the next prompt:
 * the case `sessionModeReset` can't reach, where only the program died
 * (SIGKILL, a crash).
 *
 * Only modes off at the command's start and on now, which keeps the shell's
 * own safe: bash and fish turn their modes off before running a command, so
 * they're off at both points. The alternate screen is `LEAVE_ALT_SCREEN`'s.
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
 * Puts a pane back to how a fresh shell expects it.
 *
 * `?1049l` restores the cursor saved on entry, so it's only sent from the
 * alternate screen (from the primary, it would restore a stale position).
 * The Kitty stack is popped on both screens.
 */
export function sessionModeReset(onAltScreen: boolean): string {
  return [
    onAltScreen ? KITTY_KEYBOARD_OFF + '\x1b[?1049l' : '',
    KITTY_KEYBOARD_OFF,
    // modifyOtherKeys.
    '\x1b[>4m',
    MOUSE_OFF,
    // Focus reports, bracketed paste, application cursor keys and keypad
    // (cursor-key modes turn arrows into `^[OA` at a plain prompt).
    '\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>',
    // An open synchronized update freezes the pane until the core times out.
    '\x1b[?2026l',
    // Scroll region and origin mode both home the cursor, so wrap them in a
    // save and restore to keep the status line where output stopped.
    '\x1b7\x1b[?6l\x1b[r\x1b8',
    // Line-drawing charset, hidden cursor, and colors.
    '\x0f\x1b(B\x1b[?25h\x1b[0m',
    // The palette, if recolored with OSC 4, back to the theme.
    '\x1b]104\x07',
  ].join('')
}
