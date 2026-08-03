//! Host-key trust-on-first-use (TOFU) store. Deliberately not delegated to
//! `russh`'s built-in `known_hosts` helpers: we want full control over the
//! prompt/accept/reject flow (surfaced through the UI, not auto-trusted —
//! unlike r-shell, whose `check_server_key` unconditionally returns `Ok(true)`)
//! and a format we can unit-test without touching the filesystem convention
//! OpenSSH uses.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use russh::keys::ssh_key::HashAlg;
use russh::keys::PublicKey;

/// Temp-file-plus-rename write, owner-only on Unix. A crash or power loss
/// mid-write could otherwise leave a truncated/empty known_hosts file,
/// silently resetting the host-key trust anchor and reopening a MITM window
/// on the next connect. See `wr_fs` for the full reasoning.
use wr_fs::write_atomic as atomic_write;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// No entry for this host — first connection, or the entry was removed.
    Unknown,
    /// Entry exists and matches the offered key.
    Trusted,
    /// Entry exists but the offered key is different. Never auto-accept
    /// this: it's either a reprovisioned host or an active MITM.
    Changed { stored_fingerprint: String },
}

/// One stored host key, as the management UI needs to show it.
///
/// `algorithm` and `fingerprint` are optional because a line that will not
/// parse still has to be *listable*: those are precisely the entries that pin a
/// host to `Changed` forever, so a UI that could only show the well-formed ones
/// would hide the only entries a user urgently needs to delete.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: Option<String>,
    pub fingerprint: Option<String>,
    /// The stored line itself, and the identifier `forget` takes.
    ///
    /// A fingerprint would be the natural id and is wrong here for the same
    /// reason as above: an unparseable entry has none. The raw text is exact,
    /// works for every entry, and is what actually has to be removed from the
    /// file.
    pub key_text: String,
}

pub struct KnownHostsStore {
    path: PathBuf,
    /// One entry *per key algorithm* per `host:port`, matching what OpenSSH
    /// does — a server offers a different host key depending on the
    /// negotiated `HostKeyAlgorithms`, so a single stored key per host means
    /// any shift in that negotiation (a russh version bump reordering its
    /// preference list, a server config change, a load-balanced host)
    /// surfaces as `Changed`, i.e. as "possible MITM". A user who is shown
    /// that dialog once for a benign reason is a user who clicks through the
    /// next one, so a false positive here costs more than it looks like.
    entries: HashMap<String, Vec<String>>,
}

