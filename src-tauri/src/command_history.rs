//! Recent-command history, the store autocomplete suggests from (see
//! docs/AUTOCOMPLETE_PLAN.md). Filled three ways: OSC 633 `E` reports from
//! shells with integration (`Integration`), the prompt line read off the grid
//! on Enter (`Screen`), and a one-off import of the remote shell's history file
//! over `exec` (`Harvest`, gated on its own setting).
//!
//! Ranking happens here rather than in the webview, at the cost of an IPC round
//! trip per keystroke, so the webview (which renders untrusted remote output)
//! only ever sees the few suggestions being shown.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// Bumped only for incompatible changes; new fields use `#[serde(default)]`.
const STORE_VERSION: u32 = 1;

/// Entries kept per host before the lowest-scoring are dropped; at the top of
/// typical `HISTSIZE` values, and it bounds the per-keystroke scan.
const MAX_ENTRIES_PER_HOST: usize = 5_000;

/// Longer lines are pasted scripts or blobs. Dropped rather than truncated:
/// accepting half a command would send something never run.
const MAX_COMMAND_LEN: usize = 2_048;

/// Where an entry came from. Kept so withdrawing harvest consent can drop
/// exactly what the harvest imported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistorySource {
    /// Read from the remote shell's history file over an `exec` channel.
    Harvest,
    /// Reported by the remote shell itself, via OSC 633 `E`.
    Integration,
    /// Reconstructed from the terminal grid, for hosts with no integration.
    Screen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub command: String,
    /// Times seen. One entry per distinct command; no per-run timestamps.
    pub count: u32,
    /// Times accepted from a suggestion, a stronger signal than a sighting.
    #[serde(default)]
    pub accepted: u32,
    /// Epoch milliseconds of the most recent sighting.
    pub last_used: i64,
    pub source: HistorySource,
    /// The directory it was last run in, when the host reports one (OSC 7). One
    /// directory, so entries stay bounded.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// The whole store: entries grouped by an opaque host key chosen by the
/// frontend (`user@host:port`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStore {
    pub version: u32,
    #[serde(default)]
    pub hosts: BTreeMap<String, Vec<HistoryEntry>>,
    /// Commands the user said never to suggest, per host, newest last, as
    /// normalized text. A forget blocks the command so a later run or harvest
    /// can't bring it back; only "Allow again" lifts it.
    #[serde(default)]
    pub blocked: BTreeMap<String, Vec<String>>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            hosts: BTreeMap::new(),
            blocked: BTreeMap::new(),
        }
    }
}

impl HistoryStore {
    pub fn is_blocked(&self, host: &str, command: &str) -> bool {
        self.blocked
            .get(host)
            .is_some_and(|commands| commands.iter().any(|c| c == command))
    }

    /// Drop one command and keep it from coming back: not suggested, not
    /// recorded when run again, not re-imported.
    pub fn forget_and_block(&mut self, host: &str, command: &str) {
        if let Some(entries) = self.hosts.get_mut(host) {
            entries.retain(|e| e.command != command);
        }
        if !self.is_blocked(host, command) {
            self.blocked
                .entry(host.to_string())
                .or_default()
                .push(command.to_string());
        }
        self.drop_empty_hosts();
    }

    /// Lift a block. Nothing is restored; the command is learned again from
    /// scratch.
    pub fn allow(&mut self, host: &str, command: &str) {
        if let Some(commands) = self.blocked.get_mut(host) {
            commands.retain(|c| c != command);
        }
        self.drop_empty_hosts();
    }

    /// Forget a host entirely, blocks included (they're commands typed there too).
    pub fn forget_host(&mut self, host: &str) {
        self.hosts.remove(host);
        self.blocked.remove(host);
    }

    pub fn forget_all(&mut self) {
        self.hosts.clear();
        self.blocked.clear();
    }

