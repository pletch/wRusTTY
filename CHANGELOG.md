# Changelog

Notable changes to wRusTTY, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): while the version is 0.x, a minor
bump means new features and a patch bump means fixes only.

Add entries under **Unreleased** as changes land. `npm run release -- minor`
(or `patch`, `major`, `X.Y.Z`) turns that section into the next version; the
release job publishes it as the GitHub release notes.

## [Unreleased]

### Changed

- The terminal engine is re-pinned to Ghostty `27ffca0d`, just past the first stable
  release of its terminal library (libghostty-vt 1.0). Colored and styled output parses
  about twice as fast, and emoji and other combined characters about three times as fast.
  Each scrollback setting also holds about 5% more lines in less memory.

### Fixed

- A connection lost while the vault is locked waits for you to unlock it and then
  reconnects, rather than using up its retries and giving up. It says so in the pane.
- On Android, sessions react to the network changing. A lost one retries as soon as a
  network appears, with a fresh set of retries, and spends none while there isn't one. A
  live one is checked within about 15 seconds, rather than taking about three minutes to
  find out its connection is dead. One that still answers, such as through a VPN that moved
  networks, stays connected.
- On Android, output caught up after the screen is rebuilt is written at the size it was
  written for. A rebuilt screen also keeps its pinch zoom and knows if the keyboard is open.
- On Android, a pane opened or rotated with the keyboard up no longer tells the host about
  the short height, which made programs redraw when the keyboard closed.
- On Android, a screen that falls far behind catches up rather than silently missing output.
- In rare cases, widening a full-screen program's pane, such as rotating a phone with one
  open, could leave the terminal reading memory it had already freed.

## [0.6.1] - 2026-11-04

### Changed

- On Android, dragging a selection scrolls the terminal when a finger nears the edge of what's
  showing. It had to get past the terminal's edge, which there was little or no room for in
  landscape or with the keyboard open.
- On Android, Remote files and Port forwarding take the whole pane. A tap opens a folder or
  starts a download, a file's details sit under its full name, transfers stay at the bottom,
  and the long-press menu stays on screen.
- On Android, tabs size to their titles and the strip scrolls, rather than every tab
  shrinking until no title can be read. Only the active tab shows its close button, the
  active tab scrolls into view, and a fade and arrow mark any side with more tabs.

## [0.6.0] - 2026-11-04

### Changed

- On Android, the connection screen takes the whole pane, with Saved and New connection as
  separate tabs and rows large enough to tap. It was the desktop's side-by-side layout.
- On Android, Settings is full screen: a list of sections, each opening on its own, with
  the back gesture returning to the list and then closing it.

### Fixed

- On Android, opening or closing the keyboard no longer resizes the terminal for the host.
  Each resize made programs like Claude Code redraw over their own output, leaving
  overlapping copies. The grid now stays as it is and slides to keep the cursor in view,
  so a full-screen program's bottom rows can sit behind the keyboard. Rotating and pinching
  still resize it.
- On Android, the connect form no longer offers session logging, and a session saved on a
  desktop with logging on no longer starts a log nothing can reach.

### Added

- On Android, the back gesture closes the topmost menu, panel or dialog, then a text
  selection, and only then leaves the app, with your sessions still running.
- On Android, an icon shows in the status bar while a session is open. The notification was
  in the Silent group, where phones can hide it. It still makes no sound.
- On Android, the terminal's scrollbar can be dragged with a finger, to jump through long
  scrollback.
- On Android, pinching the terminal zooms it for now. A two-finger double-tap, or restarting
  the app, returns to the font size in Settings, which a pinch doesn't change.
