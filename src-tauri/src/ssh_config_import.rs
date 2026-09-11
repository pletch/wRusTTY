//! One-time import of OpenSSH's `~/.ssh/config`.
//!
//! The counterpart to [`crate::putty_import`], for the other half of the
//! audience: someone arriving from a terminal `ssh` habit rather than from
//! PuTTY has no registry full of sessions, but they very often have a config
//! file with thirty `Host` blocks in it, and that file *is* their session list.
//!
//! Only the connection-shape keywords are read — `HostName`, `Port`, `User`,
//! `IdentityFile`, `ProxyJump`, `ServerAliveInterval`. Everything else OpenSSH
//! understands is deliberately ignored rather than half-translated: ciphers,
//! `ControlMaster`, `LocalForward` and the rest either have no equivalent here
//! or belong to a different part of the app, and importing a session that
//! silently drops half its config is worse than importing the part that maps
//! cleanly and saying so.
//!
//! Read-only, like the PuTTY importer. Nothing here writes to `~/.ssh`, and an
//! import never removes or overwrites an existing wRusTTY profile.
//!
//! The split mirrors `putty_import`: [`parse_config`] and [`to_profiles`] are
//! pure functions over text, and the filesystem appears only in
//! [`read_config_text`]. Every rule that matters is therefore testable without
//! a home directory to plant files in.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::profiles::SessionProfile;
use crate::session_import::{merge_into, next_id, ImportSummary};

/// Where imported sessions land, so forty new entries don't appear unsorted
/// among the user's own.
const IMPORT_FOLDER: &str = "Imported from SSH config";

/// `Include` can nest. OpenSSH's own limit is 16; this is a guard against a
/// file that includes itself, which is a typo away and would otherwise be an
/// infinite loop in the UI thread's future.
const MAX_INCLUDE_DEPTH: usize = 8;

/// One `Host` block, reduced to the keywords this app can act on.
///
/// A block naming several aliases (`Host web1 web2`) produces one of these per
/// alias, each with the same settings — which is what OpenSSH means by it, and
/// what the user would have to type by hand otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEntry {
    /// The alias as written — what the user types after `ssh`, and so the
    /// label they will look for in the session list.
    pub alias: String,
    /// `HostName` when set. `None` means the alias is itself the hostname,
    /// which is how a bare `Host build-box` block works.
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    /// Still the raw value: `bastion`, `jump.example.net`, `me@jump:2222`, or
    /// a comma-separated chain. Resolved against the session list in
    /// [`to_profiles`], which is the only place that knows what profiles exist.
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

/// Splits a config line into its keyword and value.
///
/// OpenSSH accepts `Port 2222`, `Port=2222` and `Port = 2222` alike, and
/// allows the value to be quoted when it contains spaces. Returns `None` for a
/// comment or a blank line.
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

/// A `Host` pattern that names exactly one host, rather than matching a family
/// of them.
///
/// `Host *`, `Host *.internal` and `Host !prod` are rules about how to connect
/// to hosts, not hosts themselves — there is nothing to put in a session list
/// for them, and a profile called `*.internal` would connect to a machine of
/// that literal name, i.e. nothing.
fn is_literal_alias(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains(['*', '?', '!'])
}

