# wRusTTY — Project Plan

A lightweight, security-focused SSH / Telnet / Serial client for Windows 11 with a
modern GUI, tabbed session management, an encrypted credential vault, and
GPU-accelerated terminal rendering. Remote file browsing and editing over SFTP
have since landed; file *transfer* — download, upload, progress — has not, and
is the bulk of what Phase 6 still holds.

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
| Terminal | **Vendored Ghostty VT core (WASM) + an in-house WebGL renderer** | Superseded the original xterm.js choice. xterm's addons (search, fit, links, unicode) all had to be reimplemented as a consequence — see `SearchController`, `fitGrid`, `LinkController`. xterm survives only as the benchmark harness's comparison engine (`src/bench`, `lib/xtermEngine.ts`); `src/lib` no longer depends on it |
| SSH | `russh` + `russh-keys` | Pure Rust (memory-safe crypto surface), async, actively maintained, proven in r-shell |
| SFTP | `russh-sftp` | Same ecosystem. In use: browsing, editing and streaming upload ship; download still reads whole files (Phase 6) |
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
│   ├── wr-sftp/          # SFTP operations (browse, read/write, streaming upload)
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
  `AuthMethod::KeyboardInteractive`)**
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
- **Host key management UI** — view/remove/pin known hosts. **Not built**: the
  mismatch/TOFU prompt exists (`HostKeyPrompt.tsx`, `ssh_respond_host_key`) but
  there is no way to list or remove an entry, so a stale key can only be fixed
  by hand-editing `known_hosts`. The most conspicuous security gap left.
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
- Session logging to file (timestamped, per-session toggle) — network/serial
  engineers rely on this constantly **(shipped)**
- Named colour themes **(partial — five built in, and a per-pane background
  opacity; importing iTerm/VS Code schemes and following the OS light/dark
  setting are not built)**
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
- Integration tests against a containerized sshd — **not built**. `wr-ssh/tests`
  holds key fixtures and no test target, so every SSH path is covered by unit
  tests and by hand. CI (`ci.yml`, `audit.yml`) does run.

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

### Phase 6 — Files (extended capability) — **partial: browse, edit and upload ship; download and mutations do not**

#### What is built

- **Transport.** One SFTP subsystem channel per SSH session, opened lazily on
  first use and held for the connection's lifetime (`get_or_open_sftp`, a
  `OnceCell`). Every command below shares it. SSH only — telnet and serial have
  no file transfer and never will.
- **`wr-sftp`** is a thin transport: `list_dir`, `read`, `write`,
  `canonicalize`, `try_exists`, `remove_file`, `rename`, and a streaming
  `upload`. `write` is `CREATE | TRUNCATE | WRITE` plus `sync_all`,
  deliberately not `russh_sftp`'s own `write`, which leaves the tail of a
  longer previous file stranded past the end of the new data and reports
  nothing.
- **Upload streams**, chunk by chunk, with progress and cancellation — and
  never writes over the destination until the whole file has arrived. Reads do
  not stream yet; see below.
- **Drag-and-drop upload onto a pane** (see terminal & UX for the rules).
- **Browsing** — the Files panel: breadcrumb, up, refresh, and entries with
  type, name and size. `canonicalize` resolves the remote home so the panel
  opens somewhere sensible rather than guessing `/home/<user>`.
- **Remote editing, in a different shape than this plan first described.** A
  file downloads to an OS temp directory with its basename preserved, opens in
  *the user's own* default application, and the containing directory is watched
  — every save re-uploads, with `uploading`/`uploaded`/`uploadFailed` driving
  the panel's "watching" chip. Watches outlive the panel on purpose: there is
  no way to detect an external editor closing, and stopping early would
  silently drop the next save, so `sftp_list_edits` is the authoritative list.
- **The open path is hardened**, and that work should not be re-litigated when
  the rest of this phase lands: an inert-extension allowlist with a
  confirmation dialog for anything whose OS handler executes (`.hta`, `.lnk`,
  `.js`, `.py`, and `.svg` — a browser will run script in it), plus reserved
  device names, alternate data streams and trailing dots/spaces rejected in
  remote-chosen filenames. Anything that writes a remote name to local disk
  inherits these rules.

#### What is not, roughly in the order it matters

1. **Streaming, in the download direction.** Uploads stream (that was the
   blocker, and it is gone); `read` still returns a `Vec<u8>`, so a download —
   including the one behind every remote *edit* — holds the whole file in
   memory with no progress and no way to stop. The upload side is the pattern
   to follow: a chunk loop, a bounded queue, a progress callback that doubles
   as the cancellation check.
2. **Conflict detection — the cheapest real fix in the list.** The save path
   writes `CREATE | TRUNCATE` with no check, so a remote file that changed
   between download and save is silently clobbered. `list_dir` already returns
   an mtime, so remembering it at download and prompting on a mismatch is a
   small change. This plan filed it under the Monaco editor; it belongs to the
   external-editor flow that actually shipped.
3. **Download, and upload from somewhere other than a drop.** No "save as" to
   a chosen local path; no file picker for uploading, which is the route for
   anyone who would rather not drag. The upload half of the machinery now
   exists, so a picker is a small command over `sftp_upload_begin` — and one
   that could hand over a *path* rather than bytes, since the dialog plugin
   gives one.
4. **Mutations: rename, delete, mkdir, chmod.** None are exposed — the crate
   has `rename` and `remove_file` now, but only the upload's own replace uses
   them. Note `RemoteEntry`
   carries name, isDir, isSymlink, size and modified — no mode and no owner —
   so chmod needs metadata plumbed through the crate before it needs a UI, and
   a permissions column is worth having on its own.
5. **Retry after a dropped connection.** An upload that fails mid-save reports
   `uploadFailed` and stops. Nothing is lost (the temp file survives), but
   there is no retry and no queue — which starts to matter exactly when
   transfers are large enough to span a reconnect.
6. **SCP fallback** for hosts with the SFTP subsystem disabled. Common on
   network appliances, which is squarely this app's audience.
7. **Panel affordances**: multi-select, sort, filter, hidden-file toggle, and
   the optional dual-pane manager view (r-shell has a reference
   implementation).
8. **The in-app Monaco editor is now a decision, not a task.** The external
   editor route is arguably the better feature — a real editor, real
   keybindings, no bundled editor weight — and Monaco would mainly buy in-app
   diff and conflict UI, most of which item 2 delivers without it. Schedule it
   deliberately or kill it; leaving it on the list implies the edit flow is
   unfinished when it is not.

#### One structural decision to take early

The single shared channel means a large transfer blocks browsing and every
other SFTP operation on that session, since they queue behind it. Opening a
second channel for transfers is cheap now (`channel_open_session` +
`request_subsystem`) and much harder to retrofit once the UI assumes it can do
two things at once.

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
