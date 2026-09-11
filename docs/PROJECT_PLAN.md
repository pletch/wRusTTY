# wRusTTY — Project Plan

A lightweight, security-focused SSH / Telnet / Serial client for Windows 11 — and,
since September, a local terminal too (§Local shells) — with a
modern GUI, tabbed session management, an encrypted credential vault, and
GPU-accelerated terminal rendering. Remote file browsing, editing and transfer
over SFTP have since landed — files and whole folders move in both directions,
streamed, with progress and cancellation; rename, delete, new folder and chmod
are in the panel's context menu; a failed transfer can be retried and resumes
where it stopped; and a save can no longer quietly overwrite a remote file that
changed underneath it. A transfer now survives the *connection* going away too:
it is set aside when the transport drops and resumed, from where it got to, onto
the channel the reconnect brings back. A root-owned file can be edited too, over
a held sudo helper channel rather than a cached password. What Phase 6 still
holds is an SCP fallback for hosts with no SFTP subsystem.

- **Stack:** Rust + Tauri 2 backend, TypeScript + React frontend, a vendored
  Ghostty VT core (WASM) behind the app's own WebGL renderer
- **Visual reference:** Tabby (`/home/tim/Repos/tabby`) — layout, theming, polish
- **Architecture reference:** r-shell (`/home/tim/Repos/r-shell`) — Tauri 2 + russh
  patterns, SFTP client structure

**The status markers below are audited against the code**, not estimated:
**(shipped)** means it is in the app today, **(partial)** names what is missing,
and an unmarked item is not built. Re-audit rather than trusting them if much
time has passed — the previous set had drifted far enough that several shipped
features were still marked as ideas. **Last audited 2026-09-11, at `8521390`.**
Since the audit at `a46cdaa` the same day: configurable keyboard shortcuts,
the outbound SSH proxy (HTTP CONNECT / SOCKS5), and logging's automatic start
and chosen folder — all three marked shipped below, none yet exercised in the
running app or against a real proxy.

What the `a46cdaa` pass added: **local shells** as a fourth transport (`wr-local`) and
**administrator tabs** on top of them; restore-on-launch and the unfocused
window fade; OSC 52; and two corrections to §3, which still called Windows
Hello future work and described an idle-timeout lock — Hello ships
(`src-tauri/src/hello.rs`) and the vault locks with the Windows session. Nothing
that was marked shipped had regressed.

The pass before (2026-08-29, `7b078de`) added the font stack (four faces, OpenType features, variable
axes, a codepoint range table, DirectWrite enumeration, three bundled families)
and the ligature setting that pulled it in; the custom theme editor and the
iTerm2/VS Code scheme importer; chrome that follows the terminal theme's own
tone rather than literal whites; **elevated (sudo) remote editing**; paste
pacing and trailing-newline trimming; and two engine re-pins.

The previous pass (2026-08-20, `8b32c84`) added session import from
`~/.ssh/config`, recent-command autocomplete, the PowerShell shell-integration
snippet and self-reporting programs, the Campbell palette, linear-light glyph
blending, and the move onto ghostty `main` at a pin.

---

## 1. Technology Decisions

| Concern | Decision | Rationale |
|---|---|---|
| App shell | Tauri 2 | Small installer (<10 MB), native WebView2 on Win11, no Electron overhead |
| Frontend | React + TypeScript + Vite + Tailwind | Matches r-shell; large ecosystem; fast iteration |
| Terminal | **Vendored Ghostty VT core (WASM) + an in-house WebGL renderer** | Superseded the original xterm.js choice. xterm's addons (search, fit, links, unicode) all had to be reimplemented as a consequence — see `SearchController`, `fitGrid`, `LinkController`. Search has since moved onto the core's own `ghostty_search_*` API (`NativeSearchController`), with the JS one kept for the regex and case-sensitive toggles the core cannot express — `docs/NATIVE_SEARCH_PLAN.md`. xterm survives only as the benchmark harness's comparison engine (`src/bench/xtermEngine.ts`); `src/lib` no longer depends on it. **The vendored core is ghostty `main` at a pin, not the v1.3.1 release** — that port is finished, including keyboard, mouse and paste encoding, and `docs/PORT_GHOSTTY_MAIN.md` is its record and holds the current pin (`492300ca`, re-pinned three times since the port landed for upstream fixes reachable from ordinary remote output). The v1.3.1 build stays in `vendor-131/` as the parity oracle, since without a second implementation the parity suites would compare `main` with itself and pass for nothing |
| SSH | `russh` + `russh-keys` | Pure Rust (memory-safe crypto surface), async, actively maintained, proven in r-shell |
| SFTP | `russh-sftp` | Same ecosystem. In use: browsing, editing, and streaming transfer in both directions. Two subsystem channels per session — one for browsing, one for bulk transfers, so a long download doesn't freeze the panel showing its progress |
| Serial | `serialport` crate | Cross-platform, COM enumeration, USB hotplug |
| Local shell | `portable-pty` over ConPTY | One pseudoconsole per pane; the elevated case runs through a UAC-launched host relaying over a named pipe, since a ConPTY spawn cannot cross the integrity boundary |
| Telnet | Hand-rolled over `tokio` TCP (option negotiation is small) or `libtelnet-rs` | Protocol is tiny; keep dependency surface low |
| Vault crypto | `argon2` (KDF) + `chacha20poly1305` (AEAD) + `zeroize` | Modern, misuse-resistant; master password → key |
| OS key storage | `keyring` crate (Windows Credential Manager / DPAPI) | Optional "unlock with Windows" convenience mode |
| Async runtime | `tokio` | Standard |
| IPC | Tauri commands + events; raw terminal bytes over Tauri channels | Avoid JSON-serializing PTY streams per keystroke |

### Rust workspace layout (modularity is enforced by crate boundaries)

```
wrustty/
├── src-tauri/            # Tauri app: commands, state, window mgmt (thin glue only)
├── crates/
│   ├── wr-core/          # Session model, connection trait, events, config types
│   ├── wr-ssh/           # SSH transport: auth, kex, host keys, channels, keepalive
│   ├── wr-telnet/        # Telnet transport + option negotiation
│   ├── wr-serial/        # Serial transport + port enumeration
│   ├── wr-local/         # Local shells on ConPTY, plus the elevated host's pipe protocol
│   ├── wr-vault/         # Encrypted vault: KDF, AEAD, import/export, zeroize
│   ├── wr-sftp/          # SFTP operations (browse, write, streaming upload + download)
│   └── wr-fs/            # Atomic file writes, shared by every on-disk store
└── src/                  # React frontend
    ├── components/       #   terminal view, tabs, session tree, dialogs, settings
    ├── stores/           #   session state, vault state, settings (zustand)
    └── lib/              #   tauri bindings, keymap, themes
```

Every transport implements the `Connector`/`Session` pair in `wr-core`
(connect / read stream / write / resize / disconnect / status events), so the
frontend and tab manager are protocol-agnostic. Adding a protocol later (e.g.
mosh, RDP) means adding a crate, not touching the UI — which `wr-local` has
since tested: the registry, reconnect, logging and coalescing took it
unchanged.

---

## 2. Feature Inventory

### Baseline (user-specified)
- SSH client: password, public-key auth, key exchange, known-host (TOFU) verification
- Telnet client
- Serial client (COM port, baud/parity/stop/flow control)
- Modern polished Windows 11 GUI, Tabby-like appearance
- Tabbed session management
- Session manager (saved sessions, folders/groups)
- Encrypted local credential vault with easy import/export
- GPU-accelerated terminal rendering

