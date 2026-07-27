# wRusTTY — Project Plan

A lightweight, security-focused SSH / Telnet / Serial client for Windows 11 with a
modern GUI, tabbed session management, an encrypted credential vault, and
GPU-accelerated terminal rendering. Future phases add SFTP/SCP file transfer and
remote file editing.

- **Stack:** Rust + Tauri 2 backend, TypeScript + React frontend, xterm.js terminal
- **Visual reference:** Tabby (`/home/tim/Repos/tabby`) — layout, theming, polish
- **Architecture reference:** r-shell (`/home/tim/Repos/r-shell`) — Tauri 2 + russh
  patterns, xterm.js integration, SFTP client structure

---

## 1. Technology Decisions

| Concern | Decision | Rationale |
|---|---|---|
| App shell | Tauri 2 | Small installer (<10 MB), native WebView2 on Win11, no Electron overhead |
| Frontend | React + TypeScript + Vite + Tailwind | Matches r-shell; large ecosystem; fast iteration |
| Terminal | `@xterm/xterm` + `@xterm/addon-webgl` | WebGL addon = GPU acceleration; addons for search, fit, links, unicode, clipboard |
| SSH | `russh` + `russh-keys` | Pure Rust (memory-safe crypto surface), async, actively maintained, proven in r-shell |
| SFTP (later) | `russh-sftp` | Same ecosystem |
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
│   └── wr-sftp/          # (Phase 6) SFTP/SCP operations
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
- **keyboard-interactive auth** — required for many 2FA/PAM setups; without it,
  plenty of real servers are unusable
- **ssh-agent support** — Windows OpenSSH agent (named pipe) and Pageant; users
  with hardware keys or agent-held keys expect this
- **Host key management UI** — view/remove/pin known hosts, clear warning dialog
  on mismatch (PuTTY's most security-critical behavior; do it better visually)
- **Encrypted key files** — load OpenSSH and PuTTY `.ppk` private keys, prompt
  for passphrase; consider `.ppk` → OpenSSH conversion helper
- **Paste protection** — bracketed paste, warn on multi-line/control-char paste
  (a real attack vector for terminal clients)
- **Zeroization discipline** — secrets never cross the IPC boundary to the
  webview; vault decrypts in Rust, auth happens in Rust, frontend only ever sees
  session IDs and status
- **Tauri hardening** — strict CSP, minimal capability grants, no remote content
- Algorithm configuration (allow disabling legacy kex/ciphers per session for
  old network gear — a big deal for serial/telnet-adjacent users)

### Recommended additions — connectivity
- **Jump host / ProxyJump chains** — table stakes for anyone on a bastion
- **Port forwarding** — local, remote, and dynamic (SOCKS); PuTTY parity requires it
- **Keepalive + auto-reconnect** with visible connection state per tab
- Proxy support (HTTP CONNECT / SOCKS5) for corporate networks

### Recommended additions — terminal & UX
- **PuTTY session import** (Windows registry) — your single best adoption feature
- Scrollback search, configurable scrollback limit, copy-on-select, right-click paste
- True color, Unicode 11, font/ligature configuration, cursor styles
- URL detection (web-links addon)
- Session logging to file (timestamped, per-session toggle) — network/serial
  engineers rely on this constantly
- Named color themes (import iTerm/VS Code schemes), light/dark following OS
- Configurable keyboard shortcuts
- Duplicate tab / reconnect / "restart session" actions
- Serial QoL: live port hotplug refresh, common baud presets, DTR/RTS toggles
  **(shipped)**, local echo and line-ending options (CR/LF/CRLF) **(shipped)**,
  input mode — Normal/Local echo/Readline/Readline-hex, matching Tabby's
  local line-editor behavior for devices that don't echo or expect a whole
  line at once **(shipped)** — this is where PuTTY is weak and you can win.
  Audited the rest of Tabby's serial options (slow-feed byte-by-byte send,
  independent input/output newline modes, hex-dump output mode, live
  baud-rate change) as lower-value or awkward fits and left them out for now.

### Recommended additions — Windows 11 polish
- Mica/acrylic window material, rounded corners, snap-layout support
- Dark/light mode sync with OS
- Single-instance with "open new tab in existing window"
- Jump list (recent sessions) on the taskbar icon
- Portable mode (config beside the exe) alongside installed mode
- **Code signing** — unsigned installers hit SmartScreen walls; budget for a cert
- Auto-update via `tauri-plugin-updater`

### Explicitly deferred / out of scope for now
- Split panes and broadcast-input (nice, but after core is solid)
- X11 forwarding, mosh, RDP/VNC (r-shell has these; not your mission)
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
- Import/export = the encrypted file itself (portable, safe to email/USB), plus
  plaintext JSON/CSV export behind an explicit "I understand" warning.
- Importers: PuTTY registry sessions (no passwords stored there — structure only),
  later Tabby config YAML.
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

### Phase 1 — SSH core (the heart)
- `wr-ssh`: connect, password + public-key auth, keyboard-interactive,
  known_hosts TOFU with accept/reject dialog, PTY channel, resize, disconnect
- Encrypted OpenSSH key file support with passphrase prompt
- Single-session UI: quick-connect dialog → live terminal tab
- Keepalive; clean error surfaces (auth failed vs host unreachable vs key mismatch)
- Integration tests against a containerized sshd

### Phase 2 — Tabs & session manager
- Multi-tab UI (Tabby-style tab bar), per-tab connection state, close/duplicate/reconnect
- Session manager sidebar: folders, saved sessions (host, port, user, terminal prefs)
- Settings persistence (JSON config, separate from vault)
- Keyboard shortcuts (new tab, close, next/prev, quick-connect palette)

### Phase 3 — Vault
- `wr-vault` as designed above; master-password onboarding flow
- Credential storage per session (password / key path + passphrase), auto-lock
- Import/export UI; PuTTY session import
- Optional Windows Credential Manager unlock

### Phase 4 — Telnet & Serial
- `wr-telnet`: option negotiation (ECHO, SGA, NAWS, TTYPE), same tab UX
- `wr-serial`: port enumeration with friendly names, hotplug refresh, full line
  settings, local echo / line-ending controls, DTR/RTS toggles
- Session manager grows protocol-specific forms

### Phase 5 — Polish & PuTTY parity
- Port forwarding (local/remote/dynamic) with a management panel
- Jump host chains; proxy support
- Themes + scheme import, font settings, paste protection, scrollback search,
  session logging
- Win11 polish: Mica, single instance, jump list, portable mode
- Auto-update, code signing, installer (NSIS/MSI via Tauri bundler)

### Phase 6 — Files (extended capability)
- `wr-sftp`: browse, upload/download with progress, rename/delete/chmod, SCP fallback
- Remote file editing: open remote file in an editor pane (Monaco), save-on-write
  back through SFTP; conflict detection via mtime
- Optional dual-pane file manager view (r-shell has a reference implementation)

---

## 5. Risks & watch items

- **Terminal throughput over IPC** — JSON-per-chunk will feel laggy under
  `cat largefile`; use Tauri raw channels/binary payloads from day one (Phase 0
  proves this deliberately).
- **russh coverage** — verify agent-forwarding, ProxyJump, and rekey behavior
  early; pin the version and track upstream (r-shell pins 0.44; newer exists).
- **WebView2 quirks** — WebGL context loss on GPU driver resets; xterm's webgl
  addon falls back to canvas — make sure the fallback path is tested.
- **`.ppk` support** — PuTTY v3 key format needs Argon2 KDF handling; scope it
  as "import/convert" not "native support" if it drags.
- **SmartScreen** — plan for code signing before any public release.
