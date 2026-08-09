# wRusTTY — Project Plan

A lightweight, security-focused SSH / Telnet / Serial client for Windows 11 with a
modern GUI, tabbed session management, an encrypted credential vault, and
GPU-accelerated terminal rendering. Remote file browsing, editing and transfer
over SFTP have since landed — files and whole folders move in both directions,
streamed, with progress and cancellation; rename, delete, new folder and chmod
are in the panel's context menu; a failed transfer can be retried and resumes
where it stopped; and a save can no longer quietly overwrite a remote file that
changed underneath it. What Phase 6 still holds is a transfer surviving the
*connection* going away — which is auto-reconnect's problem, not the transfer
layer's — and an SCP fallback for hosts with no SFTP subsystem.

- **Stack:** Rust + Tauri 2 backend, TypeScript + React frontend, a vendored
  Ghostty VT core (WASM) behind the app's own WebGL renderer
- **Visual reference:** Tabby (`/home/tim/Repos/tabby`) — layout, theming, polish
- **Architecture reference:** r-shell (`/home/tim/Repos/r-shell`) — Tauri 2 + russh
  patterns, SFTP client structure

**The status markers below are audited against the code**, not estimated:
**(shipped)** means it is in the app today, **(partial)** names what is missing,
and an unmarked item is not built. Re-audit rather than trusting them if much
time has passed — the previous set had drifted far enough that several shipped
features were still marked as ideas.

---

## 1. Technology Decisions

| Concern | Decision | Rationale |
|---|---|---|
| App shell | Tauri 2 | Small installer (<10 MB), native WebView2 on Win11, no Electron overhead |
| Frontend | React + TypeScript + Vite + Tailwind | Matches r-shell; large ecosystem; fast iteration |
| Terminal | **Vendored Ghostty VT core (WASM) + an in-house WebGL renderer** | Superseded the original xterm.js choice. xterm's addons (search, fit, links, unicode) all had to be reimplemented as a consequence — see `SearchController`, `fitGrid`, `LinkController`. xterm survives only as the benchmark harness's comparison engine (`src/bench/xtermEngine.ts`); `src/lib` no longer depends on it. **The vendored core is ghostty `main` at a pin, not the v1.3.1 release** — that port is finished, including keyboard, mouse and paste encoding, and `docs/PORT_GHOSTTY_MAIN.md` is its record. The v1.3.1 build stays in `vendor-131/` as the parity oracle, since without a second implementation the parity suites would compare `main` with itself and pass for nothing |
| SSH | `russh` + `russh-keys` | Pure Rust (memory-safe crypto surface), async, actively maintained, proven in r-shell |
| SFTP | `russh-sftp` | Same ecosystem. In use: browsing, editing, and streaming transfer in both directions. Two subsystem channels per session — one for browsing, one for bulk transfers, so a long download doesn't freeze the panel showing its progress |
| Serial | `serialport` crate | Cross-platform, COM enumeration, USB hotplug |
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
mosh, RDP) means adding a crate, not touching the UI.

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
  requires it **(shipped)**, with a management panel
- **Keepalive** with visible connection state per tab **(shipped — per-profile
  interval, see `SshConfig::keepalive_seconds`)**. Auto-reconnect is not built.
- **Wake-on-LAN** — a per-profile MAC, sent before connecting to a host that
  isn't answering **(shipped — `src-tauri/src/wake.rs`, run from the registry's
  pre-connect hook)**. Probes first, so an already-awake host is never sent
  anything. Not attempted behind a jump host; see TODO.md for that and for
  automatic multi-interface broadcast.
- Proxy support (HTTP CONNECT / SOCKS5) **for reaching a host through a
  corporate proxy** — not built. Note the SOCKS5 code in `wr-ssh/src/socks.rs`
  is the *dynamic forward's own server* and is not this; the two get confused
  because they share a protocol name.
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
- **PuTTY session import** (Windows registry) — your single best adoption
  feature **(shipped)**
- Scrollback search, configurable scrollback limit, copy-on-select, right-click
  paste **(shipped)**
- Shell integration (OSC 133/633): per-command status, and a notification when
  a long command finishes with the window in the background **(shipped — see
  `docs/SHELL_INTEGRATION.md`)**