    fn drop_empty_hosts(&mut self) {
        self.hosts.retain(|_, entries| !entries.is_empty());
        self.blocked.retain(|_, commands| !commands.is_empty());
    }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Argument prefixes whose value is a secret; the whole line is dropped.
/// Matched case-insensitively against words. Dropped rather than masked, since a
/// masked command would still be offered and would run wrongly.
const SECRET_ARG_PREFIXES: &[&str] = &[
    "--password",
    "--passwd",
    "--pass=",
    "--token",
    "--api-key",
    "--apikey",
    "--secret",
    "--auth",
    "--access-key",
    "--private-key",
    "-p", // mysql/mysqldump: `-pHunter2`, with no space. See below.
];

/// Substrings anywhere in the line that mean it carries a credential.
const SECRET_SUBSTRINGS: &[&str] = &[
    "authorization:",
    "password=",
    "passwd=",
    "pgpassword",
    "mysql_pwd",
    "aws_secret_access_key",
    "api_key=",
    "apikey=",
    "access_token",
    "secret_key",
    "bearer ",
];

/// Whether a word looks like a random credential: long, token alphabet, mixed
/// case and digits. Conservative toward not firing on paths, flags and SHAs.
fn looks_like_token(word: &str) -> bool {
    // A base64/hex-ish run, allowing the separators tokens actually contain.
    const MIN_TOKEN_LEN: usize = 24;
    let body = word.trim_matches(|c| c == '"' || c == '\'');
    if body.len() < MIN_TOKEN_LEN {
        return false;
    }
    if !body
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-' | '.'))
    {
        return false;
    }
    // Anything with a separator is treated as a path. Dotted tokens (JWTs) are
    // caught by the substring list instead.
    if body.contains('/') || body.contains('.') {
        return false;
    }
    let has_upper = body.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = body.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = body.chars().any(|c| c.is_ascii_digit());
    has_upper && has_lower && has_digit
}

/// Normalize a command for storage, or `None` to store nothing (empty, too
/// long, control characters, or apparently a credential).
pub fn redact(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COMMAND_LEN {
        return None;
    }
    // Control characters mean a stray escape sequence, which could be
    // interpreted when accepted. Tab too: at a prompt it's completion.
    if trimmed.chars().any(|c| c.is_control()) {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if SECRET_SUBSTRINGS
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return None;
    }
    for word in lower.split_whitespace() {
        for prefix in SECRET_ARG_PREFIXES {
            if !word.starts_with(prefix) {
                continue;
            }
            // Bare `-p` is common (`mkdir -p`, `ssh -p 22`); only an attached value is
            // mysql's password form, and mysql has no separated spelling.
            if *prefix == "-p" && word.len() == 2 {
                continue;
            }
            return None;
        }
    }
    if trimmed.split_whitespace().any(looks_like_token) {
        return None;
    }
    // No letters or digits at all: a masked password prompt (`********`),
    // which passes the echo check in Terminal.tsx.
    if !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/// How long an unused command's weight takes to halve; a monthly chore survives
/// to its next use.
const HALF_LIFE_DAYS: f64 = 30.0;
const MS_PER_DAY: f64 = 86_400_000.0;

/// An acceptance counts as this many sightings.
const ACCEPT_WEIGHT: f64 = 3.0;

/// Multiplier for an entry last used in the directory the prompt is in now.
const CWD_MATCH_BONUS: f64 = 1.5;

/// Frecency: use count decayed by age, with a bonus for the current directory.
pub fn score(entry: &HistoryEntry, now_ms: i64, cwd: Option<&str>) -> f64 {
    let age_days = ((now_ms - entry.last_used).max(0) as f64) / MS_PER_DAY;
    let recency = 0.5_f64.powf(age_days / HALF_LIFE_DAYS);
    let weight = entry.count as f64 + ACCEPT_WEIGHT * entry.accepted as f64;
    let here = match (cwd, entry.cwd.as_deref()) {
        (Some(a), Some(b)) if a == b => CWD_MATCH_BONUS,
        _ => 1.0,
    };
    weight * recency * here
}

/// How well a candidate matches, lower is better. Ranked strictly before score
/// so the top suggestion stays predictable from what was typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchRank {
    Prefix = 0,
    PrefixIgnoringCase = 1,
    Initials = 2,
}

/// Characters that end a word.
const WORD_BOUNDARIES: &[char] = &[
    ' ', '\t', '-', '_', '/', '.', ':', '=', ',', ';', '|', '&', '"', '\'', '(', '[', '{', '$',
];

/// Whether `needle` is the sequence of word initials of `haystack`, starting at
/// its first character, so `gcm` reaches `git commit -m`. Every matched
/// character must begin a word, and the first must begin the command.
fn matches_initials(command_lower: &str, needle_lower: &str) -> bool {
    // After a space the input is a command line, not an acronym.
    if needle_lower.is_empty() || needle_lower.contains(' ') {
        return false;
    }
    let mut needle = needle_lower.chars().peekable();
    if command_lower.chars().next() != needle.peek().copied() {
        return false;
    }
    let mut previous: Option<char> = None;
    for current in command_lower.chars() {
        // `is_none_or` postdates this crate's MSRV.
        let starts_a_word = match previous {
            None => true,
            Some(p) => WORD_BOUNDARIES.contains(&p),
        };
        if starts_a_word && !WORD_BOUNDARIES.contains(&current) && needle.peek() == Some(&current) {
            needle.next();
        }
        previous = Some(current);
    }
    needle.peek().is_none()
}

fn match_rank(command: &str, typed: &str, typed_lower: &str) -> Option<MatchRank> {
    // Suggestions only ever append.
    if command.len() <= typed.len() {
        return None;
    }
    if command.starts_with(typed) {
        return Some(MatchRank::Prefix);
    }
    let command_lower = command.to_ascii_lowercase();
    if command_lower.starts_with(typed_lower) {
        return Some(MatchRank::PrefixIgnoringCase);
    }
    if matches_initials(&command_lower, typed_lower) {
        return Some(MatchRank::Initials);
    }
    None
}

/// The best `limit` completions of `typed`, best first. Empty for an empty
/// prompt.
pub fn suggest(
    entries: &[HistoryEntry],
    typed: &str,
    cwd: Option<&str>,
    now_ms: i64,
    limit: usize,
) -> Vec<String> {
    if typed.trim().is_empty() || limit == 0 {
        return Vec::new();
    }
    let typed_lower = typed.to_ascii_lowercase();
    let mut ranked: Vec<(MatchRank, f64, &str)> = entries
        .iter()
        .filter_map(|entry| {
            match_rank(&entry.command, typed, &typed_lower)
                .map(|rank| (rank, score(entry, now_ms, cwd), entry.command.as_str()))
        })
        .collect();
    // Rank, then score descending, then the command for a stable order.
    ranked.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| a.2.cmp(b.2))
    });
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, _, command)| command.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/// Fold a command into a host's entries, redacting first. Returns whether
/// anything was stored (refusal is normal, e.g. password prompts).
pub fn record(
    entries: &mut Vec<HistoryEntry>,
    command: &str,
    cwd: Option<&str>,
    source: HistorySource,
    now_ms: i64,
) -> bool {
    let Some(command) = redact(command) else {
        return false;
    };
    match entries.iter_mut().find(|e| e.command == command) {
        Some(existing) => {
            existing.count = existing.count.saturating_add(1);
            existing.last_used = now_ms;
            existing.cwd = cwd.map(str::to_string).or_else(|| existing.cwd.clone());
            // Running a harvested command makes it witnessed, so it survives
            // "forget imported history".
            if existing.source == HistorySource::Harvest && source != HistorySource::Harvest {
                existing.source = source;
            }
        }
        None => entries.push(HistoryEntry {
            command,
            count: 1,
            accepted: 0,
            last_used: now_ms,
            source,
            cwd: cwd.map(str::to_string),
        }),
    }
    prune(entries, now_ms);
    true
}

