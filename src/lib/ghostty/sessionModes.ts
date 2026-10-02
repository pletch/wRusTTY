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