- True colour **(shipped)**, wide characters and grapheme clusters **(shipped —
  the core's, exercised by `readRows.test.ts`)**, font family and size
  **(shipped)**, cursor styles **(shipped — shape and blink, plus DECSCUSR)**.
  Ligature configuration is **not built**.
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
  engineers rely on this constantly **(shipped)**
- Named colour themes **(partial — five built in, and a per-pane background
  opacity; importing iTerm/VS Code schemes and following the OS light/dark
  setting are not built)**
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
- Configurable keyboard shortcuts — **not built**; every binding is hard-coded
  in `Terminal.tsx` and `App.tsx`
- Duplicate tab / reconnect / "restart session" actions **(shipped — the tab
  context menu)**. Automatic reconnection on an unexpected drop is not built;
  the overlay offers the button.
- Serial QoL: live port hotplug refresh, common baud presets, DTR/RTS toggles
  **(shipped)**, local echo and line-ending options (CR/LF/CRLF) **(shipped)**,
  input mode — Normal/Local echo/Readline/Readline-hex, matching Tabby's
  local line-editor behavior for devices that don't echo or expect a whole
  line at once **(shipped)** — this is where PuTTY is weak and you can win.
  Audited the rest of Tabby's serial options (slow-feed byte-by-byte send,
  independent input/output newline modes, hex-dump output mode, live
  baud-rate change) as lower-value or awkward fits and left them out for now.

### Recommended additions — Windows 11 polish
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
- Unlock once per app launch; auto-lock after configurable idle timeout.
- Optional convenience unlock: wrap the vault key with DPAPI via Windows
  Credential Manager (`keyring` crate) so the OS login unlocks it. **Shipped**,
  but it's silent (tied to the existing Windows logon session, not a fresh
  challenge) — no Windows Hello prompt appears on unlock.
- **Future**: full WebAuthn/FIDO2 Windows Hello support (the `hmac-secret`/PRF
  extension, deriving a key from a real per-use biometric/PIN challenge)
  for a case where a genuine fresh prompt is wanted, not just DPAPI's
  silent gate. Scoped out for now — a related idea (`UserConsentVerifier`,
  a simpler WinRT consent-prompt gate in front of the existing DPAPI key)
  was also considered and deferred after finding a documented unresolved
  compatibility issue for non-UWP desktop apps like this one
  (microsoft/windows-rs#1565). Both routes need real Windows Hello
  hardware to validate — untestable from the Linux dev machine this
  project is built on.
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
  role `UserConsentVerifier` would have played.
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
- Keyboard shortcuts (new tab, close, next/prev, quick-connect palette) — the
  bindings exist; making them *configurable* does not (see terminal & UX)

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
- Jump host chains **(shipped)**; outbound proxy support **not built**
- Font settings, paste protection, scrollback search, session logging
  **(shipped)**; colour-scheme import **not built**
- Win11 polish: Mica and single instance **(shipped)**; jump list and portable
  mode **not built**
- Installer (NSIS/MSI via the Tauri bundler) **(shipped)**; auto-update and code
  signing **not built** — the two that have to be settled before any public
  release

### Phase 6 — Files (extended capability) — **browse, edit, transfer, folders, mutations, retry and resume all ship; surviving a dropped connection and SCP do not**

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
- **The open path is hardened**, and that work should not be re-litigated when
  the rest of this phase lands: an inert-extension allowlist with a
  confirmation dialog for anything whose OS handler executes (`.hta`, `.lnk`,
  `.js`, `.py`, and `.svg` — a browser will run script in it), plus reserved
  device names, alternate data streams and trailing dots/spaces rejected in
  remote-chosen filenames. Anything that writes a remote name to local disk
  inherits these rules.

#### What is not, roughly in the order it matters

1. **Surviving a dropped connection**, which is the half of "retry" that is not
   built and cannot be built here. Resume and the Retry button cover a transfer
   that *failed*; neither covers the connection itself going away, because the
   session caches its SFTP client in a `OnceCell` and would hand back the same
   dead channel on every attempt. Reconnecting is the missing piece, and it is
   the same missing piece as auto-reconnect generally — so it belongs with that,
   not with transfers.
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
  behaviour under a long-lived session is still the untested corner.
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
- **Auto-reconnect is one missing capability wearing three hats**, and it is
  worth naming as one thing because the plan mentions it in three separate
  places as though it were three. There is no `autoReconnect` anywhere in the
  tree. What depends on it: the disconnect overlay, which can only offer a
  button; a transfer surviving the connection going away, since the session
  caches its SFTP client in a `OnceCell` and would hand back the same dead
  channel forever (Phase 6, "what is not", item 1); and the rekey corner above,
  which is the same session-lifetime question asked earlier. Building it once
  closes all three; building it per-symptom closes none of them properly.
  **Scoped in `docs/AUTO_RECONNECT_PLAN.md`** — the short version is that
  `SessionRegistry`'s `Slot` enum already has the shape for it, so a reconnect
  can keep the session id and with it the scrollback, whereas today's Reconnect
  button remounts the pane and loses it.
