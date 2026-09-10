//! One-time import of PuTTY's saved session list.
//!
//! The app already reads `.ppk` keys and talks to Pageant, so a PuTTY user's
//! *credentials* carry over. What doesn't is everything else they have: the
//! session list itself. Someone with forty saved sessions will not retype them,
//! and for a tool whose pitch is "replace PuTTY" that is the whole adoption
//! question — the migration path matters more than any single feature.
//!
//! PuTTY keeps sessions at `HKCU\Software\SimonTatham\PuTTY\Sessions`, one
//! subkey per session, with the subkey name URL-escaped and the settings as
//! `REG_SZ`/`REG_DWORD` values. KiTTY, a common fork, either uses the same path
//! or a portable `Sessions/` directory; the registry half is covered here and
//! the same mapping would serve the portable one.
//!
//! The split in this file is deliberate: [`to_profile`] and [`decode_name`] are
//! pure functions over a plain map, and every test exercises them directly. The
//! registry read is the only `cfg(windows)` part, and it does nothing but fill
//! that map — so the mapping, which is where the actual decisions live, stays
//! testable on a Linux CI runner.
//!
//! Read-only. Nothing here writes to PuTTY's keys, and an import never removes
//! or overwrites an existing wRusTTY profile — see [`import_into`].

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::AppHandle;

use crate::profiles::SessionProfile;
use crate::session_import::{merge_into, next_id, ImportSummary};

/// Where PuTTY and its forks keep saved sessions, under `HKEY_CURRENT_USER`.
///
/// Gated, unlike the rest of this module: it is read by `read_sessions` and
/// nothing else, so off Windows there is no registry to name and no test that
/// needs the string.
#[cfg(windows)]
const PUTTY_SESSIONS_KEY: &str = r"Software\SimonTatham\PuTTY\Sessions";

/// A registry value, in the two shapes PuTTY actually stores.
///
/// Only `read_sessions` and the tests build one — the accessors below just
/// match — so off Windows a non-test build sees the variants constructed
/// nowhere. They are still wanted there: the mapping they feed is the part
/// this module keeps testable on a Linux runner, which is the whole reason it
/// is split this way.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Str(String),
    Dword(u32),
}

impl Value {
    fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            Value::Dword(_) => None,
        }
    }

    fn as_u32(&self) -> Option<u32> {
        match self {
            Value::Dword(n) => Some(*n),
            // PuTTY is consistent about types, but a fork or a hand-edited
            // `.reg` file needn't be, so a numeric string is accepted too.
            Value::Str(s) => s.parse().ok(),
        }
    }
}

/// One saved session as it sits in the registry, before any interpretation.
#[derive(Debug, Clone)]
pub struct PuttySession {
    /// Already decoded — see [`decode_name`].
    pub name: String,
    pub values: HashMap<String, Value>,
}

impl PuttySession {
    fn string(&self, key: &str) -> Option<&str> {
        self.values
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    }

    fn number(&self, key: &str) -> Option<u32> {
        self.values.get(key).and_then(Value::as_u32)
    }
}