### Recommended additions — security (mostly cheap wins with russh)
- **keyboard-interactive auth** — required for many 2FA/PAM setups **(shipped —
  `AuthMethod::KeyboardInteractive`, exposed in the connect dialog as "Ask each
  time")**. Full RFC 4256 round-trip: the server's own prompts are relayed to a
  dialog per round, masked when the server says `echo: false`, for as many
  rounds as it asks. Jump hops prompt separately and say so. Nothing is stored
  — this is the auth type for a password that shouldn't live on the machine,
  and the only one that can answer a one-time code. Servers that refuse the
  method outright (Debian/Ubuntu ship `KbdInteractiveAuthentication no`) fall
  back to prompting and using the plain `password` method. Password auth with
  an empty field and no stored credential routes here too, rather than sending
  a blank that can only be rejected.
- **ssh-agent support** — Windows OpenSSH agent (named pipe) and Pageant
  **(shipped — both, tried in that order; see `wr-ssh/src/session.rs`)**
- **Encrypted key files** — OpenSSH and PuTTY `.ppk` private keys with a
  passphrase prompt **(shipped)**. A `.ppk` → OpenSSH conversion helper is not
  built and probably never needs to be, since `.ppk` loads natively.
- **Paste protection** — bracketed paste **(shipped)**, multi-line paste
  confirmation **(shipped — see `countLines` in `Terminal.tsx`)**
- **Zeroization discipline** — secrets never cross the IPC boundary to the
  webview **(shipped — `zeroize` in `wr-vault` and `wr-ssh`; the frontend sees
  session IDs and status only)**
- **Tauri hardening** — minimal capability grants **(shipped —
  `capabilities/default.json` grants named permissions, and the opener is
  scoped to `http`/`https`)**
- **Host key management UI** — view and remove known hosts **(shipped —
  Settings → Host keys)**. Reading the store was the missing half: the prompt
  that writes it has always existed, so trust could be granted and never
  withdrawn. The case that mattered is not exotic — a host is rebuilt, offers a
  new key, and the prompt correctly says the key changed and may be an attack;
  with no way to remove the old entry the only fix was hand-editing
  `known_hosts`, which is exactly the situation that teaches a user to click
  through the warning instead.
  - **Entries are identified by their stored line, not by fingerprint.** A line
    that will not parse has no fingerprint, and those are precisely the ones
    that must be removable: a corrupt entry fails closed (deliberately — it
    could be the one that would have matched), so it pins the host to "changed"
    forever. They are listed with a warning saying so.
  - **`learn` re-reads before it writes.** Every connector holds its own copy of
    the store and the management UI is another, so persisting from a copy loaded
    minutes ago would rewrite the file from stale state and resurrect a key the
    user had just deleted. A trust anchor returning from the dead is the one
    outcome this file exists to prevent.
  - **The dialogs say that forgetting is safe**, because it is — the worst
    result is being asked to confirm a fingerprint again. Wording it like a
    dangerous action would put the alarm on the wrong step; the dangerous step
    is accepting a *changed* key, and that prompt is elsewhere.
  - Not built: **pinning** (marking a key as never-to-change), and importing
    from or exporting to OpenSSH's own `known_hosts` format.
- Algorithm configuration (allow disabling legacy kex/ciphers per session for
  old network gear — a big deal for serial/telnet-adjacent users). **Not
  built**: russh's defaults are what every session gets.

### Recommended additions — connectivity
- **Jump host / ProxyJump chains** — table stakes for anyone on a bastion
  **(shipped)**
- **Port forwarding** — local, remote, and dynamic (SOCKS); PuTTY parity
  requires it **(shipped)**, with a management panel. **The backend owns the
  list** (`ssh_list_forwards`), which is not a detail: the panel used to hold it
  in component state while being unmounted on close, so closing the panel lost
  track of forwards that were still running and left no way to stop them. It
  also means a forward survives a reconnect — it is re-established against the
  connection that came back, and one that cannot be is shown as down, with the
  reason and a retry, instead of being drawn like a working tunnel that silently
  carries nothing
- **Keepalive** with visible connection state per tab **(shipped — per-profile
  interval, see `SshConfig::keepalive_seconds`)**. Auto-reconnect **(shipped —
  the session comes back, and so do its port forwards and its in-flight file
  transfers; a global switch, a per-profile opt-out and both run limits are in
  Settings. See `docs/AUTO_RECONNECT_PLAN.md`, and the watch item in §5 for
  what a reconnected session deliberately does *not* restore)**.
- **Wake-on-LAN** — a per-profile MAC, sent before connecting to a host that
  isn't answering **(shipped — `src-tauri/src/wake.rs`, run from the registry's
  pre-connect hook)**. Probes first, so an already-awake host is never sent
  anything. Not attempted behind a jump host; see TODO.md for that and for
  automatic multi-interface broadcast.
- **Outbound proxy (HTTP CONNECT / SOCKS5) for reaching a host through a
  corporate proxy (shipped — `wr-ssh/src/proxy.rs`).** Not the SOCKS5 code in
  `wr-ssh/src/socks.rs`, which is the *dynamic forward's own server*; the two
  get confused because they share a protocol name.
  - **Global, with a per-session opt-out.** The proxy describes this machine's
    way out of its network, not any one host, so it is set once in Settings →
    Session. A saved session can decline it (`useProxy: false`, stored only as
    the opt-out, like `autoReconnect`); the decision is made backend-side in
    `resolve_profile_config`, where the profile is, so reconnects honour it.
  - **It carries the first socket only.** With a jump host the proxy reaches
    the jump host, and the target is reached from its side of the network.
  - **The proxy resolves the name.** SOCKS5 is sent a domain name rather than an
    address, since behind a corporate proxy the internal names are often the
    ones this machine cannot resolve.
  - **No proxy login.** A corporate HTTP proxy that wants one almost always
    wants NTLM or Kerberos, which a username and password would not satisfy,
    and storing one would put a second secret outside the vault. A 407, or a
    SOCKS5 proxy with no acceptable method, is reported as "requires a login"
    rather than as a refusal. This is the part to build if someone needs it.
  - Wake-on-LAN is skipped behind a proxy, for the reason it is behind a jump.
  - Telnet does not use it yet; it would be the same stream handed to a
    different connector.
- **X11 forwarding** — `ssh -X`'s half of the job, so a remote `xterm`,
  `wireshark` or a vendor's Java configuration tool can put a window on the
  Windows desktop. Two halves, and only one of them is ours: requesting the
  `x11-req` channel, generating the MIT-MAGIC-COOKIE-1 auth pair and pumping
  the forwarded channels is straightforward russh work; **being** an X server on
  Windows is not, and should not be attempted. The realistic shape is to detect
  an installed server (VcXsrv, Xming, or the X server inside WSLg) and forward
  to its display, prompting to install one if none is found — which makes this a
  connectivity feature with an external dependency, and worth saying so in the
  UI. Trusted (`-Y`) vs untrusted (`-X`) forwarding is a real security
  distinction and the setting must default to untrusted. Supersedes the
  deferral below.

### Recommended additions — terminal & UX
- **Session import** — PuTTY's registry sessions **(shipped)**, and
  `~/.ssh/config` **(shipped)**, which is the same adoption feature aimed at
  the other half of the audience: someone arriving from a terminal `ssh` habit
  has no registry full of sessions but very often has thirty `Host` blocks.
  `HostName`, `Port`, `User`, `IdentityFile`, `ProxyJump` and
  `ServerAliveInterval` come across; everything else is left behind rather than
  half-translated. **Both live in Settings only.** The PuTTY offer used to sit
  on the connect screen — the screen you see most — about a decision made once
  in the app's lifetime; importing is now something you go and ask for.
- Scrollback search, configurable scrollback limit, copy-on-select, right-click
  paste **(shipped)**
- Shell integration (OSC 133/633): per-command status, and a notification when
  a long command finishes with the window in the background **(shipped — see
  `docs/SHELL_INTEGRATION.md`)**. Snippets for bash, zsh, fish and
  **PowerShell** ship, each emitting nothing where a shell is non-interactive
  or has stdin redirected, so `scp`, `rsync`, git-over-ssh and `pwsh -c` are
  unaffected. A program that emits the sequences **for itself** — a REPL, a
  full-screen tool — owns the marker while it runs rather than having the
  shell's stale one sit under it.