impl KnownHostsStore {
    /// Loads the store from `path`, creating an empty in-memory store if the
    /// file doesn't exist yet (it's created on first `learn`).
    pub fn load(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        let mut entries: HashMap<String, Vec<String>> = HashMap::new();

        match std::fs::read_to_string(&path) {
            Ok(contents) => {
                for line in contents.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((id, key_text)) = line.split_once(' ') {
                        // Normalising on read rather than only on write means
                        // entries written before `host_id` lowercased don't
                        // reprompt as `Unknown` on the next connect. The id is
                        // `host:port`, so lowercasing the whole string is the
                        // same as lowercasing the host — digits are unaffected.
                        entries
                            .entry(id.to_ascii_lowercase())
                            .or_default()
                            .push(key_text.to_string());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }

        Ok(Self { path, entries })
    }

    /// `Changed` means "we hold a key of this algorithm for this host and the
    /// offered one differs" — not "we hold some key and it differs". Holding
    /// an Ed25519 key and being offered an RSA one is `Unknown`: nothing is
    /// contradicted, there is simply no prior trust for that algorithm, and
    /// the prompt the user sees should say so.
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
        let id = host_id(host, port);
        let Some(stored) = self.entries.get(&id) else {
            return HostKeyStatus::Unknown;
        };

        let mut same_algorithm: Option<PublicKey> = None;
        let mut saw_unparseable = false;

        for text in stored {
            match PublicKey::from_openssh(text) {
                Ok(stored_key) if &stored_key == key => return HostKeyStatus::Trusted,
                Ok(stored_key) if stored_key.algorithm() == key.algorithm() => {
                    same_algorithm = Some(stored_key)
                }
                Ok(_) => {}
                Err(_) => saw_unparseable = true,
            }
        }

        match same_algorithm {
            Some(stored_key) => HostKeyStatus::Changed {
                stored_fingerprint: fingerprint(&stored_key),
            },
            // A corrupted entry could be the one that would have matched, so
            // it can't be treated as "no key of this algorithm" and quietly
            // relearned over. Fail closed, as before.
            None if saw_unparseable => HostKeyStatus::Changed {
                stored_fingerprint: "<unparseable stored entry>".to_string(),
            },
            None => HostKeyStatus::Unknown,
        }
    }

    /// Records `key` as trusted for `host:port`, replacing any previous entry
    /// *of the same algorithm* and leaving the host's other algorithms alone,
    /// then persists the store to disk.
    pub fn learn(&mut self, host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
        let id = host_id(host, port);
        let key_text = key
            .to_openssh()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        // Re-read before writing, because this store is not the only writer.
        // Every connector loads its own copy, and the management UI has a third
        // — so persisting from a copy loaded minutes ago would rewrite the whole
        // file from stale state and resurrect a key the user had just deleted.
        // A trust anchor that comes back from the dead is exactly the failure
        // this file exists to prevent.
        self.reload();

        let stored = self.entries.entry(id).or_default();
        // An unparseable entry has no knowable algorithm, so it can't be
        // matched against this key's — dropping it here is what stops a
        // corrupt line pinning the host to `Changed` forever once the user
        // has explicitly accepted a key.
        stored.retain(|text| match PublicKey::from_openssh(text) {
            Ok(stored_key) => stored_key.algorithm() != key.algorithm(),
            Err(_) => false,
        });
        stored.push(key_text);

        self.persist()
    }

    /// Every stored key, sorted the way the file is, for the management UI.
    pub fn list(&self) -> Vec<KnownHostEntry> {
        let mut ids: Vec<&String> = self.entries.keys().collect();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let (host, port) = split_host_id(id);
            let mut keys: Vec<&String> = self.entries[id].iter().collect();
            keys.sort();
            for key_text in keys {
                let parsed = PublicKey::from_openssh(key_text).ok();
                out.push(KnownHostEntry {
                    host: host.clone(),
                    port,
                    algorithm: parsed.as_ref().map(|k| k.algorithm().to_string()),
                    fingerprint: parsed.as_ref().map(fingerprint),
                    key_text: key_text.clone(),
                });
            }
        }
        out
    }