/// Undoes PuTTY's `mungestr` escaping of a session name.
///
/// PuTTY percent-escapes anything it can't put in a registry key name, so
/// "Router / Rack 3" is stored as `Router%20%2F%20Rack%203`. Showing a user
/// their session list with the escapes still in it would make the import look
/// broken at exactly the moment it needs to look trustworthy.
///
/// A malformed escape is passed through as literal text rather than dropped: a
/// name is cosmetic, and mangling one is a better outcome than refusing to
/// import the session it belongs to.
///
/// Called by `read_sessions` and by the tests, so off Windows a non-test build
/// has no caller — see the note on [`Value`].
#[cfg_attr(not(windows), allow(dead_code))]
pub fn decode_name(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Turns one PuTTY session into a `SessionProfile`, or `None` if it isn't
/// something this app can open.
///
/// Returns `None` for:
///
/// - **No `HostName`.** PuTTY stores a "Default Settings" pseudo-session that
///   holds preferences and no host; importing it would create a profile that
///   connects to nothing.
/// - **`raw`, `rlogin`, `supdup`.** Not transports this app speaks. Skipping is
///   the honest outcome — a raw session silently imported as telnet would look
///   like it worked and then behave subtly differently.
///
/// Serial sessions *are* imported — see [`to_serial_profile`] — since PuTTY's
/// `SerialLine`/`SerialSpeed`/... values map nearly one-for-one onto
/// `SerialProfile`.
pub fn to_profile(session: &PuttySession, id: String) -> Option<SessionProfile> {
    // PuTTY writes the protocol as a lowercase name. Absent means SSH, which
    // is both PuTTY's own default and overwhelmingly what a saved session is.
    let protocol = match session.string("Protocol").unwrap_or("ssh") {
        "ssh" => "ssh",
        "telnet" => "telnet",
        "serial" => return to_serial_profile(session, id),
        _ => return None,
    };

    let host = session.string("HostName")?.trim().to_string();
    if host.is_empty() {
        return None;
    }

    // PortNumber is authoritative when present — someone with a session on
    // 2222 needs that far more than they need our default.
    let port = session
        .number("PortNumber")
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .unwrap_or(if protocol == "ssh" { 22 } else { 23 });

    let username = session.string("UserName").unwrap_or_default().to_string();
    let key_path = session.string("PublicKeyFile").map(str::to_string);

    // Inferred from what the session actually has, since PuTTY has no single
    // "auth type" value. A key file means key auth; otherwise agent, which is
    // the right default for a PuTTY user (they already run Pageant) and the
    // only other option that needs no stored secret. Never "password": the
    // password isn't in the registry to import, so claiming password auth
    // would produce a profile that fails at connect time.
    let auth_type = if protocol == "ssh" {
        if key_path.is_some() {
            "public_key"
        } else {
            "agent"
        }
    } else {
        ""
    };

    Some(SessionProfile {
        id,
        label: session.name.clone(),
        // Everything lands in one folder rather than loose among existing
        // sessions: forty new entries appearing unsorted in someone's list is
        // its own kind of damage, and a folder is trivially undone.
        folder: Some("Imported from PuTTY".to_string()),
        host,
        port,
        protocol: protocol.to_string(),
        username,
        auth_type: auth_type.to_string(),
        key_path,
        has_credential: false,
        jump_profile_id: None,
        // PuTTY's default is `xterm`, and it stores the value whether or not
        // the user changed it — carried across because someone who did change
        // it usually had a reason involving a specific box.
        term_type: session.string("TerminalType").map(str::to_string),
        backspace_sends_ctrl_h: None,
        // PuTTY splits its keepalive across two values — whole minutes in
        // `PingInterval` and the remainder in `PingIntervalSecs` — and its
        // Connection panel writes both. Someone who set this in PuTTY did so
        // because a firewall on the path to *that host* was dropping their
        // session, which is exactly the thing worth carrying over.
        keepalive_seconds: keepalive_seconds(session),
        // PuTTY has no Wake-on-LAN setting to carry across — waking is
        // something its users do with a separate tool.
        wake_on_lan: None,
        // PuTTY has no equivalent setting, so an import follows the global one.
        auto_reconnect: None,
        // An import says nothing about whether this host's shell history may be
        // read; that is the user's call, made per host or globally.
        import_remote_history: None,
        serial: None,
        local: None,
    })
}

/// PuTTY's `PingInterval` (minutes) + `PingIntervalSecs` (seconds), or `None`
/// when neither is set.
///
/// `Some(0)` — both present and zero — is meaningful and preserved: it is how
/// PuTTY records "keepalives off", and this app reads it the same way.
fn keepalive_seconds(session: &PuttySession) -> Option<u64> {
    let minutes = session.number("PingInterval");
    let seconds = session.number("PingIntervalSecs");
    if minutes.is_none() && seconds.is_none() {
        return None;
    }
    Some(u64::from(minutes.unwrap_or(0)) * 60 + u64::from(seconds.unwrap_or(0)))
}

/// Maps PuTTY's serial settings onto a `SerialProfile`.
///
/// The identity records only the COM name PuTTY had — PuTTY stores no USB
/// VID/PID, because it never resolved a port by anything else. That means an
/// imported serial session starts out with exactly PuTTY's own behaviour
/// (find `COM4`, fail if it moved), and gains the stable-across-replug
/// behaviour once the user re-picks the adapter in the connect form, which
/// records its USB identity. Inventing an identity here would be worse: it
/// would have to guess which attached adapter the session meant.
fn to_serial_profile(session: &PuttySession, id: String) -> Option<SessionProfile> {
    let port_name = session.string("SerialLine")?.trim().to_string();
    if port_name.is_empty() {
        return None;
    }

    Some(SessionProfile {
        id,
        label: session.name.clone(),
        folder: Some("Imported from PuTTY".to_string()),
        // Unused for serial, but the field isn't optional. The port name is
        // the closest thing to "where this connects", and showing it beats
        // showing nothing in any UI that reads `host` generically.
        host: port_name.clone(),
        port: 0,
        protocol: "serial".to_string(),
        username: String::new(),
        auth_type: String::new(),
        key_path: None,
        has_credential: false,
        jump_profile_id: None,
        term_type: None,
        backspace_sends_ctrl_h: None,
        // Serial has no keepalive concept — there is no idle timeout on a wire.
        keepalive_seconds: None,
        // Nor anything to wake: the adapter is on the end of a cable.
        wake_on_lan: None,
        // PuTTY has no equivalent setting, so an import follows the global one.
        auto_reconnect: None,
        // An import says nothing about whether this host's shell history may be
        // read; that is the user's call, made per host or globally.
        import_remote_history: None,
        serial: Some(crate::profiles::SerialProfile {
            identity: wr_serial::PortIdentity {
                port_name,
                usb: None,
            },
            baud_rate: session.number("SerialSpeed").unwrap_or(9600),
            data_bits: match session.number("SerialDataBits") {
                Some(5) => wr_serial::DataBits::Five,
                Some(6) => wr_serial::DataBits::Six,
                Some(7) => wr_serial::DataBits::Seven,
                _ => wr_serial::DataBits::Eight,
            },
            // PuTTY: 0 none, 1 odd, 2 even, 3 mark, 4 space. Mark and space
            // have no representation here, so they fall back to none — the
            // setting is visible and editable after import, and refusing the
            // whole session over a parity mode almost nobody uses would be a
            // much worse trade.
            parity: match session.number("SerialParity") {
                Some(1) => wr_serial::Parity::Odd,
                Some(2) => wr_serial::Parity::Even,
                _ => wr_serial::Parity::None,
            },
            // Counted in *half* bits: 2 = one stop bit, 4 = two. 3 (1.5) is
            // only meaningful with 5 data bits and has no equivalent here.
            stop_bits: match session.number("SerialStopHalfbits") {
                Some(4) => wr_serial::StopBits::Two,
                _ => wr_serial::StopBits::One,
            },
            // PuTTY: 0 none, 1 XON/XOFF, 2 RTS/CTS, 3 DSR/DTR. DSR/DTR maps to
            // hardware, which is the closer of the two available.
            flow_control: match session.number("SerialFlowControl") {
                Some(1) => wr_serial::FlowControl::Software,
                Some(2) | Some(3) => wr_serial::FlowControl::Hardware,
                _ => wr_serial::FlowControl::None,
            },
            local_echo: false,
            line_ending: wr_serial::LineEnding::Cr,
            input_mode: None,
        }),
        local: None,
    })
}

/// Reads PuTTY's sessions and appends the ones that are new.
///
/// The read-modify-write half, run under the profile lock by the command
/// below — `next_id` and the duplicate check both depend on the list not
/// changing underneath them, and the write would otherwise clobber a rename
/// saved from the session browser in between. The appending itself is
/// [`merge_into`], shared with the SSH-config importer.
fn import_into(sessions: &[PuttySession], path: &PathBuf) -> Result<ImportSummary, String> {
    let mut existing = crate::profiles::read_profiles(path)?;

    // Ids are minted against a growing list so that two PuTTY sessions in the
    // same run can't be handed the same one.
    let mut minted = existing.clone();
    let mut candidates = Vec::new();
    let mut skipped_unsupported = 0;
    for session in sessions {
        let id = next_id(&minted, "putty");
        let Some(profile) = to_profile(session, id) else {
            skipped_unsupported += 1;
            continue;
        };
        minted.push(profile.clone());
        candidates.push(profile);
    }

    let mut summary = merge_into(&mut existing, candidates);
    summary.skipped_unsupported = skipped_unsupported;

    if summary.imported > 0 {
        crate::profiles::write_profiles(path, &existing)?;
    }
    Ok(summary)
}

/// How many PuTTY sessions this app could actually open, so the UI can offer
/// the action only when it would do something — and say how much it would do.
///
/// Counts what would import, not what exists: someone whose only PuTTY entry
/// is the hostless "Default Settings" pseudo-session should be offered nothing,
/// not an import that turns out to add zero profiles.
///
/// A registry read failure counts as zero rather than propagating. This runs to
/// decide whether to *show* a button; a machine that has never had PuTTY is the
/// common case, and it must not produce an error on screen.
pub fn importable_count() -> usize {
    read_sessions()
        .map(|sessions| {
            sessions
                .iter()
                .filter(|s| to_profile(s, String::new()).is_some())
                .count()
        })
        .unwrap_or(0)
}

#[cfg(windows)]
fn read_sessions() -> Result<Vec<PuttySession>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, REG_DWORD, REG_EXPAND_SZ, REG_SZ,
    };

    /// A `HKEY` that closes itself. The enumeration below has several early
    /// returns and a nested key per session; a manual `RegCloseKey` on each
    /// path is exactly the kind of thing that gets missed on one of them.
    struct OwnedKey(HKEY);
    impl Drop for OwnedKey {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Trims the trailing NUL(s) the registry includes in a string value's
    /// byte count and decodes. `REG_SZ` data is not required to be
    /// NUL-terminated at all, so this handles both.
    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn open(parent: HKEY, path: &str) -> Option<OwnedKey> {
        let mut key = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                parent,
                PCWSTR(wide(path).as_ptr()),
                Some(0),
                KEY_READ,
                &mut key,
            )
        };
        (status == ERROR_SUCCESS).then_some(OwnedKey(key))
    }

    // A missing key is the ordinary case — most users don't have PuTTY — so it
    // is an empty list, not an error. An error here would surface as a failure
    // dialog on a machine that simply never had PuTTY installed.
    let Some(sessions_key) = open(HKEY_CURRENT_USER, PUTTY_SESSIONS_KEY) else {
        return Ok(Vec::new());
    };

    let mut sessions = Vec::new();
    let mut index = 0u32;
    loop {
        // 256 is the documented maximum length of a registry key name.
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                sessions_key.0,
                index,
                Some(windows::core::PWSTR(name_buf.as_mut_ptr())),
                &mut name_len,
                None,
                None,
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            // One unreadable session shouldn't abandon the rest — a partial
            // import the user can see is better than an error that imports
            // nothing.
            index += 1;
            continue;
        }
        index += 1;

        let raw_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let Some(session_key) = open(sessions_key.0, &raw_name) else {
            continue;
        };

        let mut values = HashMap::new();
        let mut value_index = 0u32;
        loop {
            // 16,383 is the maximum value-name length; the data buffer is
            // generous because `PublicKeyFile` holds a full path.
            let mut value_name = [0u16; 512];
            let mut value_name_len = value_name.len() as u32;
            let mut kind = REG_SZ;
            let mut data = [0u8; 2048];
            let mut data_len = data.len() as u32;
            let status = unsafe {
                RegEnumValueW(
                    session_key.0,
                    value_index,
                    Some(windows::core::PWSTR(value_name.as_mut_ptr())),
                    &mut value_name_len,
                    None,
                    Some(&mut kind.0),
                    Some(data.as_mut_ptr()),
                    Some(&mut data_len),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            value_index += 1;
            if status != ERROR_SUCCESS {
                continue;
            }

            let name = String::from_utf16_lossy(&value_name[..value_name_len as usize]);
            let parsed = if kind == REG_SZ || kind == REG_EXPAND_SZ {
                let wide_data: Vec<u16> = data[..data_len as usize]
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                Some(Value::Str(from_wide(&wide_data)))
            } else if kind == REG_DWORD && data_len >= 4 {
                Some(Value::Dword(u32::from_le_bytes([
                    data[0], data[1], data[2], data[3],
                ])))
            } else {
                None
            };
            if let Some(value) = parsed {
                values.insert(name, value);
            }
        }

        sessions.push(PuttySession {
            name: decode_name(&raw_name),
            values,
        });
    }

    Ok(sessions)
}

