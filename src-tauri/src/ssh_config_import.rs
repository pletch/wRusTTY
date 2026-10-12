//! One-time import of OpenSSH's `~/.ssh/config`, the counterpart to
//! [`crate::putty_import`] for people whose session list is a config file.
//!
//! Only connection-shape keywords are read (`HostName`, `Port`, `User`,
//! `IdentityFile`, `ProxyJump`, `ServerAliveInterval`); everything else is
//! ignored rather than half-translated. Read-only: nothing writes to `~/.ssh`,
//! and an import never removes or overwrites an existing profile.
//!
//! As in `putty_import`, [`parse_config`] and [`to_profiles`] are pure over
//! text; only [`read_config_text`] touches the filesystem.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::profiles::SessionProfile;
use crate::session_import::{merge_into, next_id, ImportSummary};

/// Where imported sessions land, so they don't mix unsorted with the user's
/// own.
const IMPORT_FOLDER: &str = "Imported from SSH config";

/// `Include` nesting limit (OpenSSH's is 16); guards against a file that
/// includes itself.
const MAX_INCLUDE_DEPTH: usize = 8;

/// One `Host` block, reduced to the keywords this app can act on. `Host web1
/// web2` produces one entry per alias with the same settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEntry {
    /// The alias as written: what the user types after `ssh`.
    pub alias: String,
    /// `HostName` when set; `None` means the alias is the hostname.
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    /// The raw value (`bastion`, `me@jump:2222`, or a chain), resolved against
    /// the session list in [`to_profiles`].
    pub proxy_jump: Option<String>,
    pub server_alive_interval: Option<u64>,
}

impl HostEntry {
    fn new(alias: String) -> Self {
        Self {
            alias,
            hostname: None,
            port: None,
            user: None,
            identity_file: None,
            proxy_jump: None,
            server_alive_interval: None,
        }
    }
}

/// Splits a config line into keyword and value. Accepts `Port 2222`,
/// `Port=2222` and `Port = 2222`, and quoted values. `None` for a comment or
/// blank line.
fn split_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let split_at = line.find([' ', '\t', '='])?;
    let (keyword, rest) = line.split_at(split_at);
    // Only one `=` is a separator; a second belongs to the value.
    let value = rest.trim_start_matches([' ', '\t']);
    let value = value.strip_prefix('=').unwrap_or(value).trim();
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    if value.is_empty() {
        return None;
    }
    Some((keyword.to_ascii_lowercase(), value.to_string()))
}

/// A `Host` pattern naming exactly one host. `Host *`, `*.internal` and
/// `!prod` are rules about connecting, not hosts.
fn is_literal_alias(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains(['*', '?', '!'])
}

