//! Host-key trust-on-first-use (TOFU) store. Not delegated to `russh`'s
//! `known_hosts` helpers, so the accept/reject flow goes through the UI and the
//! format is unit-testable without OpenSSH's filesystem conventions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use russh::keys::ssh_key::{Algorithm, HashAlg};
use russh::keys::PublicKey;

/// Temp-file-plus-rename write, owner-only on Unix, so a crash can't truncate
/// the trust anchor (see `wr_fs`).
use wr_fs::write_atomic as atomic_write;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// No entry for this host: first connection, or the entry was removed.
    Unknown,
    /// Entry exists and matches the offered key.
    Trusted,
    /// Entry exists but the offered key differs. Never auto-accept: it's either a
    /// reprovisioned host or an active MITM.
    Changed { stored_fingerprint: String },
    /// Keys are on record for this host, but none of the offered key's type. Not
    /// `Changed` (nothing is contradicted), but not a first connection either:
    /// it's what a MITM without the host's key would produce. Since
    /// [`KnownHostsStore::host_key_preference`] makes an honest server present a
    /// pinned type, arriving here means the server no longer offers any.
    ///
    /// `known` is each key on record, as `algorithm fingerprint`.
    NewKeyType { known: Vec<String> },
}

/// One stored host key, for the management UI. `algorithm` and `fingerprint`
/// are optional because an unparseable line must still be listable: those
/// entries pin a host to `Changed` and most need deleting.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: Option<String>,
    pub fingerprint: Option<String>,
    /// The stored line itself, and the id `forget` takes (an unparseable entry has
    /// no fingerprint).
    pub key_text: String,
}

pub struct KnownHostsStore {
    path: PathBuf,
    /// One entry per key algorithm per `host:port`, as OpenSSH does. A server's
    /// key depends on the negotiated algorithm, so a single key per host would
    /// turn any negotiation shift into a false "possible MITM", which trains
    /// users to click through.
    entries: HashMap<String, Vec<String>>,
}

impl KnownHostsStore {
    /// Loads the store from `path`; a missing file is an empty store (created on
    /// first `learn`).
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
                        // Normalized on read too, so entries written before ids were lowercased
                        // still match. Lowercasing `host:port` only affects the host.
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

    /// `Changed` means a key of this algorithm is held and differs. A held Ed25519
    /// key and an offered RSA one is `NewKeyType`: not the changed-key alarm, but
    /// not a first connection either.
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
        let id = host_id(host, port);
        let Some(stored) = self.entries.get(&id) else {
            return HostKeyStatus::Unknown;
        };

        let mut same_algorithm: Option<PublicKey> = None;
        let mut saw_unparseable = false;
        let mut other_algorithms = Vec::new();

        for text in stored {
            match PublicKey::from_openssh(text) {
                Ok(stored_key) if &stored_key == key => return HostKeyStatus::Trusted,
                Ok(stored_key) if stored_key.algorithm() == key.algorithm() => {
                    same_algorithm = Some(stored_key)
                }
                Ok(stored_key) => other_algorithms.push(format!(
                    "{} {}",
                    stored_key.algorithm(),
                    fingerprint(&stored_key)
                )),
                Err(_) => saw_unparseable = true,
            }
        }