- **Recent-command autocomplete (shipped — `docs/AUTOCOMPLETE_PLAN.md`, all
  six phases).** An inline suggestion as you type at a remote prompt, with the
  full ranked list a keystroke away. The store is per-host, frecency-ranked,
  redacted on write and **ranked in Rust**, so the commands a user has ever run
  never enter the webview — only the strings about to be shown. Three sources
  feed it: the shell integration's own `E` payload, passive capture from the
  grid (guarded so a password prompt cannot be learned), and an optional
  one-time harvest of the host's shell history file over an `exec` channel.
  **Off by default, and the harvest is a second opt-in nested under the first**
  — the history file is somebody else's audit trail. Its remaining questions
  are preferences, not gaps, and are listed in that plan.
- **tmux control mode (`tmux -CC`)** — **not built.** In control mode tmux
  stops drawing and speaks a line protocol instead: `%output %<pane> <bytes>`
  for every pane, `%begin`/`%end`/`%error` around command replies, and
  `%window-add`, `%window-close`, `%layout-change`, `%session-changed`,
  `%exit` as the session changes shape. A terminal that speaks it maps tmux's
  windows and panes onto its **own** tabs and panes, sends input back as
  `send-keys`, and reports size with `refresh-client -C`. iTerm2 is the
  reference implementation and worth reading before writing any of it.

  **What it buys is the one thing auto-reconnect cannot.** Reconnect restores
  the *transport* and the scrollback we hold; it cannot restore the shell's
  state, because the remote processes died with the old channel. Under tmux
  they don't, so a dropped link resumes the work rather than the connection.
  Secondary but real: our scrollback, search, copy, font and mouse handling
  apply per tmux pane, instead of tmux reimplementing all of it worse inside
  one terminal grid.

  **Scope the structural decision first, because it is the whole cost.** Every
  pane in a tab is currently one `Session` in the registry, one transport, one
  engine — `wr-core`'s `Connector`/`Session` pair assumes it. A tmux pane is a
  child of *one* transport, so N panes have to be demultiplexed from a single
  byte stream. The choice is whether a tmux pane becomes a `Session` behind a
  virtual connector (the registry, coalescer credit window, logging and
  reconnect machinery all keep working unchanged) or a new kind of pane leaf
  (less pretending, but every one of those subsystems needs a second case).
  The first looks right and should still be argued, not assumed.

  Three things that will cost time if discovered late: **the demux belongs
  backend-side** — `%output` payloads are octal-escaped and can be large, and
  routing them in the webview means every pane's bytes crossing IPC through
  one channel and being unescaped by the process that renders untrusted
  output; **tmux owns the layout**, so either we mirror its splits and refuse
  our own inside a tmux tab, or ours drive and push `select-layout` back — one
  of them, decided up front, because half of each is a pane tree that
  disagrees with the host; and **`-CC` is not the only version of itself**, so
  it wants testing against the tmux that ships on the appliances and LTS
  distributions this app's users actually reach, not just a current one.
- True colour **(shipped)**, wide characters and grapheme clusters **(shipped —
  the core's, exercised by `readRows.test.ts`)**, cursor styles **(shipped —
  shape and blink, plus DECSCUSR)**.
- **Font selection — a stack, not a family string (shipped).** `setFont` takes
  a `FontSelection`: a family per style (regular/bold/italic/bold-italic) with
  a flag saying the family *is already* that face, an OpenType feature string,
  variable-axis settings, and a sorted codepoint range table consulted ahead of
  all of them. Families are enumerated by **DirectWrite in the Rust process**
  (`src-tauri/src/fonts.rs`), which answers the monospace question outright and
  resolves against the same collection the webview will; Settings reports which
  face in the stack actually resolved. Features and axes reach Canvas through a
  generated `@font-face` (`lib/fontStack.ts`), since Canvas 2D has no API for
  either. **Three families ship with the installer** — JetBrains Mono, Fira
  Code and Monaspace Neon (`lib/bundledFonts.ts`, ~1.1 MB) — so a fresh Windows
  box is not dependent on what happens to be installed. Font zoom is on the
  usual Ctrl+`+`/`-`/`0` bindings.
  **Ligatures ship and are off by default** (`ligatures` in `settings.ts`);
  the atlas rasterizes runs of up to five same-styled cells as one string and
  slices the raster at cell boundaries. See TODO.md for why the default is off
  and where the cost lands.
- URL detection — a dotted underline on every link, Ctrl+click to open, and a
  keyboard hint mode (Ctrl+Shift+U) for when a program has the mouse
  **(shipped — see `docs/URL_LINKS_PLAN.md`)**
- **Drag-and-drop upload** — drop a file on a pane and it goes to the host over
  SFTP, into the directory that pane is sitting in **(shipped)**. The rules that
  decide the feature live in `lib/dropUpload.ts`, where they can be read and
  tested rather than inferred from a drag handler:
  - **No OSC 7, no destination.** A shell without shell integration never says
    where it is, and guessing (`~`, or scraping the prompt) puts a file
    somewhere the user did not ask for — so the pane asks, prefilled with
    whatever was typed last.
  - **Only an SSH pane can accept a drop.** Telnet and serial have no file
    transfer at all, and a pane whose session has gone has nowhere to send.
    Both are refused out loud: a drop that silently does nothing is worse than
    one that explains itself, because the user walks away believing the file
    arrived.
  - **Overwrite is a decision, not a default**, and the existing file survives
    a failed attempt — the transfer lands under `.wrustty-part` and is renamed
    into place only on success.
  - **Directories and multi-file drops** are refused clearly, pending the
    recursive upload with a cancellable queue they actually need.
  - **The drop is a DOM event, not Tauri's.** This plan previously assumed the
    window-level `onDragDropEvent`; that path is closed here. Tauri's native
    drag-drop intercepts OS drags on WebView2 and thereby breaks the page's own
    HTML5 events, which tab-to-pane dragging is built on — it was diagnosed and
    switched off in `ef8e828`. So the webview holds a `File` with no path on it
    and the bytes travel over IPC, sliced by the frontend and streamed straight
    into the SFTP write. Nothing is held whole on either side, and a bounded
    queue in the backend is what stops a fast local disk racing ahead of a slow
    network.
- **Download, and upload without dragging** — a right-click context menu on any
  entry in the Files panel (Edit/Open, Download…, Copy path) and an upload
  button in its toolbar **(shipped)**. The rules live in `lib/fileActions.ts`,
  beside `dropUpload.ts` and ordered the same way.
  - **Dragging a file *out* of the panel was considered and rejected.** It looks
    like the symmetric counterpart to the drop, and it is not. The web API for
    it (`dataTransfer.setData('DownloadURL', …)`) is Chromium-only, needs a URL
    the engine can fetch itself, and delivers to the *browser's* download
    directory rather than where the file was dropped — WebView2 under Tauri has
    no download manager wired up for any of it. The native alternative
    (`drag-rs`) needs a file that already exists on local disk, so the whole
    download would have to finish *before* the drag starts: no progress, no
    cancel, and still no way to know the drop target. It would also mean
    switching Tauri's native drag-drop back on, which is what broke tab dragging
    in `ef8e828`. A menu item and a save dialog have none of these problems.
  - **A save dialog is better than a drag, not a consolation for it.** The path
    it returns means the bytes never cross IPC in this direction: the backend
    reads the SFTP stream and writes straight to disk. The same is true of the
    upload picker, which is why it is cheaper than the drop it supplements.
  - **The remote name is sanitised before it is suggested, and refused if it is
    still not a file.** `safeSuggestedName` opens the dialog on something the
    user can accept; the backend independently rejects what it must, because a
    download saved as `NUL` writes to the null device and reports success.
  - **The destination survives a failed download**, the same promise the upload
    makes remotely: it lands beside the target under `.wrustty-part` and is
    renamed over it only on success, through `wr_fs::replace_atomic` so the
    Windows retry ladder isn't reinvented at the one step where every byte has
    already crossed the network.
  - **Folders are refused in both directions**, still pending the recursive
    queue, and the menu item greys out rather than disappearing — a menu whose
    items move between entries is harder to learn than one where they dim.