/// Reads the `Host` blocks out of an already-assembled config.
///
/// First value wins, per keyword per block — OpenSSH's own rule, and the one
/// that makes a trailing `Host *` block of defaults harmless here.
///
/// `Match` blocks are skipped entirely: their settings apply conditionally (on
/// the destination, the local user, the output of a command) and a session list
/// has nowhere to put a condition. Ignoring them means a `Match` block's
/// keywords don't leak into the `Host` block above it.
pub fn parse_config(text: &str) -> Vec<HostEntry> {
    let mut entries: Vec<HostEntry> = Vec::new();
    // Indices into `entries` for the aliases of the block being read — plural
    // because `Host web1 web2` sets both at once.
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
                    // A repeated alias continues the earlier block rather than
                    // starting a second profile with the same name — splitting
                    // a host's settings across two blocks is legal and not
                    // especially rare.
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
                        // OpenSSH tries multiple IdentityFiles in order; this
                        // app offers one, so the first is the honest pick.
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

/// Applies OpenSSH's first-value-wins rule, and treats a value this app can't
/// parse (`Port banana`) as absent rather than as a reason to drop the host.
fn set_once<T>(slot: &mut Option<T>, value: impl FnOnce() -> Option<T>) {
    if slot.is_none() {
        *slot = value();
    }
}

/// The alias half of a `ProxyJump` value.
///
/// The value is a comma-separated chain (`edge,bastion`) of `[user@]host[:port]`
/// hops. Only the first is used: this app's `jump_profile_id` points at one
/// profile, and that profile may itself have a jump, so a chain is expressible
/// — but only if every hop in it is a saved session, which is not something an
/// import can conjure. The first hop is the one the connection actually makes
/// from here, so it is the one worth keeping.
fn jump_alias(value: &str) -> Option<&str> {
    let first = value.split(',').next()?.trim();
    if first.is_empty() || first.eq_ignore_ascii_case("none") {
        return None;
    }
    let without_user = first.rsplit('@').next().unwrap_or(first);
    // `host:port` — but not an IPv6 literal, where the colons are the address.
    let host = match without_user.rsplit_once(':') {
        Some((host, _)) if !host.contains(':') => host,
        _ => without_user,
    };
    (!host.is_empty()).then_some(host)
}

/// Turns parsed `Host` blocks into profiles, ids and jumps included.
///
/// `existing` is the current session list, and is read for two things: minting
/// ids that don't collide, and resolving `ProxyJump` against sessions the user
/// already has. Nothing in it is modified.
pub fn to_profiles(entries: &[HostEntry], existing: &[SessionProfile]) -> Vec<SessionProfile> {
    // Ids have to exist before jumps can be linked, so this is two passes:
    // build every profile, then point them at each other.
    let mut minted = existing.to_vec();
    let mut profiles: Vec<SessionProfile> = Vec::new();
    for entry in entries {
        let id = next_id(&minted, "sshcfg");
        let profile = to_profile(entry, id);
        minted.push(profile.clone());
        profiles.push(profile);
    }

    // Where each alias ended up. The new profiles are added second so that a
    // host being imported wins over an unrelated saved profile of the same
    // name: within one import, `ProxyJump bastion` means the `bastion` in this
    // file.
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
            // An unresolvable jump is dropped rather than invented. The host
            // may be reachable directly, and a `jumpProfileId` pointing at
            // nothing would fail at connect time with a confusing error.
            by_label.get(alias).map(|id| (*id).to_string())
        })
        .collect();
    for (profile, jump) in profiles.iter_mut().zip(jumps) {
        // Never itself: `Host bastion` with `ProxyJump bastion` in an inherited
        // `Host *` block is a real thing to find in a config file, and a
        // profile that jumps through itself cannot connect.
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
        // A bare `Host build-box` block means the alias *is* the hostname —
        // that is how most people's first few entries are written.
        host: entry
            .hostname
            .clone()
            .unwrap_or_else(|| entry.alias.clone()),
        port: entry.port.filter(|p| *p != 0).unwrap_or(22),
        protocol: "ssh".to_string(),
        username: entry.user.clone().unwrap_or_default(),
        // Same reasoning as the PuTTY importer: a named key means key auth,
        // otherwise agent — which is what `ssh` does by default and what
        // someone with a config file is overwhelmingly already using. Never
        // "password", since there is no password in the file to import and a
        // profile claiming one would fail at connect time.
        auth_type: if entry.identity_file.is_some() {
            "public_key".to_string()
        } else {
            "agent".to_string()
        },
        // Left as written, `~` and all: this app expands a tilde at connect
        // time (`wr_ssh::expand_tilde`), and a path resolved now would be
        // wrong for a home directory that moves.
        key_path: entry.identity_file.clone(),
        has_credential: false,
        jump_profile_id: None,
        // `SetEnv TERM=…` exists but is rare and conditional; the ordinary way
        // to change TERM for a host isn't in this file at all.
        term_type: None,
        backspace_sends_ctrl_h: None,
        // `ServerAliveInterval` is exactly this app's keepalive, seconds and
        // all, including `0` for off. Someone who set it did so because a
        // firewall on the path to *that host* kept dropping their session.
        keepalive_seconds: entry.server_alive_interval,
        // Nothing in an SSH config describes waking a machine.
        wake_on_lan: None,
        // No equivalent setting, so an import follows the global one.
        auto_reconnect: None,
        // An import says nothing about whether this host's shell history may be
        // read; that is the user's call, made per host or globally.
        import_remote_history: None,
        use_proxy: None,
        log_session: None,
        serial: None,
        local: None,
    }
}