/// Note that a suggestion was taken. Does nothing if the command is no longer
/// stored.
pub fn record_accepted(entries: &mut [HistoryEntry], command: &str) {
    if let Some(entry) = entries.iter_mut().find(|e| e.command == command) {
        entry.accepted = entry.accepted.saturating_add(1);
    }
}

/// Hold a host to `MAX_ENTRIES_PER_HOST`, dropping the lowest-scoring first.
fn prune(entries: &mut Vec<HistoryEntry>, now_ms: i64) {
    if entries.len() <= MAX_ENTRIES_PER_HOST {
        return;
    }
    entries.sort_by(|a, b| {
        score(b, now_ms, None)
            .total_cmp(&score(a, now_ms, None))
            .then_with(|| a.command.cmp(&b.command))
    });
    entries.truncate(MAX_ENTRIES_PER_HOST);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// The store, cached in memory because `suggest` runs per keystroke. Every
/// mutation writes through to disk before returning.
#[derive(Default)]
pub struct HistoryState {
    cache: Mutex<Option<HistoryStore>>,
}

impl HistoryState {
    async fn with_store<R>(
        &self,
        app: &AppHandle,
        f: impl FnOnce(&mut HistoryStore) -> Result<(R, bool), String>,
    ) -> Result<R, String> {
        let path = history_path(app)?;
        let mut cache = self.cache.lock().await;
        if cache.is_none() {
            *cache = Some(read_store(&path)?);
        }
        let store = cache.as_mut().expect("just filled");
        let (value, dirty) = f(store)?;
        if dirty {
            write_store(&path, store)?;
        }
        Ok(value)
    }
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("command-history.json"))
        .map_err(|e| e.to_string())
}

/// A store that won't parse is replaced rather than reported: losing
/// suggestions once beats autocomplete never working again.
fn read_store(path: &PathBuf) -> Result<HistoryStore, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(serde_json::from_str(&contents).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HistoryStore::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_store(path: &std::path::Path, store: &HistoryStore) -> Result<(), String> {
    crate::atomic_file::write_json_atomic(path, store)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One host's stored commands, for the Settings list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHistory {
    pub host: String,
    pub entries: Vec<HistoryEntry>,
    /// Never-suggest commands for this host, newest first.
    pub blocked: Vec<String>,
}

#[tauri::command]
pub async fn command_history_record(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
    host: String,
    command: String,
    cwd: Option<String>,
    source: HistorySource,
) -> Result<bool, String> {
    let now = now_ms();
    state
        .with_store(&app, |store| {
            // Blocks hold the normalized form.
            if redact(&command).is_some_and(|c| store.is_blocked(&host, &c)) {
                return Ok((false, false));
            }
            let entries = store.hosts.entry(host).or_default();
            let stored = record(entries, &command, cwd.as_deref(), source, now);
            Ok((stored, stored))
        })
        .await
}

#[tauri::command]
pub async fn command_history_suggest(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
    host: String,
    typed: String,
    cwd: Option<String>,
    limit: usize,
) -> Result<Vec<String>, String> {
    let now = now_ms();
    state
        .with_store(&app, |store| {
            let found = store
                .hosts
                .get(&host)
                .map(|entries| suggest(entries, &typed, cwd.as_deref(), now, limit.min(20)))
                .unwrap_or_default();
            Ok((found, false))
        })
        .await
}

#[tauri::command]
pub async fn command_history_accepted(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
    host: String,
    command: String,
) -> Result<(), String> {
    state
        .with_store(&app, |store| {
            let Some(entries) = store.hosts.get_mut(&host) else {
                return Ok(((), false));
            };
            record_accepted(entries, &command);
            Ok(((), true))
        })
        .await
}

/// Everything stored, for the Settings list.
#[tauri::command]
pub async fn command_history_list(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
) -> Result<Vec<HostHistory>, String> {
    state
        .with_store(&app, |store| {
            let now = now_ms();
            // A host with only blocks still needs a row so they can be lifted.
            let hosts: std::collections::BTreeSet<&String> =
                store.hosts.keys().chain(store.blocked.keys()).collect();
            let listed = hosts
                .into_iter()
                .map(|host| {
                    let mut entries = store.hosts.get(host).cloned().unwrap_or_default();
                    entries.sort_by(|a, b| {
                        score(b, now, None)
                            .total_cmp(&score(a, now, None))
                            .then_with(|| a.command.cmp(&b.command))
                    });
                    let mut blocked = store.blocked.get(host).cloned().unwrap_or_default();
                    blocked.reverse();
                    HostHistory {
                        host: host.clone(),
                        entries,
                        blocked,
                    }
                })
                .collect();
            Ok((listed, false))
        })
        .await
}

/// Forget one command (and block it), one host, or everything (no `host`).
#[tauri::command]
pub async fn command_history_forget(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
    host: Option<String>,
    command: Option<String>,
) -> Result<(), String> {
    state
        .with_store(&app, |store| {
            match (host, command) {
                (None, _) => store.forget_all(),
                (Some(host), None) => store.forget_host(&host),
                (Some(host), Some(command)) => store.forget_and_block(&host, &command),
            }
            Ok(((), true))
        })
        .await
}

/// Lift a never-suggest block, so the command can be learned again.
#[tauri::command]
pub async fn command_history_allow(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
    host: String,
    command: String,
) -> Result<(), String> {
    state
        .with_store(&app, |store| {
            store.allow(&host, &command);
            Ok(((), true))
        })
        .await
}

/// Drop everything the harvest imported, keeping what was witnessed.
#[tauri::command]
pub async fn command_history_forget_imported(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
) -> Result<(), String> {
    state
        .with_store(&app, |store| {
            for entries in store.hosts.values_mut() {
                entries.retain(|e| e.source != HistorySource::Harvest);
            }
            store.hosts.retain(|_, entries| !entries.is_empty());
            Ok(((), true))
        })
        .await
}

// ---------------------------------------------------------------------------
// Tier 1: importing the remote shell's own history
// ---------------------------------------------------------------------------

/// Lines requested from the remote history file.
const HARVEST_LINES: usize = 5_000;

/// Hard cap on the reply, whatever the remote sends.
pub const HARVEST_MAX_BYTES: usize = 1_024 * 1_024;

/// How long the remote gets before the harvest gives up.
pub const HARVEST_TIMEOUT_SECS: u64 = 10;

/// Cap on an imported command's count, so one import can't outrank real use
/// for months.
const MAX_IMPORTED_COUNT: u32 = 25;

/// Marks the start of a real answer, to tell it from a banner.
const HARVEST_MARKER: &str = "@@WRUSTTY-HISTORY:";

/// The command sent down the `exec` channel. Wrapped in `/bin/sh -c '...'`
/// because the login shell may be fish (not POSIX); the script itself must
/// contain no single quote. It asks the shell for the history file (`HISTFILE`,
/// then a per-shell default) and `tail`s it.
pub fn harvest_command() -> String {
    format!(
        "/bin/sh -c 'case \"${{SHELL##*/}}\" in \
zsh) f=\"${{HISTFILE:-$HOME/.zsh_history}}\";; \
fish) f=\"${{HISTFILE:-$HOME/.local/share/fish/fish_history}}\";; \
*) f=\"${{HISTFILE:-$HOME/.bash_history}}\";; \
esac; [ -r \"$f\" ] || exit 0; printf \"{marker}%s\\n\" \"$f\"; tail -n {lines} -- \"$f\"'",
        marker = HARVEST_MARKER,
        lines = HARVEST_LINES,
    )
}

/// A history file's format, decided by its name (which came from the shell
/// `case` above).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryFormat {
    /// One command per line; `HISTTIMEFORMAT` adds `#<epoch>` lines.
    Plain,
    /// zsh extended: `: <epoch>:<elapsed>;<command>`, trailing backslash
    /// continues.
    Zsh,
    /// fish: `- cmd: <command>` then `  when: <epoch>`.
    Fish,
}

