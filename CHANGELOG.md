# Changelog

Notable changes to wRusTTY, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): while the version is 0.x, a minor
bump means new features and a patch bump means fixes only.

Add entries under **Unreleased** as changes land. `npm run release -- minor`
(or `patch`, `major`, `X.Y.Z`) turns that section into the next version; the
release job publishes it as the GitHub release notes.

## [Unreleased]

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
- The About panel credits Ghostty under its MIT licence.

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

[Unreleased]: https://github.com/pletch/wRusTTY/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pletch/wRusTTY/releases/tag/v0.2.0