/// PuTTY's session list is a Windows registry key, so there is nothing to read
/// anywhere else. The command still exists on other platforms — it is simpler
/// for the frontend to call it and get an empty result than to branch on the
/// platform before deciding whether it may ask.
#[cfg(not(windows))]
fn read_sessions() -> Result<Vec<PuttySession>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn putty_sessions_available() -> Result<usize, String> {
    Ok(importable_count())
}

#[tauri::command]
pub async fn putty_import_sessions(
    app: AppHandle,
    profile_state: tauri::State<'_, crate::profiles::ProfileState>,
) -> Result<ImportSummary, String> {
    // Reading PuTTY's own registry hive stays outside the lock: it touches
    // nothing this app writes, and it is the slow half.
    let sessions = read_sessions()?;
    profile_state
        .with_profiles(&app, |path| import_into(&sessions, path))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(name: &str, pairs: &[(&str, Value)]) -> PuttySession {
        PuttySession {
            name: name.to_string(),
            values: pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
        }
    }

    fn str_value(s: &str) -> Value {
        Value::Str(s.to_string())
    }

    #[test]
    fn decodes_an_escaped_session_name() {
        assert_eq!(decode_name("Router%20%2F%20Rack%203"), "Router / Rack 3");
        assert_eq!(decode_name("plain-name"), "plain-name");
    }

    /// A name is cosmetic; refusing to import a session because its name was
    /// oddly escaped would be a much worse trade.
    #[test]
    fn a_malformed_escape_passes_through_rather_than_failing() {
        assert_eq!(decode_name("100%"), "100%");
        assert_eq!(decode_name("50%zz off"), "50%zz off");
    }

    #[test]
    fn maps_a_key_authenticated_ssh_session() {
        let s = session(
            "prod-web",
            &[
                ("HostName", str_value("10.0.0.5")),
                ("PortNumber", Value::Dword(2222)),
                ("UserName", str_value("deploy")),
                ("Protocol", str_value("ssh")),
                ("PublicKeyFile", str_value(r"C:\keys\prod.ppk")),
            ],
        );
        let p = to_profile(&s, "id-1".into()).expect("should import");

        assert_eq!(p.host, "10.0.0.5");
        assert_eq!(p.port, 2222);
        assert_eq!(p.username, "deploy");
        assert_eq!(p.protocol, "ssh");
        assert_eq!(p.auth_type, "public_key");
        assert_eq!(p.key_path.as_deref(), Some(r"C:\keys\prod.ppk"));
        assert_eq!(p.label, "prod-web");
        assert!(!p.has_credential);
    }

    /// A PuTTY user already runs Pageant, so agent is the right guess — and
    /// crucially not "password", which would produce a profile that fails at
    /// connect time for a secret that was never in the registry to import.
    #[test]
    fn an_ssh_session_without_a_key_file_defaults_to_agent_auth() {
        let s = session("router", &[("HostName", str_value("192.168.1.1"))]);
        let p = to_profile(&s, "id-1".into()).unwrap();
        assert_eq!(p.auth_type, "agent");
        assert_eq!(p.protocol, "ssh", "a missing Protocol means ssh");
        assert_eq!(p.port, 22);
    }

    #[test]
    fn telnet_sessions_get_the_telnet_default_port_and_no_auth() {
        let s = session(
            "console",
            &[
                ("HostName", str_value("ts.example.net")),
                ("Protocol", str_value("telnet")),
            ],
        );
        let p = to_profile(&s, "id-1".into()).unwrap();
        assert_eq!(p.protocol, "telnet");
        assert_eq!(p.port, 23);
        assert_eq!(p.auth_type, "");
    }

    /// PuTTY keeps a hostless "Default Settings" pseudo-session holding
    /// preferences. Importing it would create a profile that connects nowhere.
    #[test]
    fn a_session_with_no_host_is_skipped() {
        let s = session(
            "Default%20Settings",
            &[
                ("Protocol", str_value("ssh")),
                ("PortNumber", Value::Dword(22)),
            ],
        );
        assert!(to_profile(&s, "id-1".into()).is_none());
    }

    /// Silently importing a raw session as telnet would look like it worked
    /// and then behave differently on the wire.
    #[test]
    fn transports_this_app_does_not_speak_are_skipped() {
        for protocol in ["raw", "rlogin", "supdup"] {
            let s = session(
                "other",
                &[
                    ("HostName", str_value("example.net")),
                    ("Protocol", str_value(protocol)),
                ],
            );
            assert!(
                to_profile(&s, "id-1".into()).is_none(),
                "{protocol} should not import as something else"
            );
        }
    }

    /// A zero port is what an incompletely written session leaves behind;
    /// importing it verbatim produces a profile that cannot connect.
    #[test]
    fn a_zero_or_oversized_port_falls_back_to_the_protocol_default() {
        for stored in [Value::Dword(0), Value::Dword(70000)] {
            let s = session(
                "odd",
                &[("HostName", str_value("h")), ("PortNumber", stored)],
            );
            assert_eq!(to_profile(&s, "id-1".into()).unwrap().port, 22);
        }
    }

    /// The console-cable half of the migration. PuTTY's stop bits are counted
    /// in half-bits and its parity/flow-control are small integers, so this
    /// pins the mapping rather than trusting it.
    #[test]
    fn maps_a_serial_session_including_its_line_settings() {
        let s = session(
            "switch-rack-3",
            &[
                ("Protocol", str_value("serial")),
                ("SerialLine", str_value("COM4")),
                ("SerialSpeed", Value::Dword(115200)),
                ("SerialDataBits", Value::Dword(7)),
                ("SerialParity", Value::Dword(2)),
                ("SerialStopHalfbits", Value::Dword(4)),
                ("SerialFlowControl", Value::Dword(2)),
            ],
        );
        let p = to_profile(&s, "id-1".into()).expect("serial sessions import");
        assert_eq!(p.protocol, "serial");
        let serial = p.serial.expect("should carry serial settings");
        assert_eq!(serial.identity.port_name, "COM4");
        assert_eq!(serial.baud_rate, 115200);
        assert!(matches!(serial.data_bits, wr_serial::DataBits::Seven));
        assert!(matches!(serial.parity, wr_serial::Parity::Even));
        assert!(matches!(serial.stop_bits, wr_serial::StopBits::Two));
        assert!(matches!(
            serial.flow_control,
            wr_serial::FlowControl::Hardware
        ));
        // PuTTY never recorded a USB identity, so an imported session behaves
        // exactly as it did in PuTTY until the user re-picks the adapter.
        assert!(serial.identity.usb.is_none());
    }

    /// A serial session with no line is as unusable as an SSH one with no host.
    #[test]
    fn a_serial_session_with_no_line_is_skipped() {
        let s = session(
            "incomplete",
            &[
                ("Protocol", str_value("serial")),
                ("SerialSpeed", Value::Dword(9600)),
            ],
        );
        assert!(to_profile(&s, "id-1".into()).is_none());
    }

    /// Defaults have to be sane for the many sessions that store only a line.
    #[test]
    fn a_minimal_serial_session_gets_conventional_defaults() {
        let s = session(
            "console",
            &[
                ("Protocol", str_value("serial")),
                ("SerialLine", str_value("COM1")),
            ],
        );
        let serial = to_profile(&s, "id-1".into()).unwrap().serial.unwrap();
        assert_eq!(serial.baud_rate, 9600);
        assert!(matches!(serial.data_bits, wr_serial::DataBits::Eight));
        assert!(matches!(serial.parity, wr_serial::Parity::None));
        assert!(matches!(serial.stop_bits, wr_serial::StopBits::One));
        assert!(matches!(serial.flow_control, wr_serial::FlowControl::None));
    }

    /// Someone who set a keepalive in PuTTY did it because a firewall on the
    /// path to that host kept dropping their session. Losing it on import
    /// means the migration reintroduces the exact problem they had solved.
    #[test]
    fn carries_puttys_split_keepalive_across() {
        let s = session(
            "behind-nat",
            &[
                ("HostName", str_value("h")),
                ("PingInterval", Value::Dword(2)),
                ("PingIntervalSecs", Value::Dword(30)),
            ],
        );
        assert_eq!(
            to_profile(&s, "id-1".into()).unwrap().keepalive_seconds,
            Some(150)
        );
    }

    /// PuTTY writes 0/0 for "keepalives off", which is a real choice — some
    /// devices respond badly to them — and not the same as "unset".
    #[test]
    fn an_explicit_zero_keepalive_is_preserved_not_treated_as_unset() {
        let s = session(
            "fussy-device",
            &[
                ("HostName", str_value("h")),
                ("PingInterval", Value::Dword(0)),
                ("PingIntervalSecs", Value::Dword(0)),
            ],
        );
        assert_eq!(
            to_profile(&s, "id-1".into()).unwrap().keepalive_seconds,
            Some(0)
        );
    }

    #[test]
    fn a_session_with_no_keepalive_values_gets_the_app_default() {
        let s = session("plain", &[("HostName", str_value("h"))]);
        assert_eq!(
            to_profile(&s, "id-1".into()).unwrap().keepalive_seconds,
            None
        );
    }

    #[test]
    fn imported_profiles_are_foldered_rather_than_loose() {
        let s = session("h", &[("HostName", str_value("h"))]);
        assert_eq!(
            to_profile(&s, "id-1".into()).unwrap().folder.as_deref(),
            Some("Imported from PuTTY")
        );
    }
}