fn format_for(path: &str) -> HistoryFormat {
    if path.ends_with("fish_history") {
        HistoryFormat::Fish
    } else if path.ends_with("zsh_history") || path.ends_with("zhistory") {
        HistoryFormat::Zsh
    } else {
        HistoryFormat::Plain
    }
}

/// Turn the remote's output into commands and their counts. `None` when there
/// is no marker (a banner or restricted shell), which must not look like an
/// empty history. Counts rather than timestamps, since bash usually records
/// none.
pub fn parse_remote_history(payload: &str) -> Option<Vec<(String, u32)>> {
    // A banner or chatty rc file can push the marker down.
    let at = payload.find(HARVEST_MARKER)?;
    let rest = &payload[at + HARVEST_MARKER.len()..];
    let (path, body) = rest.split_once('\n')?;
    let format = format_for(path.trim());

    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for command in extract_commands(body, format) {
        let Some(command) = redact(&command) else {
            continue;
        };
        let slot = counts.entry(command.clone()).or_insert_with(|| {
            order.push(command.clone());
            0
        });
        *slot = slot.saturating_add(1).min(MAX_IMPORTED_COUNT);
    }
    Some(
        order
            .into_iter()
            .map(|c| (counts[&c], c))
            .map(|(n, c)| (c, n))
            .collect(),
    )
}

fn extract_commands(body: &str, format: HistoryFormat) -> Vec<String> {
    let mut out = Vec::new();
    match format {
        HistoryFormat::Fish => {
            for line in body.lines() {
                if let Some(cmd) = line.strip_prefix("- cmd: ") {
                    out.push(cmd.to_string());
                }
            }
        }
        HistoryFormat::Zsh | HistoryFormat::Plain => {
            // Join backslash continuations so fragments aren't imported; the joined
            // command then fails `redact` (newline), which is also right.
            let mut pending: Option<String> = None;
            for line in body.lines() {
                let line = line.strip_suffix('\r').unwrap_or(line);
                let piece = match pending.take() {
                    Some(started) => format!("{started}\n{line}"),
                    None => {
                        if format == HistoryFormat::Zsh {
                            strip_zsh_prefix(line).to_string()
                        } else if line.starts_with('#') {
                            // bash's `#<epoch>` lines under HISTTIMEFORMAT.
                            continue;
                        } else {
                            line.to_string()
                        }
                    }
                };
                if let Some(head) = piece.strip_suffix('\\') {
                    pending = Some(head.to_string());
                    continue;
                }
                out.push(piece);
            }
            if let Some(unfinished) = pending {
                out.push(unfinished);
            }
        }
    }
    out
}