    /// Forgets one stored key. Returns whether it was there.
    ///
    /// Removing trust is the safe direction — the worst outcome is a
    /// first-connection prompt — which is why this needs no confirmation from
    /// the store's side and why `learn` is the operation that had to grow a
    /// reload rather than this one.
    pub fn forget(&mut self, host: &str, port: u16, key_text: &str) -> std::io::Result<bool> {
        self.reload();
        let id = host_id(host, port);
        let Some(stored) = self.entries.get_mut(&id) else {
            return Ok(false);
        };
        let before = stored.len();
        stored.retain(|text| text != key_text);
        let removed = stored.len() != before;
        if stored.is_empty() {
            // Dropped rather than left as an empty list, so `check` reports
            // `Unknown` for the host and `list` has nothing to show.
            self.entries.remove(&id);
        }
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Forgets every key held for one host, returning how many there were.
    ///
    /// A host offers a different key per algorithm, so "this host is
    /// reprovisioned, forget it" is a distinct intent from removing one entry —
    /// and doing it one row at a time invites stopping halfway, which leaves the
    /// host in the state most likely to produce a confusing `Changed` prompt
    /// later.
    pub fn forget_host(&mut self, host: &str, port: u16) -> std::io::Result<usize> {
        self.reload();
        let removed = self
            .entries
            .remove(&host_id(host, port))
            .map_or(0, |keys| keys.len());
        if removed > 0 {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Re-reads the file into `entries`, discarding in-memory state.
    ///
    /// Failure is deliberately ignored: this runs on the write path, and a
    /// transiently unreadable file is not a reason to lose what is already
    /// trusted in memory. The write that follows will report its own error.
    fn reload(&mut self) {
        if let Ok(fresh) = Self::load(&self.path) {
            self.entries = fresh.entries;
        }
    }

    fn persist(&self) -> std::io::Result<()> {
        let mut contents = String::new();
        let mut ids: Vec<&String> = self.entries.keys().collect();
        ids.sort();
        for id in ids {
            // Sorted within the host too: the file is diffable and
            // byte-stable across saves only if both levels are ordered, and
            // `HashMap`'s iteration order is not.
            let mut keys: Vec<&String> = self.entries[id].iter().collect();
            keys.sort();
            for key_text in keys {
                contents.push_str(id);
                contents.push(' ');
                contents.push_str(key_text);
                contents.push('\n');
            }
        }
        atomic_write(&self.path, contents.as_bytes())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Lowercased: DNS names are case-insensitive, so `Example.com:22` and
/// `example.com:22` are the same host. Keying on the raw string made them two
/// entries, which meant connecting to a saved session by a differently-cased
/// name reprompted as `Unknown` for a host already trusted. ASCII-only
/// lowercasing on purpose — Unicode case folding on an IDN label is not a
/// transformation this should be inventing.
fn host_id(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_ascii_lowercase())
}

/// `host_id` in reverse, for listing.
///
/// Split from the *right*, because an IPv6 literal is full of colons —
/// `[::1]:22` has to come back as `[::1]` and `22`, not `[` and `:1]:22`. An id
/// with no port at all should not exist, but if one does it is shown with the
/// SSH default rather than dropped from the list, since an entry the UI cannot
/// display is an entry the user cannot delete.
fn split_host_id(id: &str) -> (String, u16) {
    match id.rsplit_once(':') {
        Some((host, port)) => match port.parse() {
            Ok(port) => (host.to_string(), port),
            Err(_) => (id.to_string(), 22),
        },
        None => (id.to_string(), 22),
    }
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed throwaway Ed25519 test keys (generated once with `ssh-keygen`,
    // no corresponding private key kept anywhere) so tests don't need a
    // keypair-generation dependency just to compare/persist public keys.
    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILqSDt0cbD+ayGxAMPpVeNgzLGdNQRRrFt3stCpi4oWu";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHIIJJ3Yz6AjlhL3dNONdg1RVwIgO14o6Y3As7ihoXmj";
    /// A second *algorithm*, not just a second key — the per-algorithm
    /// storage below can't be tested with two Ed25519 keys.
    const KEY_ECDSA: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGz0rNnU1O1z+Z74/aAD3WNLCnuzG8s0vm8V9Oupz1F6bye2ZNFhUasm4bNWiLfu4NBmYT5uP73ozZEQCzWQL+4=";

    fn key(text: &str) -> PublicKey {
        PublicKey::from_openssh(text).expect("valid test key")
    }

    #[test]
    fn unknown_host_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        assert_eq!(
            store.check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn learned_host_is_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        let k = key(KEY_A);

        store.learn("example.com", 22, &k).unwrap();
        assert_eq!(store.check("example.com", 22, &k), HostKeyStatus::Trusted);

        // Reload from disk to prove persistence, not just in-memory state.
        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("example.com", 22, &k),
            HostKeyStatus::Trusted
        );
    }

    #[test]
    fn changed_key_is_flagged_not_silently_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();

        store.learn("example.com", 22, &key(KEY_A)).unwrap();

        match store.check("example.com", 22, &key(KEY_B)) {
            HostKeyStatus::Changed { .. } => {}
            other => panic!("expected Changed, got {other:?}"),
        }
    }

    #[test]
    fn different_ports_are_independent_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        let k = key(KEY_A);

        store.learn("example.com", 22, &k).unwrap();
        assert_eq!(store.check("example.com", 2222, &k), HostKeyStatus::Unknown);
    }

    /// DNS is case-insensitive, so a differently-cased name must not reprompt.
    #[test]
    fn host_matching_is_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        let k = key(KEY_A);

        store.learn("Example.COM", 22, &k).unwrap();
        assert_eq!(store.check("example.com", 22, &k), HostKeyStatus::Trusted);

        // And through a reload, so the on-disk id is normalised too.
        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("EXAMPLE.com", 22, &k),
            HostKeyStatus::Trusted
        );
    }

