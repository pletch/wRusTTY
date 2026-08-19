//! Recent-command history — the store autocomplete suggests from.
//!
//! docs/AUTOCOMPLETE_PLAN.md. Filled from two directions: a host with shell
//! integration reports its own command lines verbatim through OSC 633 `E`
//! (`HistorySource::Integration`), and one without has its prompt line read off
//! the terminal grid when Enter is pressed (`HistorySource::Screen`). The third
//! source, a one-off import of the remote shell's own history file, is Phase 6
//! and not built.
//!
//! **Why the ranking lives here rather than in the webview.** Suggesting runs
//! on every keystroke, so the obvious design ships each host's entries to the
//! frontend once and ranks them there, saving an IPC round trip per character.
//! That trip is worth paying. It keeps every command the user has ever run out
//! of the webview — the process that also renders untrusted remote output —
//! and hands it only the two or three strings actually about to be shown. It
//! also leaves the door open to the vault-encrypted store the plan is still
//! deciding on, without changing this API. Keystrokes arrive at human speed
//! against an in-memory map; the trip is not the expensive part of anything.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// Bumped only for a change the previous version cannot read. Additive fields
/// are `#[serde(default)]` instead, exactly as `sessions.json` handles them.
const STORE_VERSION: u32 = 1;

/// Entries kept per host before the lowest-scoring are dropped. A shell's own
/// `HISTSIZE` is typically 1,000–10,000; this sits at the top of that so a
/// harvest is not immediately truncated, and it bounds both the file and the
/// per-keystroke scan.
const MAX_ENTRIES_PER_HOST: usize = 5_000;

/// Longer than this is not a command anyone will want suggested back — it is a
/// pasted script, a base64 blob, or a line that wrapped a terminal several
/// times. Dropped rather than truncated: half a command is worse than none,
/// because accepting it would send something the user never ran.
const MAX_COMMAND_LEN: usize = 2_048;

/// Where an entry came from. Kept per entry because the Tier 1 harvest is
/// separately consented to (see the plan's Tier 1 section), and withdrawing
/// that consent has to be able to drop exactly what the harvest imported
/// without touching what the user typed in front of us.
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
    /// Times this command has been seen. Not a usage *log* — one entry per
    /// distinct command, so the store never grows with repetition and never
    /// records when any individual run happened.
    pub count: u32,
    /// Times it was accepted from a suggestion, which is a stronger signal
    /// than merely having been typed: it says the suggestion was the thing
    /// the user actually wanted, in the position autocomplete offered it.
    #[serde(default)]
    pub accepted: u32,
    /// Epoch milliseconds of the most recent sighting.
    pub last_used: i64,
    pub source: HistorySource,
    /// The directory it was last run in, when the host reports one (OSC 7).
    /// One directory rather than a set: the ranking only asks "was this last
    /// used where I am now", and a set would turn a bounded entry into one
    /// that grows for every place a common command was ever run.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// The whole store: entries grouped by an opaque host key the frontend
/// chooses (`user@host:port`), so a rename of that scheme is a frontend
/// change and nothing here has to know how a host is identified.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStore {
    pub version: u32,
    #[serde(default)]
    pub hosts: BTreeMap<String, Vec<HistoryEntry>>,
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            hosts: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Argument prefixes whose *value* is a secret, so the line carrying them is
/// dropped whole. Matched against whitespace-separated words, case-insensitively.
///
/// Dropping the line rather than masking the value is deliberate. A masked
/// command is still a suggestion, so accepting it would send `--password=****`
/// to a shell — a command that looks right, runs, and fails. And masking
/// assumes the parse was correct; dropping only assumes it was suspicious.
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

/// Whether a word looks like a credential in its own right — a long run of
/// token alphabet with the mix of cases and digits that random material has
/// and English does not.
///
/// Deliberately conservative in one direction only: it will miss secrets that
/// look like words, and it must not fire on ordinary arguments. Real paths and
/// flags fail it on length, on alphabet, or on the mixed-case-and-digits test
/// — `/var/log/nginx/access.log` has no digits and no uppercase,
/// `--reconnect-max-seconds` is one case, and a git SHA is one case too.
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
    // A path is the false positive to beat, and a long one clears every other
    // test here — so anything carrying a separator is treated as a path and
    // left alone. Costs us tokens that contain a dot (a JWT, for one), which
    // the substring list catches by the header they travel under instead.
    if body.contains('/') || body.contains('.') {
        return false;
    }
    let has_upper = body.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = body.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = body.chars().any(|c| c.is_ascii_digit());
    has_upper && has_lower && has_digit
}