/// The config file, with every `Include` spliced in where it appeared.
///
/// Splicing rather than parsing per-file because that is what OpenSSH does:
/// an included file's keywords take effect at the point of inclusion, and can
/// continue a `Host` block that started in the parent. Assembling one text
/// keeps [`parse_config`] a pure function over a single string.
fn read_config_text(path: &Path, depth: usize) -> String {
    if depth > MAX_INCLUDE_DEPTH {
        return String::new();
    }
    // A missing config is the ordinary case on a machine that has never run
    // `ssh`, not an error to put on screen.
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

/// The files one `Include` pattern names.
///
/// A relative path is relative to `~/.ssh` (OpenSSH's rule for a user config),
/// and the pattern may end in a wildcard — `Include config.d/*` is the common
/// shape, and the whole reason someone splits their config up. Only the final
/// path component may contain the wildcard, which covers every real-world use
/// of it and keeps this from becoming a directory walker.
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
    // Directory order is not defined, and an import that produces a different
    // jump chain depending on how the filesystem felt would be miserable to
    // support.
    matches.sort();
    matches
}

/// `*` (any run, including empty) and `?` (exactly one), over one filename.
fn glob_matches(pattern: &str, candidate: &str) -> bool {
    let (p, c): (Vec<char>, Vec<char>) = (pattern.chars().collect(), candidate.chars().collect());
    // Backtracking on `*` only — the alternative is a table, and a filename is
    // never long enough for that to matter.
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

/// How many sessions `~/.ssh/config` would contribute, so the UI can say what
/// the button would do — or that there is nothing to do.
///
/// Counts literal `Host` aliases, which is what would import: a config that is
/// nothing but a `Host *` block of defaults reports 0 rather than 1.
#[tauri::command]
pub async fn ssh_config_sessions_available() -> Result<usize, String> {
    Ok(read_entries().len())
}

#[tauri::command]
pub async fn ssh_config_import_sessions(
    app: AppHandle,
    profile_state: tauri::State<'_, crate::profiles::ProfileState>,
) -> Result<ImportSummary, String> {
    // Reading `~/.ssh` stays outside the lock: it touches nothing this app
    // writes, and it is the slow half.
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

    /// `Key=value` and `Key = value` are both legal, and a quoted value is how
    /// anything with a space in it is written.
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

    /// A block naming several aliases sets all of them — that is what OpenSSH
    /// means by it, and the user would otherwise retype the settings.
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

    /// `Host *` is a rule about connecting, not a host. Importing it would
    /// produce a session that connects to a machine literally named `*`.
    #[test]
    fn wildcard_and_negated_patterns_are_not_sessions() {
        let entries = parse_config(
            "Host *\n  User default\nHost *.internal\n  Port 2222\nHost !prod\n  User x\nHost real\n  HostName r\n",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "real");
    }

    /// OpenSSH's first-value-wins rule, which is also what makes a trailing
    /// `Host *` block of defaults harmless.
    #[test]
    fn the_first_value_for_a_keyword_wins() {
        let entries = parse_config("Host a\n  Port 22\n  Port 2222\n");
        assert_eq!(entry(&entries, "a").port, Some(22));
    }

    /// A `Match` block's settings are conditional and a session list has
    /// nowhere to put a condition — so they must not leak into the `Host`
    /// block above.
    #[test]
    fn match_block_settings_do_not_leak_into_the_previous_host() {
        let entries = parse_config("Host a\n  HostName real\nMatch host b\n  User sneaky\n");
        let e = entry(&entries, "a");
        assert_eq!(e.hostname.as_deref(), Some("real"));
        assert!(e.user.is_none());
    }

    /// Splitting one host's settings across two blocks is legal, and produced
    /// two profiles of the same name before.
    #[test]
    fn a_repeated_alias_continues_the_same_session() {
        let entries = parse_config("Host a\n  HostName h\nHost b\n  User x\nHost a\n  Port 2222\n");
        assert_eq!(entries.len(), 2);
        let e = entry(&entries, "a");
        assert_eq!(e.hostname.as_deref(), Some("h"));
        assert_eq!(e.port, Some(2222));
    }

    /// A `Port banana` shouldn't cost the user the host it was written under.
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

    /// Not "password": there is no password in the file, so a profile claiming
    /// one would fail at connect time for a secret that was never importable.
    #[test]
    fn auth_is_key_when_a_key_is_named_and_agent_otherwise() {
        let profiles = to_profiles(
            &parse_config("Host k\n  IdentityFile ~/.ssh/id_ed25519\nHost a\n"),
            &[],
        );
        let keyed = profiles.iter().find(|p| p.label == "k").unwrap();
        assert_eq!(keyed.auth_type, "public_key");
        // Left unexpanded — a path resolved now is wrong for a home that moves.
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

    /// The point of importing a jump: `ssh prod` going through the bastion is
    /// the whole reason the config file said so.
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
        // Order in the file doesn't matter: a jump named before it is defined
        // still resolves.
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

    /// The hop's own user and port live on that hop's profile, so only the
    /// alias is needed to find it.
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

    /// Only the first hop: `jump_profile_id` points at one profile, and the
    /// rest of the chain would have to be sessions this import can't invent.
    #[test]
    fn only_the_first_hop_of_a_chain_is_used() {
        assert_eq!(jump_alias("edge,bastion"), Some("edge"));
        assert_eq!(jump_alias("me@edge:2222"), Some("edge"));
        assert_eq!(jump_alias("none"), None);
        assert_eq!(jump_alias(""), None);
        // An IPv6 literal's colons are the address, not a port.
        assert_eq!(jump_alias("2001:db8::1"), Some("2001:db8::1"));
    }

    /// A jump naming a host that isn't in the file (and isn't already saved)
    /// would otherwise leave a `jumpProfileId` pointing at nothing, which
    /// fails at connect time with a confusing error.
    #[test]
    fn an_unresolvable_jump_is_dropped_rather_than_invented() {
        let profiles = to_profiles(&parse_config("Host prod\n  ProxyJump ghost\n"), &[]);
        assert!(profiles[0].jump_profile_id.is_none());
    }

    /// A profile that jumps through itself cannot connect, and inheriting a
    /// `ProxyJump` from a `Host *` block is how it happens.
    #[test]
    fn a_session_is_never_linked_as_its_own_jump() {
        let profiles = to_profiles(&parse_config("Host bastion\n  ProxyJump bastion\n"), &[]);
        assert!(profiles[0].jump_profile_id.is_none());
    }

    /// The user's existing sessions are fair game as jump targets — someone
    /// who already saved their bastion by hand shouldn't get a broken import.
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
            // An import says nothing about whether this host's shell history may be
            // read; that is the user's call, made per host or globally.
            import_remote_history: None,
            use_proxy: None,
            log_session: None,
            serial: None,
            local: None,
        }];
        let profiles = to_profiles(&parse_config("Host prod\n  ProxyJump bastion\n"), &existing);
        assert_eq!(profiles[0].jump_profile_id.as_deref(), Some("mine"));
    }

    /// `ServerAliveInterval` is this app's keepalive exactly, `0` (off)
    /// included — and `0` is a real choice, not the same as unset.
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

    /// Everything else OpenSSH understands is ignored rather than
    /// half-translated.
    #[test]
    fn unknown_keywords_are_ignored_without_disturbing_the_block() {
        let entries = parse_config(
            "Host a\n  Ciphers aes256-gcm@openssh.com\n  LocalForward 8080 localhost:80\n  HostName h\n",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entry(&entries, "a").hostname.as_deref(), Some("h"));
    }

    /// An included file's keywords take effect where the `Include` was, which
    /// is what lets it continue a `Host` block the parent started — so the
    /// files are spliced, not parsed one at a time.
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

    /// `Include config.d/*` is the shape someone splits a config into, and the
    /// order has to be the same every run — a jump chain that depends on how
    /// the filesystem felt would be miserable to support.
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

    /// A file that includes itself is a typo away, and would otherwise be an
    /// infinite loop behind a button in the settings dialog.
    #[test]
    fn a_self_including_config_terminates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, "Host a\n  HostName h\nInclude config\n").unwrap();

        let entries = parse_config(&read_config_text(&path, 0));
        assert_eq!(entries.len(), 1, "the repeated alias is one session");
        assert_eq!(entry(&entries, "a").hostname.as_deref(), Some("h"));
    }

    /// A machine that has never run `ssh` is the common case, not an error to
    /// put on screen.
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
