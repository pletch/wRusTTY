//! Recent-command history — the store autocomplete suggests from.
//!
//! docs/AUTOCOMPLETE_PLAN.md. Filled from two directions: a host with shell
//! integration reports its own command lines verbatim through OSC 633 `E`
//! (`HistorySource::Integration`), and one without has its prompt line read off
//! the terminal grid when Enter is pressed (`HistorySource::Screen`). The third
//! is a one-off import of the remote shell's own history file over an `exec`
//! channel (`HistorySource::Harvest`), which is the only one that reads
//! anything on the far side and is gated on its own setting because of it.
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
    /// Commands the user has said never to suggest, per host, newest last.
    ///
    /// Forgetting one command lands it here, so a forget is permanent rather
    /// than lasting until the next harvest re-imports the line or the next run
    /// re-records it — either of which would make the delete look broken. A
    /// block is lifted only explicitly ("Allow again"), never by time or use.
    ///
    /// Exact, normalised command text: the same form `redact` stores, so a
    /// lookup is a string comparison and needs no idea of what a command means.
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

    /// Lift a block. Nothing is restored — the command was deleted when it was
    /// blocked — so it is learned again from scratch, the next time it is run
    /// or imported.
    pub fn allow(&mut self, host: &str, command: &str) {
        if let Some(commands) = self.blocked.get_mut(host) {
            commands.retain(|c| c != command);
        }
        self.drop_empty_hosts();
    }

    /// Forget a host entirely, blocks included. A block list is itself a list
    /// of commands typed on that host, so "forget this host" leaving it behind
    /// would not be forgetting.
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
    Initials = 2,
}

/// Whether `needle`'s characters all appear in `haystack`, in order — the
/// fuzzy fallback, so `gcm` can reach `git commit -m`.
/// Characters that end a word, so the next one starts a new one.
const WORD_BOUNDARIES: &[char] = &[
    ' ', '\t', '-', '_', '/', '.', ':', '=', ',', ';', '|', '&', '"', '\'', '(', '[', '{', '$',
];