- Session logging to file (timestamped, per-session toggle) — network/serial
  engineers rely on this constantly **(shipped)**. Also shipped: a saved
  session remembers its "log this session" box (`logSession`), Settings can log
  every session automatically, and transcripts go to a chosen folder. The
  folder must be a full path — a relative one would resolve against whatever
  the working directory is, for a Start-menu launch usually `System32` — and a
  log that cannot start is now reported rather than failing silently.
  Automatic logging starts once, at connect, so stopping it from the toolbar
  stays stopped.
- Named colour themes **(partial — eleven built in, a custom theme editor, an
  importer for iTerm2 and VS Code schemes, and a per-pane background opacity;
  following the OS light/dark setting is not built)**. One of the eleven is
  **Campbell**, at Microsoft's published values and pinned by a test: it is the
  palette conhost and Windows Terminal ship, so it is what makes a pane here
  look like the PowerShell window beside it, and it is the one preset whose
  colours are not ours to taste-tune. Custom themes start as a duplicate of
  whatever is active — presets are never edited in place, which is what keeps
  Campbell (and the name every stored session refers to) meaning what it says.
  An imported scheme lands as one of those custom themes rather than as a
  category of its own: `themeImport.ts` turns an `.itermcolors` plist or a VS
  Code theme into a palette, fills whatever the file did not name from the
  default theme, and says how many it had to fill. Both formats are read in
  the webview, which already has an XML parser and a JSON one; Rust only
  reads the bytes.
- **Glyph blending in linear light (shipped — `textBlending`).** Three modes,
  taking ghostty's names: `native` (mix in sRGB, what this renderer always
  did), `linear`, and `linear-corrected`, which solves per pixel for the
  coverage whose linear blend carries the native blend's luminance — so the
  dark fringe on every antialiased edge goes without the text changing weight.
- **Keyboard encoding — the engine's, not ours** (`lib/ghostty/KeyEncoder.ts`).
  Legacy xterm, xterm's `modifyOtherKeys` and the **Kitty keyboard protocol**
  all ship, because Ghostty's own key encoder is wrapped rather than
  reimplemented, and it picks between them from the modes the *far end* has
  set. So a program that asks for the Kitty protocol with `CSI > flags u` gets
  it, including key-release reporting, and gets legacy encoding back when it
  pops its flags. This replaced a hand-rolled table that sent **nothing at
  all** for Ctrl+Alt and Ctrl+Shift chords and had no Ctrl+digit or
  Ctrl+Space. Not a setting and deliberately not one: the protocol in force is
  the application's business, not a preference.
  **Application keypad mode works**, and looks like it does not: DECKPAM on its
  own changes nothing because DEC 1035 defaults to on and disables it, so a
  program has to clear 1035 too. That is xterm's behaviour as well. Once it
  does, the keypad sends the SS3 set (`ESC O q`, `ESC O M`, `ESC O k`, …).
  An earlier note in this file's history called the mode unimplemented on the
  strength of `ESC =` alone doing nothing; the tests now pin it both ways so
  the gate is not mistaken for a gap again.
- **Mouse reporting — the engine's too** (`lib/ghostty/MouseEncoder.ts`). All
  five tracking modes (X10, normal, button, any) and all five wire formats
  (X10, UTF-8, urxvt, SGR, **SGR-pixels**) ship, for the same reason and on the
  same terms: Ghostty's encoder is wrapped, and it reads which of them applies
  from the modes the far end set. This replaced hand-rolled reporting that
  covered two formats and three modes, sent releases and drags into X10 (which
  is press-only), and could not express pixel coordinates at all because it
  only ever knew which *cell* the pointer was in. What stays ours is the
  policy no encoder can know: which button is held, and dropping motion that
  has not left its cell — except under SGR-pixels, where that motion is the
  point.
- **Paste — the engine's as well** (`lib/ghostty/pasteEncode.ts`). Bracketed
  paste used to be a string concatenation, which pasted an embedded
  `ESC [ 201 ~` straight through: that ends the bracket early and delivers
  everything after it as *typing*, which at a shell prompt is a command nobody
  ran. The encoder replaces the escape with a space, so it arrives inert, and
  converts newlines to carriage returns when nothing is bracketing — which the
  old path also got wrong. The confirmation prompt now asks the core whether a
  paste is safe rather than counting lines, so it catches a **single-line**
  paste carrying that terminator.
  Two things sit either side of the encoder. **One trailing line terminator is
  stripped first** (`43cdf7c`), because a documentation site's copy button puts
  one on the clipboard and it is a Return — the snippet ran instead of waiting
  to be read, and a one-line paste tripped the multi-line guard as "2 lines".
  Exactly one goes; a deliberately copied blank line is text. And **the wire
  side is paced**: writer tasks in `wr-core` split a write into 1 KiB runs 2 ms
  apart (`4561f2d`), because a remote line discipline holds a fixed 4096-byte
  input buffer and *silently discards* the overflow — a paste arriving with a
  hole in it and no error anywhere. Pacing lives in the writer tasks, so every
  route to the wire (the three paste shortcuts, broadcast fan-out, a drop
  upload) inherits it; typing never reaches the split.
- **Configurable keyboard shortcuts (shipped — `lib/keybindings.ts`, Settings →
  Keyboard).** Fourteen actions, window- or pane-scoped, each with a list of
  chords; only overrides are stored, so a changed default reaches everyone who
  never touched it. Chords have one canonical spelling, which is what lets
  conflicts be found by string equality, and **Shift is dropped from a
  symbol** — `+` is Shift+= on one key and its own key on the numpad, so
  counting it would make one gesture two chords. A chord needs Ctrl, Alt or Win
  unless it is a function key or Insert, Escape can never be taken (vim), and a
  bare Ctrl+letter is allowed but warned about, since it is a control
  character. Recording sets a module flag both key handlers check, because the
  window-level handler runs before the recorder and would otherwise act on the
  chord being bound. The autocomplete keys and the dev-only Ctrl+Alt
  instruments are deliberately not in the table.
- Duplicate tab / reconnect / "restart session" actions **(shipped — the tab
  context menu)**. Automatic reconnection on an unexpected drop **(shipped)** —
  and it is a different thing from the button rather than an automatic version
  of it: the button remounts the pane and loses the scrollback, which is
  defensible for something pressed deliberately after reading a failure, where
  auto-reconnect keeps the session id and so keeps everything hanging off it.
  Both are worth having.
- Serial QoL: live port hotplug refresh, common baud presets, DTR/RTS toggles
  **(shipped)**, local echo and line-ending options (CR/LF/CRLF) **(shipped)**,
  input mode — Normal/Local echo/Readline/Readline-hex, matching Tabby's
  local line-editor behavior for devices that don't echo or expect a whole
  line at once **(shipped)** — this is where PuTTY is weak and you can win.
  Audited the rest of Tabby's serial options (slow-feed byte-by-byte send,
  independent input/output newline modes, hex-dump output mode, live
  baud-rate change) as lower-value or awkward fits and left them out for now.

### Local shells — **shipped**
- **A shell on this machine, in a pane** (`docs/LOCAL_SHELL_PLAN.md`, all four
  phases). PowerShell 7, Windows PowerShell, CMD, Git Bash and each installed
  WSL distro are detected (`src-tauri/src/local_shells.rs`) and picked from a
  list; a local session saves as a profile, restores from the launch snapshot,
  and follows the same per-shell history rules as a remote one. No Files panel
  on a local session, and auto-reconnect is off for it, both by decision.
  What a second pass would add is at the end of that plan: a directory picker
  for `cwd`, environment variables from the UI, re-detecting mid-session.