- The Android key row has more: a double-tap locks Ctrl or Alt on until tapped again, and
  its new button reaches Home, End, PgUp, PgDn, Del, Ctrl-C, Ctrl-D, `_`, `\`, `&` and
  F1 to F12. Each press gives a light tick, which can be turned off in Settings.

## [0.5.1] - 2026-11-03

### Fixed

- On Android, the terminal no longer disappears with the keyboard open in landscape.
  The toolbar, tabs and key row left it no room, so the line being typed couldn't be
  seen. The toolbar, tabs and status bar now hide until the keyboard closes.
- On Android, settings that do nothing on a phone are hidden: keyboard shortcuts, the
  remote file editor, background opacity, window effects, unfocused appearance,
  right-click paste, installed fonts, and the PuTTY and SSH config imports. Copy on select
  is gone too and always off, since the selection popup has its own Copy. So is session
  logging, in settings and on the toolbar, because its logs couldn't be reached there, and
  a saved session set to log no longer does so on a phone.
- On Android, a workspace saved on a desktop opens with each pane in its own tab rather
  than in splits too narrow to use. Panes a phone can't open, like local shells, are
  skipped with a message instead of failing to connect. The saved workspace keeps its
  layout.

### Security

- On Android, the vault locks 5 minutes after you leave the app, which you can change or
  turn off in Settings. Open sessions stay connected. A new setting, off by default, blocks
  screenshots and screen sharing, and hides the terminal in Recents.
- On Android, nothing goes into cloud backups or transfers to a new phone. Use an export.
- On Android, creating a local or SOCKS forward warns once that other apps on the phone can
  use it.
- On Android, the biometric key can't be used while the phone is locked. If you already
  use biometric unlock, turn it off and on again to pick this up.

## [0.5.0] - 2026-11-03

### Added

- A preview of wRusTTY for Android, for SSH, SFTP and telnet on a phone. It has a key row
  for what a phone keyboard lacks, touch scrolling and selection, the vault with
  biometric unlock, and transfers to and from phone storage and Google Drive. Sessions
  keep running in the background and come back if Android destroys the screen, or if the
  WebView's renderer dies. They don't survive the app itself being killed. Folder
  transfers and remote editing aren't available on the phone yet, and neither are local
  shells or serial.
- The VT420 column sequences: DECIC and DECDC insert and delete columns
  across the scrolling region, and DECBI and DECFI scroll it sideways at the
  margins.

### Changed

- Exported backups now encrypt hostnames, usernames and everything else about your
  sessions and workspaces, not just the credentials. Exporting needs an unlocked vault.
  Restoring asks for the backup's master password right after you pick the file, lets you
  retry a wrong one without changing anything, and leaves the vault unlocked. Older
  backups still restore, but older versions of wRusTTY can't read new ones.
- The terminal engine is re-pinned to Ghostty `ae0dc1b7`, just past the 1.4.0
  release.

### Fixed

- Typing no longer stalls for up to 10 seconds on a host slow to open a channel. The
  command history import, the Files panel's identity check and the first SFTP open each
  held up the pane's input while they waited.
- Clearing the screen at a shell prompt (Ctrl-L with shell integration) once
  scrollback was full could leave the next text in the wrong style, read from
  memory the engine had already freed.
- After scrollback is erased (`clear` or `CSI 3 J`), search no longer reports
  matches from the erased rows at the top of what remains.
- The zsh shell-integration snippet sends the command line escaped. It printed
  it with `print`, which undid the escaping, so a command with a `;` was
  recorded in history and notifications only up to the `;`. Re-copy the
  snippet from Settings to pick this up.
- The fish snippet sends a multi-line command as one command, not one per
  line.
- Link underlines stay on the URL's row in programs that redraw in place,
  like Claude Code. They were found on the previous frame's screen, so a URL
  that moved could leave its underline on the wrong line until more output
  arrived.

### Security

- The shell-integration snippets escape control characters in the command
  line they report, and drop them from the host name. A raw ESC or BEL in a
  command could end the report early and have the rest of the line acted on
  as terminal output, such as a clipboard write. Re-copy the snippet to pick
  this up.

## [0.4.3] - 2026-10-25

### Security

- `crypto-bigint` is updated to 0.7.8 for RUSTSEC-2026-0387 and `ctutils` to
  0.4.5 for RUSTSEC-2026-0385. Both fix arithmetic meant to run in constant
  time that could branch on secret values, a timing side channel in the RSA
  and elliptic-curve code SSH uses.

### Changed

- The terminal engine is re-pinned to Ghostty `8ef0ec12`, now built with
  Zig 0.17. Colored output parses up to about 15% faster.
- Titles, working directory, clipboard writes, notifications and shell
  integration are now read from the output by the engine's own parser instead
  of a separate pass in JavaScript. Most output is about 15-20% faster to
  process, and large clipboard writes from a remote program several times
  faster.

### Fixed

- In a program that sets a scroll region with origin mode on, moving the
  cursor to a column (CHA) no longer also moves it down by the size of the
  top margin.
- Backspace and cursor-left stop at a left margin set by the program instead
  of moving past it.
- Two-finger scrolling on a precision touchpad follows the finger instead of
  moving a full line for every small movement, and scrolling back a little no
  longer overshoots. A mouse wheel notch still scrolls five lines.

## [0.4.2] - 2026-10-16

### Security

- Pasting text with a lone carriage return between commands no longer skips
  the multi-line warning. A carriage return is what the Enter key sends, so on
  a shell without bracketed paste (serial consoles, telnet to network gear,
  plain `sh`) a paste like `cd /tmp⏎rm -rf build` ran its commands without
  asking. Text with CRLF or LF line endings was already caught.

### Changed

- The terminal engine is re-pinned to Ghostty `b3dc3d79`. `Ctrl-L` at a shell
  prompt now keeps the earlier output in scrollback wherever the prompt is,
  not only when it's on the last row. Needs shell integration (OSC 133).
- Releases list SHA-256 checksums for their installers, in the notes and as
  an attached `SHA256SUMS.txt`.

### Fixed

- A bare `CSI g` now clears the tab stop at the cursor; it was ignored.

## [0.4.1] - 2026-10-11

### Changed

- The terminal engine is re-pinned to Ghostty `b1d9492c`. A soft reset
  (DECSTR), which `tput init` and `tset` send under xterm-256color, now resets
  the text style, margins and modes it was meant to; it was ignored before.
  Like a full reset, it also puts the cursor back to the shape set in
  Settings.

### Fixed

- A program killed while the shell stayed up (a crash, `kill -9`) no longer
  leaves mouse reporting, the Kitty keyboard protocol or the alternate screen
  on at the next prompt, where bash read pointer movement as typed text and
  ignored the keyboard. The pane turns off what the command turned on when
  the shell's next prompt arrives. Needs shell integration (OSC 133).
- Narrowing a pane while a full-screen program showed a wide character (CJK,
  emoji) at the new edge left half of the character behind, and later erases
  on that row reached past its end.
- An emoji printed while DEC line drawing was in effect came out blank and
  shifted the rest of the row.

## [0.4.0] - 2026-10-02

### Added

- **Ctrl+click a file path** in terminal output to open it, the way a URL
  opens. On an SSH pane it is shown in that pane's files panel; on a local
  pane it opens in whatever Windows associates with its type. Network and
  device paths are refused, and anything Windows would run is shown selected
  in Explorer instead of opened. Hint mode offers paths alongside URLs.
- A local PowerShell pane's working directory is read from OSC 9;9, so
  relative paths there resolve where the shell is.
- Autocomplete: Shift+Delete forgets the highlighted suggestion and stops it
  being suggested again — running it or re-importing it no longer brings it
  back. Forgetting a command from Settings does the same. Settings lists each
  host's never-suggested commands with "Allow again" to undo it.

### Changed

- The terminal engine is re-pinned to Ghostty `f523504e`. Line drawing in the
  DEC Special Graphics set, used by ncurses under a non-UTF-8 locale and by
  network-gear menus, is about five times faster.

### Fixed

- A window restored taller than the screen, or partly off it, is fitted back
  onto the screen before it appears. The window can also be dragged or
  maximized by its title bar while a dialog is open.
- A session that drops while a program has mouse reporting or the Kitty
  keyboard protocol on no longer leaves them on. After reconnecting, the shell
  used to receive mouse reports as typed text and keys it could not read. A
  palette the program recolored is put back to the theme too.
- `reset` puts back a palette a program recolored, rather than keeping its
  colors.
- After a line fills the pane and the pane is widened, the next character
  continues on that line instead of starting a new one.
- An OSC sequence canceled with CAN or SUB is dropped, as the terminal
  standard requires. It was run anyway, with the output that followed it
  taken as its payload — a window title or a clipboard write.
- Command history in Settings is headed by the saved session's name rather
  than its id.
- A saved session that connected through the connect form (its saved password
  unavailable) kept its command history apart from the session's own. It now
  shares it, as long as the form still points at the same host, port and user.

### Security

- `event-listener` is updated to 5.4.2 for RUSTSEC-2026-0221. It reaches only
  the Linux build.

## [0.3.0] - 2026-09-28

### Added

- **Local shells.** PowerShell, Command Prompt, Git Bash and WSL distributions
  run in a pane on a Windows pseudoconsole, found automatically and saved as
  sessions like any other connection. Tabs are titled and iconed by shell.
- **Administrator tabs** — "Run as administrator" on a local shell opens it
  elevated through UAC, beside ordinary tabs and marked as such. A restored
  administrator tab waits as a reopen-or-close card instead of prompting at
  startup.
- Configurable keyboard shortcuts.
- SSH through an HTTP CONNECT or SOCKS5 proxy, set globally with a
  per-session opt-out.
- Logging settings.
- Tab badges taken from the symbol a program puts in its own title.
- An unfocused window can fade or turn see-through while another app is
  active.
- New installs start on a tuned appearance: JetBrains Mono at 13, Campbell,
  a translucent background and a bar cursor. Existing settings are untouched.
- Autocomplete: Right accepts a suggestion, Alt+Right takes one word, and
  Enter accepts the highlighted row only inside the list. Tab goes to the
  remote again.

### Changed

- The terminal engine is re-pinned to Ghostty `622b4eec`, which brings six
  xterm key-encoding fixes and ANSI DECRQM.
- Scrollback search uses the engine's own search, starts where you are
  looking, and says when it can only see the current screen.
- Bar, underline and outline cursors are drawn over the character.
- Programs that redraw under synchronized output (mode 2026) no longer flicker;
  a hold that never ends times out.
- Nagle's algorithm is off on SSH sockets and port forwards, which cuts
  keystroke latency.
- Larger scrollbar arrows, and more places to drag the window from.
- The About panel credits Ghostty under its MIT license.

### Fixed

- Copying a selection that crosses into scrollback, or that includes rows the
  engine reports as blank, now copies what was selected.
- A Windows clipboard's CRLF line endings no longer double up on paste.
- A folder download stays inside the folder it was sent to.
- A host key of a new type is no longer treated as a first connection.
- A local pane's scrollback stays put when the pane grows.
- An administrator shell is resolved only from system locations.

## [0.2.0] - 2026-08-29

First published release: SSH, Telnet and Serial in one tabbed window, with
the encrypted credential vault, split panes, SFTP file browsing, PuTTY session
and key import, and the Ghostty-based terminal. See the README for the full
feature list.

[Unreleased]: https://github.com/pletch/wRusTTY/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/pletch/wRusTTY/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/pletch/wRusTTY/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/pletch/wRusTTY/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/pletch/wRusTTY/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/pletch/wRusTTY/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/pletch/wRusTTY/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/pletch/wRusTTY/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/pletch/wRusTTY/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pletch/wRusTTY/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pletch/wRusTTY/releases/tag/v0.2.0