    /// A file written before ids were lowercased must still match, rather
    /// than silently degrading into a first-connection prompt.
    #[test]
    fn legacy_mixed_case_entries_are_normalised_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, format!("Example.COM:22 {KEY_A}\n")).unwrap();

        let store = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            store.check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::Trusted
        );
    }

    /// The whole point of the per-algorithm store: learning a second
    /// algorithm must not evict the first.
    #[test]
    fn algorithms_are_stored_side_by_side() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();

        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();

        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::Trusted
        );
        assert_eq!(
            reloaded.check("example.com", 22, &key(KEY_ECDSA)),
            HostKeyStatus::Trusted
        );
    }

    /// The false-positive this exists to remove: an algorithm we hold no key
    /// for is `Unknown`, not "the key changed, you may be under attack".
    #[test]
    fn unseen_algorithm_is_unknown_not_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();

        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        assert_eq!(
            store.check("example.com", 22, &key(KEY_ECDSA)),
            HostKeyStatus::Unknown
        );
    }

    /// ...but a differing key of an algorithm we *do* hold is still the loud
    /// case, and reports that algorithm's fingerprint rather than some other
    /// key's.
    #[test]
    fn changed_reports_the_matching_algorithms_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();

        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();
        store.learn("example.com", 22, &key(KEY_A)).unwrap();

        match store.check("example.com", 22, &key(KEY_B)) {
            HostKeyStatus::Changed { stored_fingerprint } => {
                assert_eq!(stored_fingerprint, fingerprint(&key(KEY_A)));
            }
            other => panic!("expected Changed, got {other:?}"),
        }
    }

    /// Relearning the same algorithm replaces rather than accumulates —
    /// otherwise an accepted host-key rotation would leave the old key on
    /// disk and still matching.
    #[test]
    fn relearning_same_algorithm_replaces_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();

        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        store.learn("example.com", 22, &key(KEY_B)).unwrap();

        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("example.com", 22, &key(KEY_B)),
            HostKeyStatus::Trusted
        );
        match reloaded.check("example.com", 22, &key(KEY_A)) {
            HostKeyStatus::Changed { .. } => {}
            other => panic!("expected Changed for the superseded key, got {other:?}"),
        }
    }

    #[test]
    fn list_reports_every_key_with_its_algorithm_and_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();
        store.learn("other.example", 2222, &key(KEY_B)).unwrap();

        let listed = store.list();
        assert_eq!(listed.len(), 3);
        assert!(listed
            .iter()
            .any(|e| e.host == "example.com" && e.fingerprint == Some(fingerprint(&key(KEY_A)))));
        let other = listed.iter().find(|e| e.host == "other.example").unwrap();
        assert_eq!(other.port, 2222);
        assert_eq!(other.algorithm.as_deref(), Some("ssh-ed25519"));
    }

    /// The entries that most need deleting are the ones that will not parse —
    /// they pin a host to `Changed` forever — so they have to be listable even
    /// though they have no fingerprint to show.
    #[test]
    fn list_includes_an_unparseable_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, "example.com:22 ssh-ed25519 not-valid-base64!!\n").unwrap();

        let listed = KnownHostsStore::load(&path).unwrap().list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].fingerprint, None);
        assert_eq!(listed[0].algorithm, None);
        assert!(!listed[0].key_text.is_empty());
    }

    #[test]
    fn forgetting_a_key_makes_the_host_unknown_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        store.learn("example.com", 22, &key(KEY_A)).unwrap();

        let entry = store.list().pop().unwrap();
        assert!(store.forget("example.com", 22, &entry.key_text).unwrap());

        assert_eq!(
            KnownHostsStore::load(&path)
                .unwrap()
                .check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::Unknown
        );
        // Gone from the file, not just emptied — an id with no keys would show
        // as a host with nothing under it.
        assert!(KnownHostsStore::load(&path).unwrap().list().is_empty());
    }

    /// Removing one algorithm must leave the host's others trusted, or
    /// "delete the stale RSA entry" would silently drop Ed25519 trust too.
    #[test]
    fn forgetting_one_key_leaves_the_other_algorithm_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();

        let ed = store
            .list()
            .into_iter()
            .find(|e| e.algorithm.as_deref() == Some("ssh-ed25519"))
            .unwrap();
        store.forget("example.com", 22, &ed.key_text).unwrap();

        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("example.com", 22, &key(KEY_ECDSA)),
            HostKeyStatus::Trusted
        );
        assert_eq!(
            reloaded.check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn forgetting_a_key_that_is_not_there_reports_so_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        assert!(!store.forget("example.com", 22, "whatever").unwrap());
    }

    #[test]
    fn forgetting_a_host_removes_every_algorithm_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();
        store.learn("other.example", 22, &key(KEY_B)).unwrap();

        assert_eq!(store.forget_host("example.com", 22).unwrap(), 2);

        let listed = KnownHostsStore::load(&path).unwrap().list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].host, "other.example");
    }

    /// The store is not the only writer: every connector loads its own copy and
    /// the management UI has a third. Without the reload on the write path, a
    /// connector persisting from a copy loaded before a deletion would rewrite
    /// the whole file from stale state and bring the deleted key back — a trust
    /// anchor returning from the dead, which is the one thing this file exists
    /// to prevent.
    #[test]
    fn a_stale_writer_does_not_resurrect_a_forgotten_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");

        let mut connector_copy = KnownHostsStore::load(&path).unwrap();
        connector_copy
            .learn("example.com", 22, &key(KEY_A))
            .unwrap();

        // Someone deletes it through the management UI, using its own store.
        let mut ui_copy = KnownHostsStore::load(&path).unwrap();
        let entry = ui_copy.list().pop().unwrap();
        ui_copy.forget("example.com", 22, &entry.key_text).unwrap();

        // The connector, still holding the old view, learns an unrelated host.
        connector_copy
            .learn("other.example", 22, &key(KEY_B))
            .unwrap();

        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::Unknown,
            "the deleted key must not come back"
        );
        assert_eq!(
            reloaded.check("other.example", 22, &key(KEY_B)),
            HostKeyStatus::Trusted
        );
    }

    /// An IPv6 literal is full of colons, so the id has to be split from the
    /// right or the host comes back mangled and the entry cannot be deleted.
    #[test]
    fn an_ipv6_host_survives_the_round_trip_through_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        store.learn("[::1]", 2222, &key(KEY_A)).unwrap();

        let listed = store.list();
        assert_eq!(listed[0].host, "[::1]");
        assert_eq!(listed[0].port, 2222);
    }

    /// A corrupt line could be the entry that would have matched, so it must
    /// not degrade to `Unknown` and get quietly relearned over.
    #[test]
    fn unparseable_entry_still_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, "example.com:22 ssh-ed25519 not-valid-base64!!\n").unwrap();

        let store = KnownHostsStore::load(&path).unwrap();
        match store.check("example.com", 22, &key(KEY_A)) {
            HostKeyStatus::Changed { .. } => {}
            other => panic!("expected Changed, got {other:?}"),
        }
    }
}