- **Administrator tabs** (`docs/ELEVATED_TABS_PLAN.md`, all four phases). An
  elevated PowerShell, CMD or Git Bash in a tab of an ordinary window, via a
  host `wrustty.exe` launched through UAC and relaying over a named pipe that
  accepts only the process that launched it. Never restored connected (it comes
  back as a reopen-or-close card), no command history, a shield and `ADMIN`
  always on show. Checked on a real machine for all three exits — close, `exit`,
  and killing the app — leaving no elevated process behind. Unsigned builds get
  UAC's yellow "unknown publisher" prompt, one more reason code signing matters.

### Recommended additions — Windows 11 polish
- **Restore on launch** (`restoreSessionsOnLaunch`, off by default) **(shipped)**
  — the tabs and splits reopen. Only sources that can reconnect with no typed
  secret come back connected; the rest return as blank panes, and the prompt
  counts them first.
- **Unfocused window treatment** — while another app has focus the window
  either fades towards the tab strip's colour (1–10%) or turns see-through
  (`unfocusedStyle`, `unfocusedDimPercent`, `unfocusedOpacityPercent`)
  **(shipped)**
- Mica/acrylic window material **(shipped — `window_effects.rs`, chosen per the
  `vibrancyMode` setting)**; rounded corners and snap layouts come from the OS
- Single-instance **(shipped — `tauri-plugin-single-instance`)**; window
  geometry is also restored (`tauri-plugin-window-state`)
- Dark/light mode sync with OS — **not built**. The app chrome has
  `prefers-color-scheme` rules, but the terminal theme is a fixed setting.
- Jump list (recent sessions) on the taskbar icon — **not built**
- Portable mode (config beside the exe) alongside installed mode — **not built**
- **Code signing** — **not set up**; unsigned installers hit SmartScreen walls,
  so budget for a cert before any public release
- Auto-update via `tauri-plugin-updater` — **not built**; the plugin is not a
  dependency

### Explicitly deferred / out of scope for now
- ~~Split panes and broadcast-input~~ — both **shipped**: the core got solid
  first, as intended. Broadcast fans out typing and paste only; mouse reports,
  focus reports and query replies stay with the pane that produced them (see
  `TerminalEngine.onInput`).
- mosh, RDP/VNC (r-shell has these; not your mission). X11 forwarding was in
  this list and has been promoted to connectivity above — the forwarding half
  is ours, the X server half is an installed dependency we point at rather than
  something we build.