/// Normalise a command for storage, or refuse it.
///
/// `None` means "do not store this line at all" — it was empty, absurdly long,
/// carried control characters, or looked like it contained a credential. The
/// caller stores nothing; there is no partial form.
pub fn redact(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COMMAND_LEN {
        return None;
    }
    // A command with a control character in it never came from someone typing
    // at a prompt — it is a stray escape sequence that survived reconstruction,
    // and storing it risks suggesting bytes that would be *interpreted* rather
    // than typed when accepted. Tab is included: a real command line has none,
    // because Tab at a prompt is completion rather than a character.
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
            // `-p` is the one that needs care: bare `-p` is a flag on a dozen
            // harmless commands (`mkdir -p`, `ssh -p 22`, `cp -p`), and only
            // `-p` with a value *attached* is mysql's password form. The
            // separated `mysql -p Hunter2` spelling does not exist — mysql
            // reads an attached value or prompts — so this is exact.
            if *prefix == "-p" && word.len() == 2 {
                continue;
            }
            return None;
        }
    }
    if trimmed.split_whitespace().any(looks_like_token) {
        return None;
    }
    // Every real command contains a letter or a digit somewhere. A line with
    // none is not one — and the case this actually catches is a password
    // prompt that masks each character with `*` or a bullet rather than
    // echoing nothing at all. Passive capture (see Terminal.tsx) checks that
    // everything typed showed up, which a masking prompt satisfies exactly,
    // so this is the check that stops `********` being stored as a command.
    if !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/// How long it takes an unused command's weight to halve. Thirty days is long
/// enough that a monthly chore survives to its next outing, and short enough
/// that the shape of what you are working on this month wins over what you
/// were working on last year.
const HALF_LIFE_DAYS: f64 = 30.0;
const MS_PER_DAY: f64 = 86_400_000.0;

/// An acceptance is worth this many sightings. Above 1 because it is the only
/// signal that says the suggestion was *right*, and it is the one the ranking
/// most wants to reinforce.
const ACCEPT_WEIGHT: f64 = 3.0;

/// Multiplier for an entry last used in the directory the prompt is in now.
const CWD_MATCH_BONUS: f64 = 1.5;

/// Frecency: how much the entry has been used, decayed by how long ago, with a
/// nudge for having been used where we are standing.
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

/// How well a candidate matches what has been typed. Lower is better, and the
/// ranks are strictly ordered rather than blended into the score: a
/// worse-scoring exact prefix must still beat a better-scoring fuzzy hit, or
/// the top suggestion stops being predictable from what you typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchRank {
    Prefix = 0,
    PrefixIgnoringCase = 1,
    Subsequence = 2,
}

/// Whether `needle`'s characters all appear in `haystack`, in order — the
/// fuzzy fallback, so `gcm` can reach `git commit -m`.
fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = haystack.chars();
    needle.chars().all(|want| chars.any(|have| have == want))
}

fn match_rank(command: &str, typed: &str, typed_lower: &str) -> Option<MatchRank> {
    // Never offer what is already typed, and never offer something that would
    // delete characters — accepting a suggestion only ever appends.
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
    if is_subsequence(typed_lower, &command_lower) {
        return Some(MatchRank::Subsequence);
    }
    None
}

/// The best `limit` completions of `typed`, best first.
///
/// Empty when `typed` is empty: a bare prompt has nothing to complete, and a
/// list of everything there is a menu rather than a suggestion.
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
    // Rank first, score descending within it, then the command itself so that
    // two entries with identical scores come out in a stable order rather than
    // one that depends on how the map happened to be laid out.
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

/// Fold a command into a host's entries, redacting first.
///
/// Returns whether anything was stored, so a caller can tell "recorded" from
/// "refused" — the store-nothing path is the common one for password prompts
/// and is not an error.
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
            // A command first seen in a harvest and then actually run is no
            // longer merely imported, and must survive "forget imported
            // history". Provenance only ever moves towards what we witnessed.
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

/// Note that a suggestion was taken, which weighs more than a sighting.
/// Silently does nothing for a command that is not stored — the accepted
/// command always is, but the store may have been cleared between the
/// suggestion and the acceptance.
pub fn record_accepted(entries: &mut [HistoryEntry], command: &str) {
    if let Some(entry) = entries.iter_mut().find(|e| e.command == command) {
        entry.accepted = entry.accepted.saturating_add(1);
    }
}

/// Hold a host to `MAX_ENTRIES_PER_HOST`, dropping the lowest-scoring first.
/// Scored rather than oldest-first so a command used constantly for a year
/// outlives a hundred one-offs typed yesterday.
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

/// The store, held in memory between writes.
///
/// Unlike `ProfileState`, which locks a file and re-reads it each time, this
/// caches: `suggest` runs per keystroke and cannot go to disk for it. The file
/// is still the source of truth across launches, and every mutation writes it
/// through before returning, so a crash loses nothing that was acknowledged.
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

/// A store that won't parse is replaced rather than reported. This file is a
/// cache of conveniences, not user data anyone can recreate by hand, and
/// refusing to start autocomplete forever because one write was interrupted
/// mid-upgrade is a worse failure than losing suggestions once.
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