        match same_algorithm {
            Some(stored_key) => HostKeyStatus::Changed {
                stored_fingerprint: fingerprint(&stored_key),
            },
            // A corrupt entry might have matched, so fail closed rather than relearn.
            None if saw_unparseable => HostKeyStatus::Changed {
                stored_fingerprint: "<unparseable stored entry>".to_string(),
            },
            None if !other_algorithms.is_empty() => HostKeyStatus::NewKeyType {
                known: other_algorithms,
            },
            None => HostKeyStatus::Unknown,
        }
    }

    /// russh's default host-key algorithm order, with every type already held for
    /// this host moved to the front, as OpenSSH does. The server picks the first
    /// algorithm on our list it supports, so without this a host pinned under
    /// Ed25519 could be negotiated onto another type by a version bump or a MITM.
    ///
    /// Only reorders. RSA's hash variants count as one type, as in russh.
    pub fn host_key_preference(&self, host: &str, port: u16) -> russh::Preferred {
        let known: Vec<Algorithm> = self
            .entries
            .get(&host_id(host, port))
            .into_iter()
            .flatten()
            .filter_map(|text| PublicKey::from_openssh(text).ok())
            .map(|key| key.algorithm())
            .collect();
        let defaults = russh::Preferred::default();
        let (mut order, rest): (Vec<Algorithm>, Vec<Algorithm>) =
            defaults.key.iter().cloned().partition(|offered| {
                known
                    .iter()
                    .any(|k| k == offered || (is_rsa(k) && is_rsa(offered)))
            });
        order.extend(rest);
        russh::Preferred {
            key: order.into(),
            ..defaults
        }
    }

    /// Records `key` as trusted for `host:port`, replacing any entry of the same
    /// algorithm and keeping the others, then persists.
    pub fn learn(&mut self, host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
        let id = host_id(host, port);
        let key_text = key
            .to_openssh()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        // Re-read first: every connector and the management UI hold their own copy,
        // and writing from a stale one would resurrect a just-deleted key.
        self.reload();

        let stored = self.entries.entry(id).or_default();
        // An unparseable entry has no algorithm to match; dropping it on an explicit
        // accept stops it pinning the host to `Changed` forever.
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

    /// Forgets one stored key. Returns whether it was there. Removing trust is the
    /// safe direction (at worst, a first-connection prompt).
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
            // Removed rather than left empty, so the host reads as `Unknown`.
            self.entries.remove(&id);
        }
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Forgets every key for one host, returning how many. "This host was
    /// reprovisioned" is a distinct intent from deleting one entry, and doing it
    /// row by row invites stopping halfway.
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

    /// Re-reads the file into `entries`. Failure is ignored: a transiently
    /// unreadable file isn't a reason to drop what's trusted in memory, and the
    /// following write reports its own error.
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
            // Sorted within the host too, so the file is byte-stable across saves.
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

/// Lowercased, since DNS names are case-insensitive. ASCII-only: Unicode case
/// folding on an IDN label isn't this function's call.
fn host_id(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_ascii_lowercase())
}

/// `host_id` in reverse, for listing. Split from the right for IPv6
/// (`[::1]:22`). An id without a port shows with the SSH default rather than
/// becoming undeletable.
fn split_host_id(id: &str) -> (String, u16) {
    match id.rsplit_once(':') {
        Some((host, port)) => match port.parse() {
            Ok(port) => (host.to_string(), port),
            Err(_) => (id.to_string(), 22),
        },
        None => (id.to_string(), 22),
    }
}