/// Strips zsh's `: <epoch>:<elapsed>;` metadata; lines without it are plain
/// entries.
fn strip_zsh_prefix(line: &str) -> &str {
    let Some(rest) = line.strip_prefix(": ") else {
        return line;
    };
    let Some((meta, command)) = rest.split_once(';') else {
        return line;
    };
    // Only if it really is `<digits>:<digits>`, or a command starting with ": "
    // would be mangled.
    let looks_like_meta = meta.split_once(':').is_some_and(|(epoch, elapsed)| {
        !epoch.is_empty()
            && epoch.chars().all(|c| c.is_ascii_digit())
            && elapsed.chars().all(|c| c.is_ascii_digit())
    });
    if looks_like_meta {
        command
    } else {
        line
    }
}

/// Fold an imported history into a host's entries as `Harvest`. Existing
/// entries keep their provenance.
pub fn import(entries: &mut Vec<HistoryEntry>, imported: Vec<(String, u32)>, now_ms: i64) -> usize {
    let mut added = 0;
    for (command, count) in imported {
        match entries.iter_mut().find(|e| e.command == command) {
            // Not a new use: raise the count if the file claims more, but don't touch
            // `last_used`, or stale commands would look fresh.
            Some(existing) => existing.count = existing.count.max(count),
            None => {
                added += 1;
                entries.push(HistoryEntry {
                    command,
                    count,
                    accepted: 0,
                    // The import time; there's no honest per-entry time to use.
                    last_used: now_ms,
                    source: HistorySource::Harvest,
                    cwd: None,
                });
            }
        }
    }
    prune(entries, now_ms);
    added
}