/// One host's stored commands, for the Settings list. Carries the host key so
/// the frontend can group and delete without a second call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHistory {
    pub host: String,
    pub entries: Vec<HistoryEntry>,
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

/// Everything stored, for the Settings list — the "visible way to read it"
/// the plan requires of anything that remembers what you typed.
#[tauri::command]
pub async fn command_history_list(
    app: AppHandle,
    state: tauri::State<'_, HistoryState>,
) -> Result<Vec<HostHistory>, String> {
    state
        .with_store(&app, |store| {
            let now = now_ms();
            let listed = store
                .hosts
                .iter()
                .map(|(host, entries)| {
                    let mut entries = entries.clone();
                    entries.sort_by(|a, b| {
                        score(b, now, None)
                            .total_cmp(&score(a, now, None))
                            .then_with(|| a.command.cmp(&b.command))
                    });
                    HostHistory {
                        host: host.clone(),
                        entries,
                    }
                })
                .collect();
            Ok((listed, false))
        })
        .await
}

/// Drop one command, or one host's worth, or everything — `command` narrows
/// `host`, and no `host` means all of them.
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
                (None, _) => store.hosts.clear(),
                (Some(host), None) => {
                    store.hosts.remove(&host);
                }
                (Some(host), Some(command)) => {
                    if let Some(entries) = store.hosts.get_mut(&host) {
                        entries.retain(|e| e.command != command);
                    }
                }
            }
            store.hosts.retain(|_, entries| !entries.is_empty());
            Ok(((), true))
        })
        .await
}

/// Drop everything a Tier 1 harvest imported, leaving what was witnessed.
/// The other half of the harvest's separate consent: turning the setting off
/// should be able to undo what it did.
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
            "ssh -p 2222 tim@example.com",
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

    /// The `-p` rule is the one most likely to be got wrong in either
    /// direction, so both directions are pinned.
    #[test]
    fn bare_dash_p_is_a_flag_and_attached_dash_p_is_a_password() {
        assert!(redact("mkdir -p one/two").is_some());
        assert!(redact("mysqldump -pS3cret db").is_none());
    }

    /// What a masking password prompt puts on the screen. Passive capture
    /// cannot tell this from a command by echo alone — every character typed
    /// did appear — so the store is the thing that has to refuse it.
    #[test]
    fn a_line_of_mask_characters_is_not_a_command() {
        assert_eq!(redact("********"), None);
        assert_eq!(redact("\u{2022}\u{2022}\u{2022}\u{2022}"), None);
        assert_eq!(redact("...."), None);
        // ...but a real command made mostly of punctuation still is one.
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
    fn an_exact_prefix_beats_a_better_scoring_fuzzy_match() {
        let entries = vec![entry("git status", 1, 0), entry("grep -ri todo src", 50, 0)];
        // Both match: a prefix of the first, and — less obviously — a
        // subsequence of the second, whose letters really do appear in order
        // (g-rep -r*i* *t*odo *s*rc). The fuzzy hit carries fifty times the
        // weight and still comes second, which is the whole point: rank is
        // ordered above score, so the top suggestion stays predictable from
        // what was typed.
        assert_eq!(
            suggest(&entries, "git s", None, NOW, 5),
            vec!["git status", "grep -ri todo src"],
        );
    }

    #[test]
    fn recency_decays_and_use_accumulates() {
        let entries = vec![
            entry("git push origin main", 1, 0),
            entry("git pull", 20, 365),
        ];
        // Used once today versus twenty times a year ago: the year of decay
        // (twelve half-lives) is worth more than the twenty sightings.
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
        here.cwd = Some("/home/tim/project".into());
        let mut elsewhere = entry("make install", 2, 0);
        elsewhere.cwd = Some("/tmp".into());
        assert_eq!(
            suggest(
                &[elsewhere, here],
                "make ",
                Some("/home/tim/project"),
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
        // Already typed in full: there is nothing left to append.
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

    /// Running a harvested command for real makes it ours, so that forgetting
    /// the import doesn't take it away.
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

    /// The file is a compatibility surface like `sessions.json`: a store
    /// written by a version that had no `accepted` or `cwd` still parses.
    #[test]
    fn a_store_saved_without_the_optional_fields_still_parses() {
        let json = r#"{
            "version": 1,
            "hosts": {
                "tim@host:22": [
                    { "command": "ls", "count": 2, "lastUsed": 1700000000000, "source": "screen" }
                ]
            }
        }"#;
        let store: HistoryStore = serde_json::from_str(json).unwrap();
        let entries = &store.hosts["tim@host:22"];
        assert_eq!(entries[0].accepted, 0);
        assert!(entries[0].cwd.is_none());
        assert_eq!(entries[0].source, HistorySource::Screen);
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
}