/// `Algorithm::is_rsa` takes `self`, and these are borrowed out of a list.
fn is_rsa(algorithm: &Algorithm) -> bool {
    matches!(algorithm, Algorithm::Rsa { .. })
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Throwaway Ed25519 keys (no private key kept), so tests need no keypair
    // generation.
    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILqSDt0cbD+ayGxAMPpVeNgzLGdNQRRrFt3stCpi4oWu";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHIIJJ3Yz6AjlhL3dNONdg1RVwIgO14o6Y3As7ihoXmj";
    /// A second algorithm, for testing per-algorithm storage.
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

        // Reload from disk to prove persistence.
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

    /// A differently-cased name doesn't reprompt.
    #[test]
    fn host_matching_is_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();
        let k = key(KEY_A);

        store.learn("Example.COM", 22, &k).unwrap();
        assert_eq!(store.check("example.com", 22, &k), HostKeyStatus::Trusted);

        // Through a reload too, so the on-disk id is normalized.
        let reloaded = KnownHostsStore::load(&path).unwrap();
        assert_eq!(
            reloaded.check("EXAMPLE.com", 22, &k),
            HostKeyStatus::Trusted
        );
    }

    /// A file written before ids were lowercased still matches.
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

    /// Learning a second algorithm doesn't evict the first.
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

    /// An unpinned algorithm on a known host is `NewKeyType`, naming what's on
    /// record.
    #[test]
    fn unseen_algorithm_on_a_known_host_is_a_new_key_type() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let mut store = KnownHostsStore::load(&path).unwrap();

        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        assert_eq!(
            store.check("example.com", 22, &key(KEY_ECDSA)),
            HostKeyStatus::NewKeyType {
                known: vec![format!("ssh-ed25519 {}", fingerprint(&key(KEY_A)))]
            }
        );
    }

    /// Accepting a new key type adds it beside the old one.
    #[test]
    fn accepting_a_new_key_type_trusts_both() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        store.learn("example.com", 22, &key(KEY_A)).unwrap();
        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();
        for k in [KEY_A, KEY_ECDSA] {
            assert_eq!(
                store.check("example.com", 22, &key(k)),
                HostKeyStatus::Trusted
            );
        }
    }

    /// A pinned type goes first; everything else keeps russh's order.
    #[test]
    fn negotiation_prefers_the_key_types_on_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        store.learn("example.com", 22, &key(KEY_ECDSA)).unwrap();

        let defaults = russh::Preferred::default();
        let ordered = store.host_key_preference("example.com", 22);
        assert_eq!(ordered.key[0], key(KEY_ECDSA).algorithm());
        // Only a reordering.
        let mut a = ordered.key.to_vec();
        let mut b = defaults.key.to_vec();
        assert_eq!(a.len(), b.len());
        let rest: Vec<_> = a[1..].to_vec();
        let default_rest: Vec<_> = b
            .iter()
            .filter(|x| **x != key(KEY_ECDSA).algorithm())
            .cloned()
            .collect();
        assert_eq!(rest, default_rest);
        a.sort_by_key(|x| x.to_string());
        b.sort_by_key(|x| x.to_string());
        assert_eq!(a, b);

        // A host with nothing on record gets the defaults.
        assert_eq!(
            store.host_key_preference("other.example", 22).key,
            defaults.key
        );
    }

    /// A pinned `ssh-rsa` key brings every RSA variant forward, in default order.
    #[test]
    fn a_pinned_rsa_key_brings_every_rsa_variant_forward() {
        // Throwaway; only its type matters.
        const KEY_RSA: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDxp3u5yaChgiQhn/yorBW+XaPt4/KiOUYjzaIBWvkAK0UEzSJDgcUeIW4u33LB5IoaXS/BLe3ijXwwt/N00IeER/dF+jNxl7DhvF7FP8dkApYfcKl04dopQ29Gg12SqsW+v02UTdh1Bd6lMOTMmXf5ISSH3UiZc2jTRCRpyPx0NQ==";
        let rsa = key(KEY_RSA);
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        store.learn("example.com", 22, &rsa).unwrap();

        let ordered = store.host_key_preference("example.com", 22);
        let rsa_count = ordered.key.iter().filter(|a| is_rsa(a)).count();
        assert!(rsa_count > 0);
        assert!(ordered.key[..rsa_count].iter().all(is_rsa));
    }

    /// A differing key of a held algorithm is still `Changed`, with that
    /// algorithm's fingerprint.
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

    /// Relearning an algorithm replaces its key, so a rotated-away key stops
    /// matching.
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

    /// Unparseable entries are listable, though they have no fingerprint.
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
        // Gone from the file, not just emptied.
        assert!(KnownHostsStore::load(&path).unwrap().list().is_empty());
    }

    /// Removing one algorithm keeps the host's others trusted.
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
        // Still trusted under ECDSA, so a new key type, not a first connection.
        assert!(matches!(
            reloaded.check("example.com", 22, &key(KEY_A)),
            HostKeyStatus::NewKeyType { .. }
        ));
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

    /// A connector writing from a copy loaded before a deletion doesn't bring the
    /// deleted key back.
    #[test]
    fn a_stale_writer_does_not_resurrect_a_forgotten_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");

        let mut connector_copy = KnownHostsStore::load(&path).unwrap();
        connector_copy
            .learn("example.com", 22, &key(KEY_A))
            .unwrap();

        // Deleted through the management UI's own store.
        let mut ui_copy = KnownHostsStore::load(&path).unwrap();
        let entry = ui_copy.list().pop().unwrap();
        ui_copy.forget("example.com", 22, &entry.key_text).unwrap();

        // The connector, holding the old view, learns an unrelated host.
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

    /// An IPv6 id splits from the right, so the entry stays deletable.
    #[test]
    fn an_ipv6_host_survives_the_round_trip_through_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KnownHostsStore::load(dir.path().join("known_hosts")).unwrap();
        store.learn("[::1]", 2222, &key(KEY_A)).unwrap();

        let listed = store.list();
        assert_eq!(listed[0].host, "[::1]");
        assert_eq!(listed[0].port, 2222);
    }

    /// A corrupt line doesn't degrade to `Unknown`.
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