/// Whether `needle` is the sequence of *word initials* of `haystack`, starting
/// at its very first character — so `gcm` reaches `git commit -m`.
///
/// This replaced a plain subsequence test, which was far too loose to be
/// useful and produced exactly the failure it was meant to avoid. A command
/// line is long and full of common letters, so almost any short input matched
/// almost everything: typing `exit` matched
/// `/home/dev/Repos/xrdp/xrdp_accel_assist/...` (the `e` of *home*, the `x` of
/// *xrdp*, an `i` and a `t` from *assist*), and with no real prefix hits to
/// outrank them the whole list was noise. A suggestion list that answers
/// something other than what was typed is worse than an empty one.
///
/// Two rules keep it predictable. Every matched character has to begin a word,
/// and the first one has to begin the *command* — so whatever is offered
/// always starts with the letter that was typed.
fn matches_initials(command_lower: &str, needle_lower: &str) -> bool {
    // Once a space has been typed the input is a command line being written,
    // not an acronym, and matching initials across it invites nonsense.
    if needle_lower.is_empty() || needle_lower.contains(' ') {
        return false;
    }
    let mut needle = needle_lower.chars().peekable();
    if command_lower.chars().next() != needle.peek().copied() {
        return false;
    }
    let mut previous: Option<char> = None;
    for current in command_lower.chars() {
        // `is_none_or` would read better and postdates this crate's MSRV.
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
    if matches_initials(&command_lower, typed_lower) {
        return Some(MatchRank::Initials);
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
            // Checked against the normalised form, which is what a block holds.
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
            // A host can have blocks and nothing else — every command it had was
            // forgotten — and still needs a row, or there is no way back.
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

/// Drop one command, or one host's worth, or everything — `command` narrows
/// `host`, and no `host` means all of them. A single command is also blocked
/// from coming back; see [`HistoryStore::blocked`].
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

// ---------------------------------------------------------------------------
// Tier 1: importing the remote shell's own history
// ---------------------------------------------------------------------------

/// Lines asked for from the remote history file. High enough to cover a real
/// working history, low enough that the reply stays small on a slow link.
const HARVEST_LINES: usize = 5_000;

/// Hard cap on the reply, whatever the line count implies. A `HISTFILE`
/// pointing at something enormous — or a host that answers with a stream
/// rather than a file — must not be able to make this app read forever.
pub const HARVEST_MAX_BYTES: usize = 1_024 * 1_024;

/// How long the remote gets. Generous for `tail` on a file, short enough that
/// a host which accepts the channel and then says nothing is given up on
/// rather than left hanging behind a spinner nobody sees.
pub const HARVEST_TIMEOUT_SECS: u64 = 10;

/// The most an imported command may claim to have been run.
///
/// A history file will happily say `ls` appears 400 times, and taking that at
/// face value would let one import outrank everything the user actually does
/// in front of us for months. Capping keeps frequency as a *signal* without
/// letting it become the only one.
const MAX_IMPORTED_COUNT: u32 = 25;

/// Marks the start of a real answer, so a host that ignored the command and
/// printed its own banner can be told from one that answered.
const HARVEST_MARKER: &str = "@@WRUSTTY-HISTORY:";

/// The command sent down the `exec` channel.
///
/// Wrapped in `/bin/sh -c` deliberately. `exec` runs the request through the
/// user's *login* shell, which may be fish — whose syntax is not POSIX and
/// which would choke on the `case` below. Every shell there is can parse a
/// simple command with one single-quoted argument, so the wrapper is what
/// makes one script work everywhere. The script itself therefore contains no
/// single quote of its own.
///
/// It asks the shell rather than guessing a path, because the file is both
/// shell- and configuration-dependent: `HISTFILE` overrides everything, and
/// `$SHELL` is what sshd sets from the account's entry. And it `tail`s rather
/// than `cat`s, because the interesting end of a history file is the end.
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

/// Which on-disk format a history file is in, decided by its name — which is
/// the only evidence available, and is reliable because the name came from the
/// same `case` that chose it by shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryFormat {
    /// One command per line. `HISTTIMEFORMAT` adds `#<epoch>` lines between.
    Plain,
    /// zsh's extended format: `: <epoch>:<elapsed>;<command>`, with a trailing
    /// backslash continuing onto the next line.
    Zsh,
    /// fish's YAML-ish store: `- cmd: <command>` followed by `  when: <epoch>`.
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

/// Turn what the remote printed into commands and how often each appeared.
///
/// `None` means the host did not answer the question — no marker, so what came
/// back is a banner, a restricted shell's complaint, or an appliance's own CLI.
/// Treating that as an empty history would be wrong in a way that matters: it
/// would look like a successful import of nothing, and never be retried.
///
/// Counts rather than timestamps. Only zsh and fish record when a command ran,
/// and bash usually does not, so there is no honest per-entry time to import —
/// but "this appears forty times" is real information present in every format,
/// and it is what makes an imported history rank sensibly on arrival.
pub fn parse_remote_history(payload: &str) -> Option<Vec<(String, u32)>> {
    // The marker is written with `printf` and normally lands at the very
    // start, but a login banner or an rc file that prints will push it down.
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
            // A command continued onto the next line with a trailing
            // backslash is one command, and importing its halves separately
            // would offer back two fragments that do nothing. Joined, it then
            // fails `redact` for containing a newline — which is also right:
            // accepting a suggestion with a newline in it would *submit* a
            // half-finished command line. The join is here to stop the
            // fragments, not to preserve the whole.
            let mut pending: Option<String> = None;
            for line in body.lines() {
                let line = line.strip_suffix('\r').unwrap_or(line);
                let piece = match pending.take() {
                    Some(started) => format!("{started}\n{line}"),
                    None => {
                        if format == HistoryFormat::Zsh {
                            strip_zsh_prefix(line).to_string()
                        } else if line.starts_with('#') {
                            // bash writes `#<epoch>` between entries when
                            // HISTTIMEFORMAT is set. A real command can start
                            // with `#` only as a comment, which is not worth
                            // suggesting either way.
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

/// Strips zsh's `: <epoch>:<elapsed>;` metadata, leaving the command.
/// A line without it is a plain entry, which zsh also writes when
/// `EXTENDED_HISTORY` is off.
fn strip_zsh_prefix(line: &str) -> &str {
    let Some(rest) = line.strip_prefix(": ") else {
        return line;
    };
    let Some((meta, command)) = rest.split_once(';') else {
        return line;
    };
    // Only when the part before the `;` really is `<digits>:<digits>`.
    // Otherwise this is an ordinary command that happens to start with a colon
    // and a space, and eating up to its first semicolon would mangle it.
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

/// Fold an imported history into a host's entries.
///
/// Everything lands as [`HistorySource::Harvest`] so that "forget imported
/// history" can take exactly this back out again, and an entry that already
/// exists keeps whatever provenance it had — a command we have actually
/// watched the user run is not turned back into an import.
pub fn import(entries: &mut Vec<HistoryEntry>, imported: Vec<(String, u32)>, now_ms: i64) -> usize {
    let mut added = 0;
    for (command, count) in imported {
        match entries.iter_mut().find(|e| e.command == command) {
            // Already known. The import is not evidence of a *new* use, so the
            // count rises only if the file claims more, and the timestamp is
            // not touched at all — the file cannot say when it was last run,
            // and overwriting a real `last_used` with "now" would make every
            // stale command look fresh.
            Some(existing) => existing.count = existing.count.max(count),
            None => {
                added += 1;
                entries.push(HistoryEntry {
                    command,
                    count,
                    accepted: 0,
                    // The import time, not a fabricated one. Only zsh and fish
                    // record when a command ran and bash usually does not, so
                    // there is no honest per-entry time to use — and inventing
                    // a spread of them would put made-up data in the ranking.
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

/// Import a host's own shell history, over one `exec` channel on the
/// connection that is already up.
///
/// **The setting is resolved before the channel is opened, and that ordering
/// is the point.** A harvest that runs and then discards its answer has still
/// opened a channel, still read the file, and still appeared in whatever the
/// host logs — so the decision has to be made before the channel exists, not
/// after the bytes arrive. The caller has already checked that autocomplete
/// itself is on; the harvest's own setting and the saved session's override
/// of it are resolved below. See the Tier 1 section of
/// docs/AUTOCOMPLETE_PLAN.md.
///
/// Returns how many commands were newly added — zero when the host has no
/// readable history, when everything in it was already known, or when the
/// answer was refused. `Err` only for a session that is not connected; a host
/// that will not or cannot answer is an ordinary outcome, not a failure to
/// report, and it must never be retried for the rest of the session.
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
    // Resolved here rather than in the webview because the per-host half lives
    // in `sessions.json`, and splitting one decision across two processes is
    // how the halves come to disagree.
    //
    // The saved session's answer wins outright when it has one, which is
    // *unlike* how auto-reconnect resolves its two halves (there, either
    // saying no is no). Deliberate: auto-reconnect's global switch is the one
    // place someone turns a behaviour off everywhere, so it has to be able to.
    // This one is off by default, so a per-host `true` is the entire point of
    // the override — it is how a read is allowed on your own machine without
    // being allowed on every machine you happen to log into.
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

    // Lossy on purpose. A history file is whatever bytes the shell appended to
    // it, and one line of Latin-1 from years ago must not cost the import
    // every other line in the file. Anything undecodable becomes U+FFFD and is
    // then almost certainly refused by `redact` as a control-free but
    // nonsensical line — which is the right outcome for a line nobody can read.
    let payload = String::from_utf8_lossy(&output);
    let Some(imported) = parse_remote_history(&payload) else {
        // No marker: the host ignored the command and printed something of its
        // own — a banner, a restricted shell's complaint, an appliance's CLI.
        // Reported as zero rather than an error, because there is nothing the
        // user can act on and nothing has gone wrong with their session.
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
    fn an_exact_prefix_beats_a_better_scoring_initials_match() {
        let entries = vec![entry("git status", 1, 0), entry("git commit -m x", 50, 0)];
        // `gcm` reaches the second by its word initials; typing it out reaches
        // the first by prefix. Rank is ordered above score, so the prefix hit
        // wins despite fifty times the weight — the top suggestion stays
        // predictable from what was typed.
        assert_eq!(
            suggest(&entries, "gcm", None, NOW, 1),
            vec!["git commit -m x"]
        );
        assert_eq!(suggest(&entries, "git s", None, NOW, 5), vec!["git status"]);
    }

    /// The bug this rule exists to prevent, from a real screenshot: typing
    /// `exit` offered a screenful of unrelated commands, because a plain
    /// subsequence test found `e`, `x`, `i` and `t` scattered through long
    /// paths. A command line is long and full of common letters, so almost any
    /// short input matched almost everything — and with no prefix hits to
    /// outrank them, the entire list was noise.
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
        // Nor do the odd letters of a path pull in a match that starts
        // somewhere other than where the user's own typing does.
        assert!(suggest(&entries, "sst", None, NOW, 5).is_empty());
    }

    #[test]
    fn initials_have_to_start_words_and_the_first_has_to_start_the_command() {
        let command = "docker compose logs -f";
        assert!(matches_initials(command, "dcl"));
        // `ocl` skips the command's own first letter, so whatever is offered
        // would not begin with what was typed.
        assert!(!matches_initials(command, "ocl"));
        // `dol` takes its `o` from the middle of `docker`, not the start of a
        // word.
        assert!(!matches_initials(command, "dol"));
        // Once a space is typed the input is a command line being written, not
        // an acronym.
        assert!(!matches_initials(command, "d c"));
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

    /// The one-liner runs through whatever login shell the account has, and
    /// fish is not POSIX. The `/bin/sh -c '...'` wrapper is what makes one
    /// script work everywhere — which only holds while the script itself
    /// contains no single quote to close the wrapper early.
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
        // Bounded at the far end as well as this one.
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

    /// With `HISTTIMEFORMAT` set, bash writes an epoch line before each entry.
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

    /// A command that genuinely begins `": "` must not have its own text eaten
    /// up to the first semicolon.
    #[test]
    fn a_command_starting_with_a_colon_is_not_mistaken_for_metadata() {
        let payload = "@@WRUSTTY-HISTORY:/home/dev/.zsh_history\n: nope;echo hi\n";
        assert_eq!(harvested(payload), vec![(": nope;echo hi".to_string(), 1)]);
    }

    /// A continued line is joined, and the join is then refused as a whole.
    /// That is the right answer twice over: importing the halves separately
    /// would offer back fragments that do nothing on their own, and importing
    /// the join would store a command containing a newline — *accepting* which
    /// would send the newline and submit a half-finished command line. The
    /// join exists to stop the fragments, not to preserve the whole.
    #[test]
    fn a_continued_line_is_neither_split_into_fragments_nor_stored_whole() {
        let payload =
            "@@WRUSTTY-HISTORY:/home/dev/.bash_history\nfor f in *.log; do \\\n  gzip $f\\\ndone\nls\n";
        // Only the single-line command survives — no `for f in *.log; do`, no
        // bare `done`, and nothing carrying a newline.
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

    /// A host that ignored the command entirely — a banner, a restricted
    /// shell, an appliance's own CLI. Distinct from an empty history, because
    /// "imported nothing successfully" would never be retried.
    #[test]
    fn a_host_that_did_not_answer_is_not_an_empty_history() {
        assert!(parse_remote_history("").is_none());
        assert!(parse_remote_history("-rbash: tail: command not found\n").is_none());
        assert!(parse_remote_history("Welcome to SwitchOS v4.\nswitch> ").is_none());
        // ...whereas a readable file with nothing in it is a real answer.
        assert_eq!(
            parse_remote_history("@@WRUSTTY-HISTORY:/home/dev/.bash_history\n"),
            Some(Vec::new()),
        );
    }

    /// The marker is printed first, but a login banner or a chatty rc file
    /// gets there before it.
    #[test]
    fn a_login_banner_before_the_marker_does_not_hide_it() {
        let payload =
            "*** AUTHORISED USE ONLY ***\n@@WRUSTTY-HISTORY:/home/dev/.bash_history\nhtop\n";
        assert_eq!(harvested(payload), vec![("htop".to_string(), 1)]);
    }

    /// Redaction is not something the import gets to skip: a history file is
    /// exactly where a password typed on a command line a year ago still
    /// lives.
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
        // Provenance, directory and acceptance all survive: this is a command
        // we watched the user run, and an import must not demote it.
        assert_eq!(witnessed.source, HistorySource::Integration);
        assert_eq!(witnessed.cwd.as_deref(), Some("/src"));
        assert_eq!(witnessed.accepted, 1);
        // The count rises to what the file claims...
        assert_eq!(witnessed.count, 9);
        // ...but the timestamp does not, or every stale command in the file
        // would come back looking like it was run a moment ago.
        assert_eq!(witnessed.last_used, NOW - 10 * DAY);

        let imported = entries.iter().find(|e| e.command == "htop").unwrap();
        assert_eq!(imported.source, HistorySource::Harvest);
        assert_eq!(imported.count, 3);
    }

    /// The other half of the harvest's separate consent: turning the setting
    /// off has to be able to undo what it did, without touching anything the
    /// user actually ran in front of us.
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

    /// A store written before blocks existed still loads, rather than being
    /// discarded as unparseable — which `read_store` would do silently.
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

        // Forgetting twice does not list it twice.
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
        // Learned again from scratch, not brought back.
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
