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

pub struct KnownHostsStore {
    path: PathBuf,
    entries: HashMap<String, String>,
}

impl KnownHostsStore {
    /// Loads the store from `path`, creating an empty in-memory store if the
    /// file doesn't exist yet (it's created on first `learn`).
    pub fn load(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        let mut entries = HashMap::new();

        match std::fs::read_to_string(&path) {
            Ok(contents) => {
                for line in contents.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((id, key_text)) = line.split_once(' ') {
                        entries.insert(id.to_string(), key_text.to_string());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }

        Ok(Self { path, entries })
    }

    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
        let id = host_id(host, port);
        let Some(stored_text) = self.entries.get(&id) else {
            return HostKeyStatus::Unknown;
        };

        match PublicKey::from_openssh(stored_text) {
            Ok(stored_key) if &stored_key == key => HostKeyStatus::Trusted,
            Ok(stored_key) => HostKeyStatus::Changed {
                stored_fingerprint: fingerprint(&stored_key),
            },
            // A corrupted/unparseable stored entry is treated the same as a
            // mismatch: it must not be silently overwritten or trusted.
            Err(_) => HostKeyStatus::Changed {
                stored_fingerprint: "<unparseable stored entry>".to_string(),
            },
        }
    }

    /// Records `key` as trusted for `host:port`, overwriting any previous
    /// entry, and persists the store to disk.
    pub fn learn(&mut self, host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
        let id = host_id(host, port);
        let key_text = key
            .to_openssh()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        self.entries.insert(id, key_text);
        self.persist()
    }

    fn persist(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut contents = String::new();
        let mut ids: Vec<&String> = self.entries.keys().collect();
        ids.sort();
        for id in ids {
            contents.push_str(id);
            contents.push(' ');
            contents.push_str(&self.entries[id]);
            contents.push('\n');
        }
        std::fs::write(&self.path, contents)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn host_id(host: &str, port: u16) -> String {
    format!("{host}:{port}")
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
}