- Plugin system (Tabby's biggest complexity source — avoid)
- Cloud sync of vault (export/import covers it; sync is a security liability)

---

## 3. Vault Design (summary)

- Single encrypted file `vault.wrv`: Argon2id-derived key from master password →
  XChaCha20-Poly1305 AEAD over a serialized session+credential store; random salt
  and nonce per save; format-versioned header for future migration.
- An unlock lasts until the **Windows session locks** (Win+L, or an RDP
  disconnect — `src-tauri/src/session_lock.rs`), the app exits, or the user
  locks it from the padlock menu. There is no idle timeout; this line used to
  promise one.
- **Windows Hello unlock — shipped** (`src-tauri/src/hello.rs`), and not by
  either route this section used to defer. A TPM-held `KeyCredentialManager`
  credential signs a stored challenge behind a Hello gesture, and the key that
  unwraps the vault is derived from that signature (HKDF), so nothing that
  could recover it sits on disk. That is a real per-use challenge, which is
  what the deferred WebAuthn `hmac-secret` idea was for, without WebAuthn or
  the `UserConsentVerifier` gate and its windows-rs#1565 problem.
- **Windows sign-in** (DPAPI via Credential Manager, the `keyring` crate)
  stays as a silent fallback where Hello isn't available. The master password
  is always one of the wrappers and cannot be removed.
- **Future**: OIDC-gated vault unlock against a self-hosted IdP (Authelia,
  Authentik, PocketID, etc.) — a distinct feature from WebAuthn/Windows
  Hello above, not a variant of it. OIDC is a federated auth protocol (full
  Authorization Code + PKCE flow, a local loopback HTTP listener for the
  redirect since this is a native app, self-hosted issuer discovery/config
  UI since there's no fixed provider) — it needs network access to the
  IdP, unlike the local-only WebAuthn/DPAPI checks. Like both of those, an
  OIDC token can't itself be used as vault key material (it proves
  identity to a relying party, it isn't a secret) — it could only ever gate
  access to a key already stored some other way, the same architectural
  role the Hello wrapper plays now.
- Import/export = an encrypted `.wrb` bundle **(shipped — `vault_export` /
  `vault_import`)**. The plaintext JSON/CSV export behind an "I understand"
  warning is **not built**.
- Importers: PuTTY registry sessions **(shipped — `putty_import.rs`; no
  passwords are stored there, so it is structure only)**. Tabby config YAML is
  **not built**.
- Secrets live only in Rust memory (`zeroize` on drop); the webview receives
  only non-secret session metadata.

---

## 4. Phased Execution Plan

Each phase ends in a working, demoable app. Order front-loads the riskiest
integration work (PTY stream ↔ xterm.js performance, russh auth flows).

### Phase 0 — Scaffolding & walking skeleton (small)
- Tauri 2 + React + Vite + Tailwind scaffold; Rust workspace with empty crates
- xterm.js + WebGL addon rendering a local echo loop through a Tauri channel
  (proves the byte-stream IPC path and GPU rendering end-to-end)
- CI (fmt, clippy, tests, frontend lint/build), Windows build artifact
- App identity: product name **wRusTTY**, bundle ID `sh.wrustty.app`, icon
  in `docs/branding/`. Repo directory may remain `wr-term`; that's just the
  checkout path and doesn't need to match.

### Phase 1 — SSH core (the heart) — **shipped, bar the last line**
- `wr-ssh`: connect, password + public-key auth, keyboard-interactive,
  known_hosts TOFU with accept/reject dialog, PTY channel, resize, disconnect
- Encrypted OpenSSH key file support with passphrase prompt
- Single-session UI: quick-connect dialog → live terminal tab
- Keepalive; clean error surfaces (auth failed vs host unreachable vs key mismatch)
- Integration tests against a containerized sshd — **not built**, and now
  partly unnecessary: `wr-ssh/tests/keyboard_interactive.rs` stands a `russh`
  *server* up on a loopback port and drives a real handshake against it, with
  no container and no sshd. That covers the auth path whose behaviour is
  decided by the server (how many rounds, what each asks, which fields are
  secret) and is the pattern to copy for the rest. Every other SSH path is
  still covered by unit tests and by hand. CI (`ci.yml`, `audit.yml`) does run.

### Phase 2 — Tabs & session manager
- Multi-tab UI (Tabby-style tab bar), per-tab connection state, close/duplicate/reconnect
- Session manager sidebar: folders, saved sessions (host, port, user, terminal prefs)
- Settings persistence (JSON config, separate from vault)
- Keyboard shortcuts (new tab, close, next/prev, quick-connect palette) —
  **shipped, and configurable** (see terminal & UX)

### Phase 3 — Vault
- `wr-vault` as designed above; master-password onboarding flow
- Credential storage per session (password / key path + passphrase), auto-lock
- Import/export UI; PuTTY session import
- Optional Windows Credential Manager unlock

### Phase 4 — Telnet & Serial
- `wr-telnet`: option negotiation (ECHO, SGA, NAWS, TTYPE), same tab UX
- `wr-serial`: port enumeration with friendly names, hotplug refresh, full line
  settings, local echo / line-ending controls, DTR/RTS toggles
- Session manager grows protocol-specific forms **(shipped)** — a saved serial
  session stores the adapter's USB identity, not a COM number, so it survives
  the adapter moving socket (see `SerialProfile`)

### Phase 5 — Polish & PuTTY parity — **partial**
- Port forwarding (local/remote/dynamic) with a management panel **(shipped)**
- Jump host chains **(shipped)**; outbound proxy, HTTP CONNECT and SOCKS5
  **(shipped)**
- Font settings, paste protection, scrollback search, session logging
  **(shipped)**; colour-scheme import **(shipped)** — eleven presets, a palette
  editor for custom themes, and Import… reads an iTerm2 `.itermcolors` or a
  VS Code theme (`4f6dc85`). An imported theme is a custom theme like any
  other; nothing downstream knows where it came from
- Win11 polish: Mica and single instance **(shipped)**; jump list and portable
  mode **not built**
- Installer (NSIS/MSI via the Tauri bundler) **(shipped)**; auto-update and code
  signing **not built** — the two that have to be settled before any public
  release

### Phase 6 — Files (extended capability) — **browse, edit, transfer, folders, mutations, retry, resume and surviving a dropped connection all ship; SCP does not**

#### What is built

- **Transport.** *Two* SFTP subsystem channels per SSH session, each opened
  lazily on first use and held for the connection's lifetime
  (`get_or_open_sftp` and `get_or_open_transfer_sftp`, both `OnceCell`s). This
  plan flagged the single-channel design as the structural decision to take
  early, and it was taken: one client serialises everything asked of it, so a
  download running for a minute would hold up every directory listing behind
  it — the panel would freeze for exactly as long as the transfer it is showing
  progress for. Browsing and editing use the first; anything with a progress bar
  uses the second (`browse_client` / `transfer_client` name the choice at each
  call site). A session that never transfers anything never opens the second.
  SSH only — telnet and serial have no file transfer and never will.
- **`wr-sftp`** is a thin transport: `list_dir`, `stat`, `write`,
  `canonicalize`, `try_exists`, `remove_file`, `remove_dir`, `create_dir`,
  `rename`, and streaming `upload` and `download`. `write` is `CREATE | TRUNCATE | WRITE` plus `sync_all`,
  deliberately not `russh_sftp`'s own `write`, which leaves the tail of a
  longer previous file stranded past the end of the new data and reports
  nothing. There is deliberately no `read`: returning a whole file as a
  `Vec<u8>` was the thing that made every download unbounded in memory, and
  deleting it is what stops the next caller reaching for it.
- **Folders transfer recursively, in both directions, and delete recursively.**
  The tree is walked before anything moves, which buys the two things a folder
  transfer needs and a single file does not: a byte total to show progress
  against, and the chance to refuse an unreasonable job (`MAX_TREE_ENTRIES`)
  while the destination is still untouched. The same walk backs the delete's
  confirmation, so it can say "341 files and 27 directories" rather than "are
  you sure".
  - **There is no atomic tree.** Each *file* keeps its own guarantee — staged,
    then renamed into place — but a job that stops halfway leaves what it
    already finished. Staging a whole tree elsewhere would double the disk
    needed and there is no atomic directory swap to reach for; what matters is
    that no individual file is ever half-written and that the failure names the
    file it got to.
  - **Symlinks are skipped, and said so.** Following them means a link to `/`
    copies the filesystem and a link to an ancestor never terminates. Copying
    them as links would be better, but a link's target usually means nothing on
    the other side, so recreating one produces something broken that looks like
    it worked. A recursive *delete* unlinks them without following, which is the
    reason deleting a directory holding a link to `/etc` removes the link.
  - **A folder upload merges, and the dialog says merge.** Files with the same
    name are replaced; anything else already there is left alone. That is a
    materially different promise from the single-file replace, and using one
    word for both would be a lie in one of the two cases.
  - **Only the picker can send a folder.** A drop hands the webview a `File`
    with no path, so there is nothing to walk — `verdictForDrop` still refuses
    one, and that is a limit of the drag, not of the feature.
- **More than one transfer at a time.** The backend always allowed it — the
  `transfers` map was there from the start — and only the panel's single
  progress row did not. It is a list now.
- **A failed transfer stays on screen with a Retry that resumes.** Resume skips
  destination files that already look copied, so retrying a folder that died on
  file 400 of 500 costs the remaining hundred.
  - **The skip rule claims less than it looks like it does.** Same size, and
    where both sides report an mtime the destination's must not be older. That
    is "the destination looks like the result of having copied this", not "these
    files are identical" — reading both to be sure is the transfer it exists to
    avoid. The mtime half is what stops an edited config of coincidentally equal
    size being skipped; a fresh destination always passes it, since writing it
    set its mtime to now.
  - **Resume is off for a first run and on for a retry.** A fresh copy should
    copy; only a retry has a reason to assume anything already there is its own
    work.
  - **Skipped files are reported**, like skipped symlinks, because a silent
    size-only skip is exactly what gets found out later by something that needed
    the file.
  - **The automatic retry is narrow on purpose.** `SftpError::is_transient`
    claims only what the protocol itself calls timing, and treats the catch-all
    `Failure` — which servers return for a full disk as readily as a read-only
    mount — as permanent. Retrying a permission error three times delays the
    real message and teaches nobody anything; missing a genuine hiccup costs one
    click on a button that exists anyway.
  - Each attempt **restarts the file** rather than continuing it, so a retry can
    never append to the half a failed attempt left. Progress for that file goes
    backwards, which is the truth about what is being sent.
- **Both directions stream**, chunk by chunk, with progress and cancellation,
  and neither writes over its destination until the whole file has arrived —
  `.wrustty-part` remotely, a sibling part file plus `wr_fs::replace_atomic`
  locally. Cancellation is the progress callback's return value in both, so a
  transfer stops within one chunk rather than one file.
- **Drag-and-drop upload onto a pane**, and **the Files panel's context menu and
  upload button** (see terminal & UX for the rules of both, including why
  dragging a file *out* is not the counterpart it appears to be).
- **Browsing** — the Files panel: breadcrumb, up, refresh, and entries with
  type, name and size. **It opens where the pane is standing** — the directory
  the host last reported, the same one a file dropped on that pane would land
  in. The two used to disagree: you could drop a file onto a pane sitting in
  `/etc/nginx`, open the panel to check it arrived, and be looking at
  `/home/tim`. The reported directory already existed in `cwdByPane` for the
  status bar; the panel simply wasn't given it.
  - Read **once, at mount**. Following it afterwards would yank the listing out
    from under someone who had navigated elsewhere in the panel, every time they
    ran `cd` in the terminal behind it. The panel is somewhere you browse, not a
    mirror of the prompt.
  - **It takes the window-title guess where the drop will not** (`startDirFor`).
    Wiring only the *reported* directory fixed nothing for the most common host
    there is: a stock bash on Debian or RHEL sets `\[\e]0;\u@\h: \w\a\]` and no
    OSC 7 at all, so the panel still opened at home however plainly the title
    said `/tmp`. The drop refuses to act on a title — it prefills a prompt and
    makes the user confirm, because putting a file somewhere they did not choose
    is not undoable. Browsing has no such asymmetry: landing in the wrong
    directory costs one click of the up arrow. That difference is why the two
    do not share one rule.
  - **A leading `~` is resolved first** (`expandHome`). `\w` renders the home
    directory as `~`, so these titles are full of them, and SFTP has no tilde
    expansion — sent as-is, `~/src` asks for a directory literally called `~`.
  - **Falls back to the remote home** (`canonicalize`, which beats guessing
    `/home/<user>`) when there is nothing to go on, and also when what it was
    aimed at does not list — a report is not a promise, and a guess is even
    less of one.
- **Mutations: rename, delete, new folder.** Rename and delete live in the
  context menu below a divider, delete last and coloured; new folder is a
  toolbar button. Rename and mkdir share one inline text field, committed on
  Enter or blur and left open on failure, since the usual failure is a name
  collision the user fixes by typing. Four rules carry the feature, all of them
  enforced in the backend and mirrored in `lib/fileActions.ts` so the menu can
  grey an item out with the reason attached rather than offering it and then
  refusing:
  - **A rename cannot become a move.** `rename_target` builds the destination
    from the *source's* parent plus a name that is rejected if it carries a
    separator, so there is no argument that could redirect it. A file that has
    silently moved is far harder to notice than one that failed to rename.
  - **Neither touches a file an edit watch is pointing at.** The watch holds the
    old remote path and nothing re-targets it, so renaming a watched file leaves
    the next save recreating the old name beside the new one, and deleting one
    leaves the next save bringing it back — minutes later, on a keystroke the
    user believes is saving something else, reported as a success. Refusing is
    the honest fix; re-targeting on rename would be better but has no
    counterpart for delete, and one rule covering both is easier to rely on.
  - **Directory-ness is settled by `stat`, not by the listing.** The frontend's
    answer may be minutes old, and being wrong means `rmdir` on a file or
    `unlink` on a directory — both fail, neither says why.
  - **A non-empty directory is deleted only after being counted.** SFTP has no
    recursive delete, so this walks the tree itself — and the walk is what lets
    the confirmation name what it is about to remove instead of asking whether
    the user is sure.
- **Remote editing, in a different shape than this plan first described.** A
  file streams to an OS temp directory with its basename preserved, opens in
  *the user's own* default application, and the containing directory is watched
  — every save re-uploads, with `uploading`/`uploaded`/`uploadFailed` driving
  the panel's "watching" chip. Watches outlive the panel on purpose, so
  `sftp_list_edits` is the authoritative list.
- **An editor that waits ends its own watch** (`externalEditor`, off by
  default). The chip exists because the OS opener returns the instant it has
  dispatched the file — usually to an editor already running — so there is no
  process whose exit means anything, and "are you finished" is unanswerable.
  A configured command that *blocks* (`code --wait`, `subl --wait`, `gvim -f`)
  turns that into a real signal: the watch tears itself down and the temp copy
  goes with it.
  - **Off by default even though it is better**, because the default opens the
    user's *own* editor with no setup at all. This is the trade to opt into.
  - **A command that returns too quickly is treated as misconfigured, not as an
    answer.** Without its wait flag a launcher hands off and exits at once,
    which is indistinguishable from "closed instantly" — and acting on it would
    delete the temp file out from under an editor the user is still typing in.
    Under `MIN_EDITOR_LIFETIME` the watch is kept and the frontend says which
    flag is missing.
  - **The teardown waits out the save debounce** (`EDITOR_EXIT_GRACE`). Editors
    write and then exit, so the write's 300 ms debounce is usually still pending
    when the process is already gone; tearing down immediately would lose the
    last edit at the exact moment the user believes they are done.
  - **No extension confirmation on this path**, deliberately. That prompt guards
    against the *OS handler* for a type being something that executes it; a
    named text editor is not that handler, and asking anyway would train the
    user to dismiss a warning that still matters on the other route.
  - **Backslash is not an escape** in the command. It is the path separator
    here, and treating `C:\Program Files\...` as escapes is how a setting that
    looks obviously correct fails mysteriously. Only double quotes group.
- **Editing a root-owned file, by holding a process rather than a password**
  (`crates/wr-ssh/src/sudo.rs`, `sftp_elevate_edit`). SFTP has no
  privilege-escalation verb — the subsystem runs as whoever authenticated — so
  `/etc/nginx/nginx.conf` was unreadable and unwritable however plainly the
  user could `sudo` in the pane beside it. An open or a save the host refuses
  on permission now offers to go through sudo, and the panel marks those
  watches with an amber **root** chip that ends the elevation when clicked.
  - **The privilege is a process, not a cached secret.** Caching the sudo
    password for the life of an edit keeps the wrong thing — on most hosts it
    is also the login password. Sudo's own 15-minute timestamp cannot stand in
    for it either: sudo keys the ticket to the controlling tty and falls back
    to the parent pid, and every exec channel is a separate process under a
    separate sshd child, so a ticket primed on one is invisible to the next.
    So one channel per elevated edit runs a helper that copies a staged file
    over a destination and does nothing else; the password authenticates it
    once and is dropped. What remains is visible, endable, and cannot outlive
    the SSH session.
  - **Two entry points, because the case that bites is the second one.** A file
    under `/etc` is usually world-readable and root-writable, so the open works
    and the *save* is refused minutes and several edits later.
    `sftp_elevate_edit` handles that without touching the local copy, then the
    panel calls `sftp_save_edit` so the mtime conflict check still runs — an
    elevated write must not become a way past a warning that someone else
    changed the file.
  - **Ownership is judged from uid and gid, not names.** The first prediction
    compared owner and group *names* from the listing, and SFTP v3 carries none
    — `russh_sftp` hardcodes both to `None` whatever the server sent — so it
    could never fire. uid, the gid list from one `id` per session, then the
    other triad. Only a *definite* refusal routes an open straight to sudo;
    everything uncertain still tries the ordinary way, because ACLs, immutable
    bits, read-only mounts, SELinux and root-squash all refuse writes the mode
    bits permit.
  - **`sudo -v` is classified separately from a command.** It executes nothing,
    so authentication and policy are the only things it can fail on — an
    unfamiliar refusal means "wants a password", not failure. Chasing sudo's
    phrasings would fix one host and not the next. A command's stderr keeps the
    allowlist, since there a third category genuinely exists (no such file,
    read-only filesystem, out of space).
  - `cp` rather than `install` or a rename, so the destination inode's owner,
    mode, ACLs, xattrs and SELinux context survive and a symlinked config is
    followed. `sudo -n` is tried first, so a NOPASSWD host never sees a dialog;
    the password goes on stdin, never the command line.
- **The open path is hardened**, and that work should not be re-litigated when
  the rest of this phase lands: an inert-extension allowlist with a
  confirmation dialog for anything whose OS handler executes (`.hta`, `.lnk`,
  `.js`, `.py`, and `.svg` — a browser will run script in it), plus reserved
  device names, alternate data streams and trailing dots/spaces rejected in
  remote-chosen filenames. Anything that writes a remote name to local disk
  inherits these rules.

#### What is not, roughly in the order it matters

1. ~~**Surviving a dropped connection.**~~ **Built.** A transfer whose transport
   goes is set aside rather than failed, and re-run with `resume` when the
   session comes back — under the same transfer id, so the row the user is
   watching carries on. It cost little because everything it needed had already
   arrived: the trigger is the `on_transport` hook the port forwards added, and
   the fresh channel comes free, since re-running the command re-resolves the
   SFTP client through a `OnceCell` that a disconnect resets.
   - **A drag-and-drop upload is the exception, and says so.** Its bytes come as
     chunks from the webview, which holds a `File` the backend has no path for,
     so there is nothing to read them from a second time. Same asymmetry that
     already stops a drop sending a folder.
   - **"Interrupted" is a different state from "failed"** — one asks the user to
     do nothing because the reconnect is running, the other asks them to fix
     something and offers Retry. Collapsing them would send people to repair
     what is about to repair itself.
2. **The edit save still reads its local file whole.** The download half of that
   round trip streams; the re-upload on save calls `write` with a `Vec<u8>` read
   from the temp copy. Bounded by whatever the user just saved rather than by a
   remote host's word, so it is a much smaller version of the problem streaming
   fixed — but the same shape, and `upload` is right there.
3. **The editor setting is per-app, not per-file-type.** One command opens
   everything, so someone who wants a hex editor for binaries and a text editor
   for configs has to choose. A per-extension mapping is the natural extension
   and nothing in the current shape prevents it.
4. **Symlinks are skipped in both directions, and cannot yet be copied.** The
   walk reports how many it passed over, which is the honest minimum. Recreating
   them properly means deciding what a link means on the other side, and for a
   *download* the answer is usually "nothing" — a target path that only resolves
   on the host it came from. Worth doing for upload before download.
5. **SCP fallback** for hosts with the SFTP subsystem disabled — common on
   network appliances, which is squarely this app's audience.

   **Scope it before building it: SCP has no directory listing.** The protocol
   is "send me this path" and "receive this path", nothing else. So a fallback
   cannot make the Files panel work on an SFTP-less host — it can only serve
   transfers whose paths are already known, which in practice means drag-and-drop
   upload onto a pane (the destination comes from the reported cwd, not from a
   listing) and a download to or from a typed path. That is still the appliance
   case, and worth having; it is just not "the app works the same without SFTP",
   and planning it as though it were is how it ends up half-built.

   Making the panel work anyway would mean running `ls -l` over an exec channel
   and parsing it, which is a different and much more fragile feature: the
   output differs between GNU, BusyBox and vendor shells, is locale-dependent,
   has no machine-readable form, and is genuinely ambiguous for names containing
   spaces or newlines. It would work on most Linux hosts and misbehave on
   exactly the appliances it exists for.

   Worth building against a real host that forces the issue, so the protocol
   work can be verified as it is written rather than after.
6. **`chmod` is per-entry only** — no recursive apply, and no way to set the
   permissions a recursive *upload* lands with (they come out as whatever the
   server's umask says, not what they were locally).
7. **Panel affordances**: multi-select, sort, filter, hidden-file toggle, and
   the optional dual-pane manager view (r-shell has a reference
   implementation).
8. **The in-app Monaco editor is now a decision, not a task.** The external
   editor route is arguably the better feature — a real editor, real
   keybindings, no bundled editor weight — and Monaco would mainly buy in-app
   diff and conflict UI, most of which conflict detection now delivers without
   it. Schedule it deliberately or kill it; leaving it on the list implies the
   edit flow is unfinished when it is not.

#### The structural decision, taken

*Kept for the reasoning, which still applies to anything added here.* The single
shared channel meant a large transfer blocked browsing and every other SFTP
operation on that session, since they queue behind it. Opening a second channel
for transfers is cheap (`channel_open_session` + `request_subsystem`) and much
harder to retrofit once the UI assumes it can do two things at once — so it was
opened in the same change that gave the UI a reason to want it.

One deliberate exception: **the edit flow stays entirely on the browsing
channel**, both its initial download and the re-upload on every save. Splitting
it would let a save queue behind an unrelated download while the user waits,
having pressed Ctrl-S and been told nothing. The cost is that opening a very
large file for editing does hold up browsing for its duration — a worse trade in
the abstract, a better one for the flow that actually exists, which has no
progress UI to put on the other channel anyway.

---

## 5. Risks & watch items

- **Terminal throughput over IPC** — **borne out, and it went further than
  this line expected.** Raw channels were not enough on their own: it took
  backend coalescing with a credit window (`coalesce.rs`), a frontend write
  scheduler, and ultimately replacing xterm.js with the Ghostty core to make
  `cat largefile` behave. Kept as a watch item because every one of those
  parts is still load-bearing.
- **russh coverage** — agent auth and ProxyJump are in and working; rekey
  behaviour under a long-lived session is still the untested corner. Auto-
  reconnect does not test it and was never going to; what it does is make the
  answer survivable, since a rekey that drops the transport now looks like any
  other drop and comes back.
- **WebView2 quirks** — WebGL context loss on GPU driver resets is **handled**
  (`ContextManager`, `rebuildWebglRenderer`), and the note about xterm's canvas
  fallback no longer applies: there is no fallback renderer, so context
  recovery is the only path and has to keep working.
- **`.ppk` support** — **resolved**: v2 and v3 keys load natively, encrypted
  ones included, with fixtures in `wr-ssh/tests/fixtures`.
- **SmartScreen** — still open, and still the thing that gates a public
  release. Nothing about signing or auto-update is set up.
- **No integration test against a real sshd** — the SSH paths that matter most
  are the ones with no automated coverage at all. See Phase 1.
- **The elevated-edit path is only partly exercised against a real host.** It
  shipped unverified — there is no sshd with a sudoers policy in this
  environment — and the first live contact immediately found two things a unit
  test could not: a prediction written against a field the protocol never sends
  (`178b2a4`) and a sudo refusal phrasing outside the allowlist (`1a23159`).
  What has still never run for real is the READY handshake under a noisy login
  shell, the `sudo -n` fast path on a NOPASSWD host, the `sudo cat` read, and
  the staged copy on a BSD `mktemp`. Treat a failure here as first-contact
  rather than as a regression.
- **Auto-reconnect was one missing capability wearing three hats** — named here
  as one thing because the plan used to mention it in three separate places as
  though it were three. **Phase 1 is built** (`docs/AUTO_RECONNECT_PLAN.md`):
  the reconnect keeps the session id, so the frontend's engine and scrollback,
  the logging sink, the SFTP edit watchers and the coalescer's credit window all
  survive a drop, and keystrokes typed mid-reconnect are queued and replayed by
  the machinery `Slot::Connecting` already had. All three transports, since
  `SessionRegistry` is generic over `Connector`.

  Of the three hats: the disconnect overlay now has something better than a
  button; the transfer one is closed (Phase 6, item 1); the rekey corner is
  survivable but still untested. Worth keeping on this list rather than
  declaring the capability done, for what is left:

  - **Phase 2** — **port forwards are done**: they are marked dead the moment
    the transport goes, re-established against the connection that comes back,
    and one that cannot be (its local port taken meanwhile) is shown as down
    with the reason and a retry, rather than listed as though it were carrying
    traffic. Both ends of that matter — reporting only the recovery leaves a
    forward described as healthy for the whole outage, which is the same lie in
    a longer window. **In-flight transfers are done too**: set aside on the drop
    and resumed under the same id when the session returns, except a
    drag-and-drop upload, whose bytes the backend never had a path for. So this
    phase is complete.
  - **Phase 3 — done.** A global switch, a per-profile opt-out, and both run
    limits (attempts and wall clock), all beside `closeOnDisconnect` in
    Settings. Everything subtracts and nothing adds: the global setting, the
    profile, and the backend's refusal to reconnect a session whose credential
    has to be typed in are three ways to say no with no fourth that says yes,
    which is why a profile stores `false` or nothing and never `true`. The
    limits are clamped on arrival — they are loop bounds coming off the IPC
    boundary. `AUTO_RECONNECT_PLAN.md` has the reasoning.
    - The `closeOnDisconnect` clash was **resolved earlier**, as part of the
      same phase but ahead of it: the setting closes a pane whose session
      *ended* and leaves a *lost* transport to reconnect, which is what it
      always claimed to do. It previously fired on both, and since it is on by
      default and closing a pane drops the session id that a reconnect run
      needs, most users had auto-reconnect silently switched off.
  - **Tested against a real drop — for SSH.** This said "untested", and called
    it the part most likely to be right for the wrong reason. It has since been
    run: a live SSH session to a real host, severed by a TCP reset from a relay
    standing in for the network path, so the transport died without the machine
    losing the network it was being driven over. `russh` surfaced it as an
    error rather than a clean close, the registry classified it `Lost`, the
    retry run started, and the session came back under the same id with its
    scrollback intact. So the judgement about `russh` and the OS holds where it
    was most doubted.
    - **Telnet and serial are still untested**, and are separate judgements —
      a serial adapter being unplugged is a different event reaching a
      different crate. Serial is the easiest of the three to test honestly and
      the best case the feature has.
    - A reset is not the only shape a drop takes. A link that goes *silent*
      relies on the keepalive timeout instead, which this did not exercise.