/// Import a host's own shell history over one `exec` channel. The setting is
/// resolved before the channel opens, since running it at all is visible to
/// the host. The caller has checked autocomplete is on. Returns how many
/// commands were newly added; a host that won't answer returns 0, not an
/// error. See docs/AUTOCOMPLETE_PLAN.md.
#[tauri::command]
pub async fn command_history_harvest(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
    ssh: tauri::State<'_, crate::ssh::SshState>,
    session_id: String,
    host: String,
    import_globally: bool,
    profile_id: Option<String>,
) -> Result<usize, String> {
    // Resolved here, where the per-host half (`sessions.json`) lives. The saved
    // session's answer wins outright (unlike auto-reconnect, where either "no"
    // wins): this is off by default, so a per-host `true` is the override's
    // purpose.
    let profile_override = profile_id
        .and_then(|id| crate::profiles::get_profile(&app, &id).ok())
        .and_then(|p| p.import_remote_history);
    if !profile_override.unwrap_or(import_globally) {
        return Ok(0);
    }

    let session = crate::ssh::lookup(&ssh, &session_id).await?;
    let output = {
        let guard = session.lock().await;
        guard
            .ready()?
            .exec_capture(
                &harvest_command(),
                HARVEST_MAX_BYTES,
                std::time::Duration::from_secs(HARVEST_TIMEOUT_SECS),
            )
            .await
            .map_err(|e| e.to_string())?
    };

    // Lossy: one undecodable line mustn't cost the whole import.
    let payload = String::from_utf8_lossy(&output);
    let Some(imported) = parse_remote_history(&payload) else {
        // No marker: the host printed something else. Not an error.
        return Ok(0);
    };
    let now = now_ms();
    state
        .with_store(&app, |store| {
            let imported = imported
                .into_iter()
                .filter(|(command, _)| !store.is_blocked(&host, command))
                .collect();
            let entries = store.hosts.entry(host).or_default();
            let added = import(entries, imported, now);
            Ok((added, added > 0))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;
    const NOW: i64 = 1_700_000_000_000;

    fn entry(command: &str, count: u32, age_days: i64) -> HistoryEntry {
        HistoryEntry {
            command: command.to_string(),
            count,
            accepted: 0,
            last_used: NOW - age_days * DAY,
            source: HistorySource::Integration,
            cwd: None,
        }
    }

    #[test]
    fn ordinary_commands_survive_redaction() {
        for command in [
            "git commit -m 'fix the thing'",
            "mkdir -p /var/log/app",
            "ssh -p 2222 dev@example.com",
            "cp -p a b",
            "tail -f /var/log/nginx/access.log",
            "docker compose up -d",
            "git checkout 5f2e9c1a4b7d8e3f6a0c2b5d8e1f4a7c0b3d6e9f",
        ] {
            assert_eq!(
                redact(command).as_deref(),
                Some(command),
                "dropped {command}"
            );
        }
    }

    #[test]
    fn credentials_take_the_whole_line_with_them() {
        for command in [
            "mysql -uroot -pHunter2",
            "curl -H \"Authorization: Bearer abc\" https://example.com",
            "PGPASSWORD=secret psql -h db",
            "wget --password=hunter2 https://example.com",
            "aws configure set aws_secret_access_key AKIAIOSFODNN7",
            "deploy --token ghp_16C7e42F292c6912E7710c838347Ae178B4a",
        ] {
            assert_eq!(redact(command), None, "kept {command}");
        }
    }

    /// The `-p` rule, pinned in both directions.
    #[test]
    fn bare_dash_p_is_a_flag_and_attached_dash_p_is_a_password() {
        assert!(redact("mkdir -p one/two").is_some());
        assert!(redact("mysqldump -pS3cret db").is_none());
    }

    /// A masking password prompt's output; echo checks can't catch it.
    #[test]
    fn a_line_of_mask_characters_is_not_a_command() {
        assert_eq!(redact("********"), None);
        assert_eq!(redact("\u{2022}\u{2022}\u{2022}\u{2022}"), None);
        assert_eq!(redact("...."), None);
        // A real command of mostly punctuation still counts.
        assert!(redact("cd ..").is_some());
        assert!(redact("./configure").is_some());
    }

    #[test]
    fn control_characters_and_absurd_lengths_are_refused() {
        assert_eq!(redact("echo hi\x1b[31m"), None);
        assert_eq!(redact("echo\thi"), None);
        assert_eq!(redact(""), None);
        assert_eq!(redact("   "), None);
        assert_eq!(redact(&"x".repeat(MAX_COMMAND_LEN + 1)), None);
    }

    /// A high-entropy word is a token; a path, a flag and a git SHA are not.
    #[test]
    fn token_detection_does_not_fire_on_ordinary_arguments() {
        assert!(looks_like_token("Zm9vYmFyYmF6cXV1eDEyMzQ1Ng"));
        assert!(!looks_like_token("/var/log/nginx/access.log"));
        assert!(!looks_like_token("--reconnect-max-seconds"));
        assert!(!looks_like_token(
            "5f2e9c1a4b7d8e3f6a0c2b5d8e1f4a7c0b3d6e9f"
        ));
        assert!(!looks_like_token("short"));
    }

    #[test]
    fn an_exact_prefix_beats_a_better_scoring_initials_match() {
        let entries = vec![entry("git status", 1, 0), entry("git commit -m x", 50, 0)];
        // Prefix rank beats fifty times the score.
        assert_eq!(
            suggest(&entries, "gcm", None, NOW, 1),
            vec!["git commit -m x"]
        );
        assert_eq!(suggest(&entries, "git s", None, NOW, 5), vec!["git status"]);
    }

    /// Typing `exit` once offered a screenful of unrelated commands because a
    /// subsequence test found the letters scattered through long paths.
    #[test]
    fn a_short_word_does_not_match_every_long_command_it_shares_letters_with() {
        let entries = vec![
            entry(
                "sudo cp /home/dev/Repos/xrdp/xrdp_accel_assist/.libs/xrdp-accel-assist /usr/local/libexec/xrdp/xrdp-accel-assist",
                5,
                0,
            ),
            entry("git commit -m \"Improve tab-bar multi-pane indication\"", 5, 0),
            entry("md5sum /usr/local/libexec/xrdp/xrdp-accel-assist", 5, 0),
        ];
        assert!(suggest(&entries, "exit", None, NOW, 5).is_empty());
        assert!(suggest(&entries, "sst", None, NOW, 5).is_empty());
    }

    #[test]
    fn initials_have_to_start_words_and_the_first_has_to_start_the_command() {
        let command = "docker compose logs -f";
        assert!(matches_initials(command, "dcl"));
        // Skips the command's first letter.
        assert!(!matches_initials(command, "ocl"));
        // `o` from the middle of `docker`.
        assert!(!matches_initials(command, "dol"));
        // A space ends acronym matching.
        assert!(!matches_initials(command, "d c"));
    }

    #[test]
    fn recency_decays_and_use_accumulates() {
        let entries = vec![
            entry("git push origin main", 1, 0),
            entry("git pull", 20, 365),
        ];
        // A year of decay (twelve half-lives) outweighs twenty sightings.
        assert_eq!(
            suggest(&entries, "git p", None, NOW, 2),
            vec!["git push origin main", "git pull"],
        );
    }

    #[test]
    fn an_acceptance_outweighs_a_sighting() {
        let mut plain = entry("systemctl restart nginx", 3, 0);
        let mut accepted = entry("systemctl status nginx", 1, 0);
        accepted.accepted = 1;
        plain.cwd = None;
        accepted.cwd = None;
        // 1 + 3*1 = 4 beats 3.
        assert_eq!(
            suggest(&[plain, accepted], "systemctl ", None, NOW, 1),
            vec!["systemctl status nginx"],
        );
    }

    #[test]
    fn the_directory_you_are_in_breaks_a_tie() {
        let mut here = entry("make test", 2, 0);
        here.cwd = Some("/home/dev/project".into());
        let mut elsewhere = entry("make install", 2, 0);
        elsewhere.cwd = Some("/tmp".into());
        assert_eq!(
            suggest(
                &[elsewhere, here],
                "make ",
                Some("/home/dev/project"),
                NOW,
                1
            ),
            vec!["make test"],
        );
    }

    #[test]
    fn nothing_is_suggested_for_an_empty_prompt_or_a_complete_command() {
        let entries = vec![entry("git status", 5, 0)];
        assert!(suggest(&entries, "", None, NOW, 5).is_empty());
        assert!(suggest(&entries, "   ", None, NOW, 5).is_empty());
        // Nothing left to append.
        assert!(suggest(&entries, "git status", None, NOW, 5).is_empty());
    }

    #[test]
    fn recording_the_same_command_twice_bumps_it_rather_than_duplicating_it() {
        let mut entries = Vec::new();
        assert!(record(
            &mut entries,
            "ls -la",
            None,
            HistorySource::Screen,
            NOW - DAY
        ));
        assert!(record(
            &mut entries,
            "ls -la",
            Some("/etc"),
            HistorySource::Screen,
            NOW
        ));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].count, 2);
        assert_eq!(entries[0].last_used, NOW);
        assert_eq!(entries[0].cwd.as_deref(), Some("/etc"));
    }

    #[test]
    fn a_refused_command_is_not_stored_and_says_so() {
        let mut entries = Vec::new();
        assert!(!record(
            &mut entries,
            "mysql -pHunter2",
            None,
            HistorySource::Screen,
            NOW
        ));
        assert!(entries.is_empty());
    }

    /// Running a harvested command makes it witnessed.
    #[test]
    fn provenance_moves_from_harvested_to_witnessed_but_not_back() {
        let mut entries = Vec::new();
        record(
            &mut entries,
            "make deploy",
            None,
            HistorySource::Harvest,
            NOW,
        );
        record(
            &mut entries,
            "make deploy",
            None,
            HistorySource::Integration,
            NOW,
        );
        assert_eq!(entries[0].source, HistorySource::Integration);
        record(
            &mut entries,
            "make deploy",
            None,
            HistorySource::Harvest,
            NOW,
        );
        assert_eq!(entries[0].source, HistorySource::Integration);
    }

    #[test]
    fn pruning_keeps_the_well_used_and_drops_the_one_offs() {
        let mut entries: Vec<HistoryEntry> = (0..MAX_ENTRIES_PER_HOST)
            .map(|i| entry(&format!("cmd{i}"), 1, 200))
            .collect();
        entries.push(entry("the one that matters", 500, 0));
        prune(&mut entries, NOW);
        assert_eq!(entries.len(), MAX_ENTRIES_PER_HOST);
        assert!(entries.iter().any(|e| e.command == "the one that matters"));
    }

    /// A store without `accepted` or `cwd` still parses.
    #[test]
    fn a_store_saved_without_the_optional_fields_still_parses() {
        let json = r#"{
            "version": 1,
            "hosts": {
                "dev@host:22": [
                    { "command": "ls", "count": 2, "lastUsed": 1700000000000, "source": "screen" }
                ]
            }
        }"#;
        let store: HistoryStore = serde_json::from_str(json).unwrap();
        let entries = &store.hosts["dev@host:22"];
        assert_eq!(entries[0].accepted, 0);
        assert!(entries[0].cwd.is_none());
        assert_eq!(entries[0].source, HistorySource::Screen);
    }

    // -----------------------------------------------------------------
    // Tier 1: importing a remote history file
    // -----------------------------------------------------------------

    fn harvested(payload: &str) -> Vec<(String, u32)> {
        parse_remote_history(payload).expect("payload should carry the marker")
    }

    /// The script must not contain a single quote, or the `sh -c` wrapper breaks.
    #[test]
    fn the_remote_command_survives_a_non_posix_login_shell() {
        let command = harvest_command();
        let inner = command
            .strip_prefix("/bin/sh -c '")
            .and_then(|rest| rest.strip_suffix('\''))
            .expect("wrapped in a single-quoted sh -c");
        assert!(
            !inner.contains('\''),
            "script must not contain a quote: {inner}"
        );
        assert!(inner.contains("$HOME/.bash_history"));
        assert!(inner.contains("$HOME/.zsh_history"));
        assert!(inner.contains("fish_history"));
        // Bounded remotely too.
        assert!(inner.contains("tail -n 5000"));
    }

    #[test]
    fn plain_bash_history_imports_a_command_per_line() {
        let payload = "@@WRUSTTY-HISTORY:/home/dev/.bash_history\nls -la\ncd /etc\nls -la\n";
        assert_eq!(
            harvested(payload),
            vec![("ls -la".to_string(), 2), ("cd /etc".to_string(), 1)],
        );
    }

    /// `HISTTIMEFORMAT` epoch lines aren't commands.
    #[test]
    fn bash_timestamp_lines_are_not_commands() {
        let payload = "@@WRUSTTY-HISTORY:/root/.bash_history\n#1700000000\nsystemctl status\n#1700000060\nuptime\n";
        assert_eq!(
            harvested(payload),
            vec![
                ("systemctl status".to_string(), 1),
                ("uptime".to_string(), 1)
            ],
        );
    }

    #[test]
    fn zsh_extended_metadata_is_stripped() {
        let payload = "@@WRUSTTY-HISTORY:/home/dev/.zsh_history\n\
: 1700000000:0;git status\n\
: 1700000060:12;make -j8\n";
        assert_eq!(
            harvested(payload),
            vec![("git status".to_string(), 1), ("make -j8".to_string(), 1)],
        );
    }

    /// A command starting `": "` isn't zsh metadata.
    #[test]
    fn a_command_starting_with_a_colon_is_not_mistaken_for_metadata() {
        let payload = "@@WRUSTTY-HISTORY:/home/dev/.zsh_history\n: nope;echo hi\n";
        assert_eq!(harvested(payload), vec![(": nope;echo hi".to_string(), 1)]);
    }

    /// A continued line is neither split into fragments nor stored with its
    /// newline.
    #[test]
    fn a_continued_line_is_neither_split_into_fragments_nor_stored_whole() {
        let payload =
            "@@WRUSTTY-HISTORY:/home/dev/.bash_history\nfor f in *.log; do \\\n  gzip $f\\\ndone\nls\n";
        assert_eq!(harvested(payload), vec![("ls".to_string(), 1)]);
    }

    #[test]
    fn fish_history_reads_the_cmd_lines_only() {
        let payload = "@@WRUSTTY-HISTORY:/home/dev/.local/share/fish/fish_history\n\
- cmd: nvim config.fish\n  when: 1700000000\n\
- cmd: fisher update\n  when: 1700000060\n";
        assert_eq!(
            harvested(payload),
            vec![
                ("nvim config.fish".to_string(), 1),
                ("fisher update".to_string(), 1),
            ],
        );
    }

    /// A host that ignored the command isn't an empty history.
    #[test]
    fn a_host_that_did_not_answer_is_not_an_empty_history() {
        assert!(parse_remote_history("").is_none());
        assert!(parse_remote_history("-rbash: tail: command not found\n").is_none());
        assert!(parse_remote_history("Welcome to SwitchOS v4.\nswitch> ").is_none());
        // A readable empty file is a real answer.
        assert_eq!(
            parse_remote_history("@@WRUSTTY-HISTORY:/home/dev/.bash_history\n"),
            Some(Vec::new()),
        );
    }

    /// A banner before the marker doesn't hide it.
    #[test]
    fn a_login_banner_before_the_marker_does_not_hide_it() {
        let payload =
            "*** AUTHORISED USE ONLY ***\n@@WRUSTTY-HISTORY:/home/dev/.bash_history\nhtop\n";
        assert_eq!(harvested(payload), vec![("htop".to_string(), 1)]);
    }

    /// Imports are redacted like everything else.
    #[test]
    fn credentials_in_the_history_file_are_refused_like_any_other_line() {
        let payload = "@@WRUSTTY-HISTORY:/home/dev/.bash_history\n\
mysql -uroot -pHunter2\ncurl -H \"Authorization: Bearer abc\" x\nls\n";
        assert_eq!(harvested(payload), vec![("ls".to_string(), 1)]);
    }

    #[test]
    fn a_wildly_repeated_command_cannot_dominate_the_ranking() {
        let mut payload = String::from("@@WRUSTTY-HISTORY:/home/dev/.bash_history\n");
        for _ in 0..500 {
            payload.push_str("ls\n");
        }
        assert_eq!(
            harvested(&payload),
            vec![("ls".to_string(), MAX_IMPORTED_COUNT)]
        );
    }

    #[test]
    fn importing_adds_what_is_new_and_leaves_what_was_witnessed() {
        let mut entries = vec![HistoryEntry {
            command: "make test".to_string(),
            count: 2,
            accepted: 1,
            last_used: NOW - 10 * DAY,
            source: HistorySource::Integration,
            cwd: Some("/src".to_string()),
        }];
        let added = import(
            &mut entries,
            vec![("make test".to_string(), 9), ("htop".to_string(), 3)],
            NOW,
        );
        assert_eq!(added, 1);

        let witnessed = entries.iter().find(|e| e.command == "make test").unwrap();
        // Provenance, directory and acceptance survive.
        assert_eq!(witnessed.source, HistorySource::Integration);
        assert_eq!(witnessed.cwd.as_deref(), Some("/src"));
        assert_eq!(witnessed.accepted, 1);
        // The count rises to the file's claim...
        assert_eq!(witnessed.count, 9);
        // ...but the timestamp doesn't.
        assert_eq!(witnessed.last_used, NOW - 10 * DAY);

        let imported = entries.iter().find(|e| e.command == "htop").unwrap();
        assert_eq!(imported.source, HistorySource::Harvest);
        assert_eq!(imported.count, 3);
    }

    /// Forgetting the import keeps what was witnessed.
    #[test]
    fn forgetting_the_import_leaves_only_what_was_witnessed() {
        let mut entries = Vec::new();
        record(
            &mut entries,
            "deploy prod",
            None,
            HistorySource::Integration,
            NOW,
        );
        import(
            &mut entries,
            vec![("htop".to_string(), 1), ("deploy prod".to_string(), 4)],
            NOW,
        );
        entries.retain(|e| e.source != HistorySource::Harvest);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, "deploy prod");
    }

    #[test]
    fn the_stored_shape_round_trips_under_the_names_the_frontend_reads() {
        let mut store = HistoryStore::default();
        record(
            store.hosts.entry("h".into()).or_default(),
            "ls -la",
            Some("/etc"),
            HistorySource::Integration,
            NOW,
        );
        let json = serde_json::to_string(&store).unwrap();
        assert!(json.contains("\"lastUsed\""), "{json}");
        assert!(json.contains("\"integration\""), "{json}");
        let reparsed: HistoryStore = serde_json::from_str(&json).unwrap();
        assert_eq!(reparsed.hosts["h"], store.hosts["h"]);
    }

    /// A store from before blocks existed still loads.
    #[test]
    fn a_store_from_before_blocks_still_loads() {
        let json = r#"{"version":1,"hosts":{"h":[{"command":"ls","count":1,"lastUsed":0,"source":"screen"}]}}"#;
        let store: HistoryStore = serde_json::from_str(json).unwrap();
        assert_eq!(store.hosts["h"].len(), 1);
        assert!(store.blocked.is_empty());
    }

    #[test]
    fn forgetting_one_command_blocks_it_on_that_host_only() {
        let mut store = HistoryStore::default();
        for host in ["a", "b"] {
            record(
                store.hosts.entry(host.into()).or_default(),
                "rm -rf build",
                None,
                HistorySource::Integration,
                NOW,
            );
        }
        store.forget_and_block("a", "rm -rf build");
        assert!(!store.hosts.contains_key("a"));
        assert!(store.is_blocked("a", "rm -rf build"));
        assert!(!store.is_blocked("b", "rm -rf build"));
        assert_eq!(store.hosts["b"].len(), 1);

        store.forget_and_block("a", "rm -rf build");
        assert_eq!(store.blocked["a"].len(), 1);
    }

    #[test]
    fn allowing_again_lifts_the_block_and_restores_nothing() {
        let mut store = HistoryStore::default();
        record(
            store.hosts.entry("a".into()).or_default(),
            "make deploy",
            None,
            HistorySource::Integration,
            NOW,
        );
        store.forget_and_block("a", "make deploy");
        store.allow("a", "make deploy");
        assert!(!store.is_blocked("a", "make deploy"));
        assert!(store.blocked.is_empty());
        // Learned again from scratch.
        assert!(store.hosts.is_empty());
    }

    #[test]
    fn forgetting_a_host_or_everything_takes_the_blocks_too() {
        let mut store = HistoryStore::default();
        store.forget_and_block("a", "one");
        store.forget_and_block("b", "two");
        store.forget_host("a");
        assert!(!store.is_blocked("a", "one"));
        assert!(store.is_blocked("b", "two"));
        store.forget_all();
        assert!(store.blocked.is_empty());
    }
}