/// Reads the `Host` blocks out of an assembled config.
///
/// First value wins per keyword per block (OpenSSH's rule, which makes a
/// trailing `Host *` block harmless). `Match` blocks are skipped: their
/// settings are conditional, and they mustn't leak into the block above.
pub fn parse_config(text: &str) -> Vec<HostEntry> {
    let mut entries: Vec<HostEntry> = Vec::new();
    // Indices into `entries` for the block's aliases (`Host web1 web2` sets both).
    let mut current: Vec<usize> = Vec::new();

    for line in text.lines() {
        let Some((keyword, value)) = split_line(line) else {
            continue;
        };

        match keyword.as_str() {
            "host" => {
                current.clear();
                for pattern in value.split_whitespace() {
                    if !is_literal_alias(pattern) {
                        continue;
                    }
                    // A repeated alias continues the earlier block rather than starting a
                    // second profile with the same name.
                    match entries.iter().position(|e| e.alias == pattern) {
                        Some(index) => current.push(index),
                        None => {
                            entries.push(HostEntry::new(pattern.to_string()));
                            current.push(entries.len() - 1);
                        }
                    }
                }
            }
            // Conditional settings, with nowhere to go in a session list.
            "match" => current.clear(),
            _ => {
                for &index in &current {
                    let entry = &mut entries[index];
                    match keyword.as_str() {
                        "hostname" => set_once(&mut entry.hostname, || Some(value.clone())),
                        "port" => set_once(&mut entry.port, || value.parse().ok()),
                        "user" => set_once(&mut entry.user, || Some(value.clone())),
                        // OpenSSH tries several in order; this app takes one, so the first.
                        "identityfile" => {
                            set_once(&mut entry.identity_file, || Some(value.clone()))
                        }
                        "proxyjump" => set_once(&mut entry.proxy_jump, || Some(value.clone())),
                        "serveraliveinterval" => {
                            set_once(&mut entry.server_alive_interval, || value.parse().ok())
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    entries
}

/// OpenSSH's first-value-wins rule. An unparseable value (`Port banana`) is
/// treated as absent rather than dropping the host.
fn set_once<T>(slot: &mut Option<T>, value: impl FnOnce() -> Option<T>) {
    if slot.is_none() {
        *slot = value();
    }
}

/// The alias of a `ProxyJump` value's first hop. The value is a chain
/// (`edge,bastion`) of `[user@]host[:port]` hops; `jump_profile_id` names one
/// profile, and the first hop is the one made from here.
fn jump_alias(value: &str) -> Option<&str> {
    let first = value.split(',').next()?.trim();
    if first.is_empty() || first.eq_ignore_ascii_case("none") {
        return None;
    }
    let without_user = first.rsplit('@').next().unwrap_or(first);
    // `host:port`, but not an IPv6 literal.
    let host = match without_user.rsplit_once(':') {
        Some((host, _)) if !host.contains(':') => host,
        _ => without_user,
    };
    (!host.is_empty()).then_some(host)
}

/// Turns parsed `Host` blocks into profiles, ids and jumps included.
/// `existing` is read (not modified) to mint unique ids and resolve
/// `ProxyJump` against saved sessions.
pub fn to_profiles(entries: &[HostEntry], existing: &[SessionProfile]) -> Vec<SessionProfile> {
    // Two passes: ids must exist before jumps can be linked.
    let mut minted = existing.to_vec();
    let mut profiles: Vec<SessionProfile> = Vec::new();
    for entry in entries {
        let id = next_id(&minted, "sshcfg");
        let profile = to_profile(entry, id);
        minted.push(profile.clone());
        profiles.push(profile);
    }

    // New profiles are added second, so within one import `ProxyJump bastion`
    // means the `bastion` in this file.
    let mut by_label: HashMap<&str, &str> = HashMap::new();
    for p in existing {
        by_label.insert(p.label.as_str(), p.id.as_str());
    }
    for p in &profiles {
        by_label.insert(p.label.as_str(), p.id.as_str());
    }

    let jumps: Vec<Option<String>> = entries
        .iter()
        .map(|entry| {
            let alias = jump_alias(entry.proxy_jump.as_deref()?)?;
            // An unresolvable jump is dropped rather than invented; a dangling
            // `jumpProfileId` would fail at connect time.
            by_label.get(alias).map(|id| (*id).to_string())
        })
        .collect();
    for (profile, jump) in profiles.iter_mut().zip(jumps) {
        // Never itself (an inherited `Host *` `ProxyJump` can do this).
        if jump.as_deref() == Some(profile.id.as_str()) {
            continue;
        }
        profile.jump_profile_id = jump;
    }

    profiles
}

fn to_profile(entry: &HostEntry, id: String) -> SessionProfile {
    SessionProfile {
        id,
        label: entry.alias.clone(),
        folder: Some(IMPORT_FOLDER.to_string()),
        // A bare `Host build-box` block: the alias is the hostname.
        host: entry
            .hostname
            .clone()
            .unwrap_or_else(|| entry.alias.clone()),
        port: entry.port.filter(|p| *p != 0).unwrap_or(22),
        protocol: "ssh".to_string(),
        username: entry.user.clone().unwrap_or_default(),
        // As in the PuTTY importer: a named key means key auth, otherwise agent
        // (what `ssh` does by default). Never password; there's none to import.
        auth_type: if entry.identity_file.is_some() {
            "public_key".to_string()
        } else {
            "agent".to_string()
        },
        // Left as written: the tilde is expanded at connect time
        // (`wr_ssh::expand_tilde`).
        key_path: entry.identity_file.clone(),
        has_credential: false,
        jump_profile_id: None,
        // `SetEnv TERM=` is rare and conditional; not imported.
        term_type: None,
        backspace_sends_ctrl_h: None,
        // `ServerAliveInterval` maps exactly, `0` (off) included.
        keepalive_seconds: entry.server_alive_interval,
        // Nothing in an SSH config describes waking a machine.
        wake_on_lan: None,
        // No equivalent setting, so an import follows the global one.
        auto_reconnect: None,
        // Whether history may be read is the user's call.
        import_remote_history: None,
        use_proxy: None,
        log_session: None,
        serial: None,
        local: None,
    }
}

/// The config file with every `Include` spliced in where it appeared, as
/// OpenSSH does: an included file can continue a `Host` block started in the
/// parent.
fn read_config_text(path: &Path, depth: usize) -> String {
    if depth > MAX_INCLUDE_DEPTH {
        return String::new();
    }
    // A missing config is ordinary (never ran `ssh`), not an error.
    let Ok(contents) = std::fs::read_to_string(path) else {
        return String::new();
    };

    let mut out = String::with_capacity(contents.len());
    for line in contents.lines() {
        match split_line(line) {
            Some((keyword, value)) if keyword == "include" => {
                for pattern in value.split_whitespace() {
                    for included in resolve_include(pattern, path) {
                        out.push_str(&read_config_text(&included, depth + 1));
                        out.push('\n');
                    }
                }
            }
            _ => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out
}

/// The files one `Include` pattern names. Relative paths are relative to
/// `~/.ssh` (OpenSSH's rule for a user config). Only the final component may
/// contain a wildcard (`Include config.d/*`), which avoids a directory walker.
fn resolve_include(pattern: &str, parent: &Path) -> Vec<PathBuf> {
    let expanded = wr_ssh::expand_tilde(pattern);
    let base = if expanded.is_absolute() {
        expanded
    } else {
        parent
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(expanded)
    };

    let Some(name) = base.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![base];
    }

    let dir = base.parent().unwrap_or_else(|| Path::new("."));
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut matches: Vec<PathBuf> = read
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|candidate| glob_matches(name, candidate))
        })
        .map(|e| e.path())
        .collect();
    // Directory order is undefined; keep the import deterministic.
    matches.sort();
    matches
}

/// `*` (any run, including empty) and `?` (exactly one), over one filename.
fn glob_matches(pattern: &str, candidate: &str) -> bool {
    let (p, c): (Vec<char>, Vec<char>) = (pattern.chars().collect(), candidate.chars().collect());
    // Backtracking on `*` only; filenames are short.
    let (mut pi, mut ci) = (0usize, 0usize);
    let (mut star, mut resume) = (None, 0usize);
    while ci < c.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == c[ci]) {
            pi += 1;
            ci += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            resume = ci;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            resume += 1;
            ci = resume;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&ch| ch == '*')
}

/// `~/.ssh/config`, or `None` when there is no home directory to look in.
fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config"))
}

fn read_entries() -> Vec<HostEntry> {
    match config_path() {
        Some(path) => parse_config(&read_config_text(&path, 0)),
        None => Vec::new(),
    }
}

/// How many sessions `~/.ssh/config` would contribute: literal `Host` aliases
/// only, so a config that's just `Host *` reports 0.
#[tauri::command]
pub async fn ssh_config_sessions_available() -> Result<usize, String> {
    Ok(read_entries().len())
}

#[tauri::command]
pub async fn ssh_config_import_sessions(
    app: AppHandle,
    profile_state: tauri::State<'_, crate::profiles::ProfileState>,
) -> Result<ImportSummary, String> {
    // Reading `~/.ssh` stays outside the lock: it's the slow half and touches
    // nothing this app writes.
    let entries = read_entries();
    profile_state
        .with_profiles(&app, |path| {
            let mut existing = crate::profiles::read_profiles(path)?;
            let candidates = to_profiles(&entries, &existing);
            let summary = merge_into(&mut existing, candidates);
            if summary.imported > 0 {
                crate::profiles::write_profiles(path, &existing)?;
            }
            Ok(summary)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry<'a>(entries: &'a [HostEntry], alias: &str) -> &'a HostEntry {
        entries
            .iter()
            .find(|e| e.alias == alias)
            .unwrap_or_else(|| panic!("no entry for {alias}"))
    }

    #[test]
    fn reads_the_keywords_a_session_is_made_of() {
        let entries = parse_config(
            r#"
            # a comment
            Host prod-web
                HostName 10.0.0.5
                Port 2222
                User deploy
                IdentityFile ~/.ssh/id_prod
                ServerAliveInterval 30
            "#,
        );
        let e = entry(&entries, "prod-web");
        assert_eq!(e.hostname.as_deref(), Some("10.0.0.5"));
        assert_eq!(e.port, Some(2222));
        assert_eq!(e.user.as_deref(), Some("deploy"));
        assert_eq!(e.identity_file.as_deref(), Some("~/.ssh/id_prod"));
        assert_eq!(e.server_alive_interval, Some(30));
    }

    /// `Key=value`, `Key = value`, and quoted values with spaces.
    #[test]
    fn accepts_openssh_s_separator_and_quoting_forms() {
        let entries =
            parse_config("Host a\n  Port=2222\n  User = bob\n  IdentityFile \"C:\\my keys\\id\"\n");
        let e = entry(&entries, "a");
        assert_eq!(e.port, Some(2222));
        assert_eq!(e.user.as_deref(), Some("bob"));
        assert_eq!(e.identity_file.as_deref(), Some(r"C:\my keys\id"));
    }

    #[test]
    fn keywords_are_case_insensitive() {
        let entries = parse_config("HOST a\n  hostname H\n  PORT 22\n");
        assert_eq!(entry(&entries, "a").hostname.as_deref(), Some("H"));
    }

    /// A block naming several aliases sets all of them.
    #[test]
    fn one_block_naming_several_aliases_becomes_several_sessions() {
        let entries = parse_config("Host web1 web2\n  User deploy\n  Port 2200\n");
        assert_eq!(entries.len(), 2);
        for alias in ["web1", "web2"] {
            let e = entry(&entries, alias);
            assert_eq!(e.user.as_deref(), Some("deploy"));
            assert_eq!(e.port, Some(2200));
        }
    }

    /// `Host *` is a rule about connecting, not a host.
    #[test]
    fn wildcard_and_negated_patterns_are_not_sessions() {
        let entries = parse_config(
            "Host *\n  User default\nHost *.internal\n  Port 2222\nHost !prod\n  User x\nHost real\n  HostName r\n",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "real");
    }

    /// First value wins, which makes a trailing `Host *` harmless.
    #[test]
    fn the_first_value_for_a_keyword_wins() {
        let entries = parse_config("Host a\n  Port 22\n  Port 2222\n");
        assert_eq!(entry(&entries, "a").port, Some(22));
    }

    /// A `Match` block's settings don't leak into the `Host` block above.
    #[test]
    fn match_block_settings_do_not_leak_into_the_previous_host() {
        let entries = parse_config("Host a\n  HostName real\nMatch host b\n  User sneaky\n");
        let e = entry(&entries, "a");
        assert_eq!(e.hostname.as_deref(), Some("real"));
        assert!(e.user.is_none());
    }

    /// One host's settings split across two blocks make one profile.
    #[test]
    fn a_repeated_alias_continues_the_same_session() {
        let entries = parse_config("Host a\n  HostName h\nHost b\n  User x\nHost a\n  Port 2222\n");
        assert_eq!(entries.len(), 2);
        let e = entry(&entries, "a");
        assert_eq!(e.hostname.as_deref(), Some("h"));
        assert_eq!(e.port, Some(2222));
    }

    /// A `Port banana` doesn't cost the user the host.
    #[test]
    fn an_unparseable_value_is_ignored_rather_than_losing_the_host() {
        let entries = parse_config("Host a\n  HostName h\n  Port banana\n");
        let e = entry(&entries, "a");
        assert_eq!(e.port, None);
        assert_eq!(e.hostname.as_deref(), Some("h"));
    }

    #[test]
    fn a_bare_host_block_uses_its_alias_as_the_hostname() {
        let profiles = to_profiles(&parse_config("Host build-box\n"), &[]);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].host, "build-box");
        assert_eq!(profiles[0].label, "build-box");
        assert_eq!(profiles[0].port, 22);
    }

    /// Never "password": there's no password in the file.
    #[test]
    fn auth_is_key_when_a_key_is_named_and_agent_otherwise() {
        let profiles = to_profiles(
            &parse_config("Host k\n  IdentityFile ~/.ssh/id_ed25519\nHost a\n"),
            &[],
        );
        let keyed = profiles.iter().find(|p| p.label == "k").unwrap();
        assert_eq!(keyed.auth_type, "public_key");
        // Left unexpanded.
        assert_eq!(keyed.key_path.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(
            profiles.iter().find(|p| p.label == "a").unwrap().auth_type,
            "agent"
        );
    }

    #[test]
    fn imported_profiles_are_foldered_rather_than_loose() {
        let profiles = to_profiles(&parse_config("Host a\n"), &[]);
        assert_eq!(profiles[0].folder.as_deref(), Some(IMPORT_FOLDER));
    }

    /// `ssh prod` going through the bastion carries over.
    #[test]
    fn proxy_jump_links_to_the_session_it_names() {
        let profiles = to_profiles(
            &parse_config(
                "Host bastion\n  HostName edge.example.net\nHost prod\n  ProxyJump bastion\n",
            ),
            &[],
        );
        let bastion = profiles.iter().find(|p| p.label == "bastion").unwrap();
        let prod = profiles.iter().find(|p| p.label == "prod").unwrap();
        assert_eq!(prod.jump_profile_id.as_deref(), Some(bastion.id.as_str()));
        // A jump named before its target is defined still resolves.
        let reversed = to_profiles(
            &parse_config("Host prod\n  ProxyJump bastion\nHost bastion\n"),
            &[],
        );
        assert!(reversed
            .iter()
            .find(|p| p.label == "prod")
            .unwrap()
            .jump_profile_id
            .is_some());
    }

    /// The hop's user and port live on its own profile; only the alias matters.
    #[test]
    fn a_jump_written_with_a_user_and_port_still_finds_its_session() {
        let profiles = to_profiles(
            &parse_config("Host jump\nHost prod\n  ProxyJump me@jump:2222\n"),
            &[],
        );
        let jump = profiles.iter().find(|p| p.label == "jump").unwrap();
        assert_eq!(
            profiles
                .iter()
                .find(|p| p.label == "prod")
                .unwrap()
                .jump_profile_id
                .as_deref(),
            Some(jump.id.as_str())
        );
    }

    /// Only the first hop of a chain.
    #[test]
    fn only_the_first_hop_of_a_chain_is_used() {
        assert_eq!(jump_alias("edge,bastion"), Some("edge"));
        assert_eq!(jump_alias("me@edge:2222"), Some("edge"));
        assert_eq!(jump_alias("none"), None);
        assert_eq!(jump_alias(""), None);
        // An IPv6 literal's colons are the address.
        assert_eq!(jump_alias("2001:db8::1"), Some("2001:db8::1"));
    }

    /// A jump to an unknown host is dropped, not left dangling.
    #[test]
    fn an_unresolvable_jump_is_dropped_rather_than_invented() {
        let profiles = to_profiles(&parse_config("Host prod\n  ProxyJump ghost\n"), &[]);
        assert!(profiles[0].jump_profile_id.is_none());
    }

    /// A profile never jumps through itself.
    #[test]
    fn a_session_is_never_linked_as_its_own_jump() {
        let profiles = to_profiles(&parse_config("Host bastion\n  ProxyJump bastion\n"), &[]);
        assert!(profiles[0].jump_profile_id.is_none());
    }

    /// Existing sessions are valid jump targets.
    #[test]
    fn a_jump_can_resolve_to_a_session_the_user_already_had() {
        let existing = vec![SessionProfile {
            id: "mine".into(),
            label: "bastion".into(),
            folder: None,
            host: "edge".into(),
            port: 22,
            protocol: "ssh".into(),
            username: String::new(),
            auth_type: "agent".into(),
            key_path: None,
            has_credential: false,
            jump_profile_id: None,
            term_type: None,
            backspace_sends_ctrl_h: None,
            keepalive_seconds: None,
            wake_on_lan: None,
            auto_reconnect: None,
            import_remote_history: None,
            use_proxy: None,
            log_session: None,
            serial: None,
            local: None,
        }];
        let profiles = to_profiles(&parse_config("Host prod\n  ProxyJump bastion\n"), &existing);
        assert_eq!(profiles[0].jump_profile_id.as_deref(), Some("mine"));
    }

    /// `ServerAliveInterval` maps to keepalive, `0` (off) included and distinct
    /// from unset.
    #[test]
    fn carries_the_keepalive_across_including_an_explicit_zero() {
        let profiles = to_profiles(
            &parse_config(
                "Host a\n  ServerAliveInterval 30\nHost b\n  ServerAliveInterval 0\nHost c\n",
            ),
            &[],
        );
        let of = |label: &str| {
            profiles
                .iter()
                .find(|p| p.label == label)
                .unwrap()
                .keepalive_seconds
        };
        assert_eq!(of("a"), Some(30));
        assert_eq!(of("b"), Some(0));
        assert_eq!(of("c"), None);
    }

    /// Everything else is ignored rather than half-translated.
    #[test]
    fn unknown_keywords_are_ignored_without_disturbing_the_block() {
        let entries = parse_config(
            "Host a\n  Ciphers aes256-gcm@openssh.com\n  LocalForward 8080 localhost:80\n  HostName h\n",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entry(&entries, "a").hostname.as_deref(), Some("h"));
    }

    /// Included files are spliced in place, so they can continue a parent's
    /// `Host` block.
    #[test]
    fn an_include_is_read_where_it_appears() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("extra"), "  HostName spliced.example.net\n").unwrap();
        std::fs::write(
            dir.path().join("config"),
            "Host prod\n  Include extra\n  Port 2222\n",
        )
        .unwrap();

        let entries = parse_config(&read_config_text(&dir.path().join("config"), 0));
        let e = entry(&entries, "prod");
        assert_eq!(e.hostname.as_deref(), Some("spliced.example.net"));
        assert_eq!(e.port, Some(2222));
    }

    /// `Include config.d/*` resolves in a stable order.
    #[test]
    fn a_wildcard_include_reads_every_match_in_a_stable_order() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("config.d");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("10-a"), "Host a\n  HostName ha\n").unwrap();
        std::fs::write(sub.join("20-b"), "Host b\n  HostName hb\n").unwrap();
        std::fs::write(dir.path().join("config"), "Include config.d/*\n").unwrap();

        let entries = parse_config(&read_config_text(&dir.path().join("config"), 0));
        assert_eq!(
            entries.iter().map(|e| e.alias.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    /// A file that includes itself terminates.
    #[test]
    fn a_self_including_config_terminates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, "Host a\n  HostName h\nInclude config\n").unwrap();

        let entries = parse_config(&read_config_text(&path, 0));
        assert_eq!(entries.len(), 1, "the repeated alias is one session");
        assert_eq!(entry(&entries, "a").hostname.as_deref(), Some("h"));
    }

    /// A missing config is not an error.
    #[test]
    fn a_missing_config_is_no_sessions_rather_than_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        assert!(parse_config(&read_config_text(&dir.path().join("nope"), 0)).is_empty());
    }

    #[test]
    fn wildcards_in_an_include_match_the_way_a_shell_would() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*.conf", "work.conf"));
        assert!(!glob_matches("*.conf", "work.conf.bak"));
        assert!(glob_matches("id_?", "id_a"));
        assert!(!glob_matches("id_?", "id_ab"));
        assert!(glob_matches("a*b*c", "axxbyyc"));
        assert!(!glob_matches("a*b*c", "axxbyy"));
    }
}
