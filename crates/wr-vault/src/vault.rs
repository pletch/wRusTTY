use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use argon2::Params;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::error::VaultError;
use crate::secret::VaultSecret;

const FORMAT_VERSION: u32 = 1;

/// Writes `contents` to `path` via a temp file in the same directory
/// (so the final rename is atomic on the same volume) plus an fsync before
/// the rename — a crash or power loss mid-write can otherwise leave a
/// truncated or empty vault file, silently destroying every stored
/// credential. Also sets owner-only permissions on Unix (the file holds
/// every saved credential); on Windows the per-user %APPDATA% ACL already
/// covers this.
fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    tmp.persist(path)?;
    Ok(())
}

// Matches the `argon2` crate's own `Params::default()` exactly (verified
// directly against its source) — the parameters every vault file predating
// this change was actually created with. A vault file missing these fields
// must keep deriving its key with these values, not whatever
// `crypto::default_params()` happens to return today, or it becomes
// permanently undecryptable the moment that default is next tuned.
fn legacy_m_cost() -> u32 {
    19 * 1024
}
fn legacy_t_cost() -> u32 {
    2
}
fn legacy_p_cost() -> u32 {
    1
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
    #[serde(default = "legacy_m_cost")]
    m_cost: u32,
    #[serde(default = "legacy_t_cost")]
    t_cost: u32,
    #[serde(default = "legacy_p_cost")]
    p_cost: u32,
}

/// An unlocked vault: decrypted entries live in memory only for as long as
/// this value does. Every mutation re-encrypts and persists immediately
/// (no separate "save" step to forget).
pub struct Vault {
    path: PathBuf,
    /// Fixed for the vault's lifetime — only set once, at creation. Each
    /// write reuses it and generates a fresh nonce (required for AEAD
    /// safety; the salt is not sensitive and doesn't need to rotate).
    salt: [u8; crypto::SALT_LEN],
    /// Whatever params this vault was actually created with — new vaults
    /// get `crypto::default_params()`, existing ones keep whatever's
    /// stored in their file (or the legacy defaults, if predating this
    /// field). Persisted on every write so a future default change can
    /// never make an existing vault undecryptable.
    params: Params,
    key: [u8; 32],
    entries: HashMap<String, VaultSecret>,
}

impl Drop for Vault {
    fn drop(&mut self) {
        crypto::zeroize_key(&mut self.key);
        // Dropping `entries` here zeroizes each VaultSecret's fields via
        // its `ZeroizeOnDrop` derive.
    }
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

impl Vault {
    /// Creates a new empty vault at `path`. Fails if a vault already exists
    /// there — callers must explicitly delete/import to replace one.
    pub fn create(path: impl Into<PathBuf>, master_password: &str) -> Result<Self, VaultError> {
        let path = path.into();
        if path.exists() {
            return Err(VaultError::AlreadyExists);
        }

        let salt = crypto::random_salt();
        let params = crypto::default_params();
        let key = crypto::derive_key(master_password, &salt, params.clone())?;
        let vault = Self {
            path,
            salt,
            params,
            key,
            entries: HashMap::new(),
        };
        vault.persist()?;
        Ok(vault)
    }

    pub fn unlock(path: impl Into<PathBuf>, master_password: &str) -> Result<Self, VaultError> {
        let (path, salt, params, nonce, ciphertext) = Self::read_file(path.into())?;
        let key = crypto::derive_key(master_password, &salt, params.clone())?;
        Self::finish_unlock(path, salt, params, key, &nonce, &ciphertext)
    }

    /// Unlocks using the raw vault key directly instead of deriving one from
    /// a master password. Used by the OS-keychain convenience unlock: the
    /// key itself (not the password) is what's wrapped by the OS — DPAPI via
    /// Windows Credential Manager — so unlocking this way skips Argon2
    /// entirely and is only as strong as that OS-level protection.
    pub fn unlock_with_key(path: impl Into<PathBuf>, key: [u8; 32]) -> Result<Self, VaultError> {
        let (path, salt, params, nonce, ciphertext) = Self::read_file(path.into())?;
        Self::finish_unlock(path, salt, params, key, &nonce, &ciphertext)
    }

    /// A copy of the raw encryption key, for wrapping by an OS-level secret
    /// store as a convenience-unlock path. The caller is responsible for
    /// zeroizing its copy once it's been handed off to that store.
    pub fn key_bytes(&self) -> [u8; 32] {
        self.key
    }

    #[allow(clippy::type_complexity)]
    fn read_file(
        path: PathBuf,
    ) -> Result<(PathBuf, [u8; crypto::SALT_LEN], Params, Vec<u8>, Vec<u8>), VaultError> {
        let contents = std::fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                VaultError::NotFound
            } else {
                VaultError::Io(e)
            }
        })?;
        let file: VaultFile =
            serde_json::from_str(&contents).map_err(|e| VaultError::Corrupt(e.to_string()))?;

        let salt_bytes = BASE64
            .decode(&file.salt)
            .map_err(|e| VaultError::Corrupt(e.to_string()))?;
        let salt: [u8; crypto::SALT_LEN] = salt_bytes
            .try_into()
            .map_err(|_| VaultError::Corrupt("salt has unexpected length".into()))?;
        let params = Params::new(file.m_cost, file.t_cost, file.p_cost, None)
            .map_err(|e| VaultError::Corrupt(format!("invalid stored KDF params: {e}")))?;
        let nonce = BASE64
            .decode(&file.nonce)
            .map_err(|e| VaultError::Corrupt(e.to_string()))?;
        let ciphertext = BASE64
            .decode(&file.ciphertext)
            .map_err(|e| VaultError::Corrupt(e.to_string()))?;

        Ok((path, salt, params, nonce, ciphertext))
    }

    fn finish_unlock(
        path: PathBuf,
        salt: [u8; crypto::SALT_LEN],
        params: Params,
        key: [u8; 32],
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Self, VaultError> {
        let plaintext = crypto::decrypt(&key, nonce, ciphertext)?;
        let entries: HashMap<String, VaultSecret> =
            serde_json::from_slice(&plaintext).map_err(|e| VaultError::Corrupt(e.to_string()))?;

        Ok(Self {
            path,
            salt,
            params,
            key,
            entries,
        })
    }

    pub fn get(&self, session_id: &str) -> Option<&VaultSecret> {
        self.entries.get(session_id)
    }

    pub fn has(&self, session_id: &str) -> bool {
        self.entries.contains_key(session_id)
    }

    pub fn set(&mut self, session_id: String, secret: VaultSecret) -> Result<(), VaultError> {
        self.entries.insert(session_id, secret);
        self.persist()
    }

    pub fn remove(&mut self, session_id: &str) -> Result<(), VaultError> {
        self.entries.remove(session_id);
        self.persist()
    }

    fn persist(&self) -> Result<(), VaultError> {
        let plaintext =
            serde_json::to_vec(&self.entries).map_err(|e| VaultError::Corrupt(e.to_string()))?;
        let (nonce, ciphertext) = crypto::encrypt(&self.key, &plaintext)?;

        let file = VaultFile {
            version: FORMAT_VERSION,
            salt: BASE64.encode(self.salt),
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
            m_cost: self.params.m_cost(),
            t_cost: self.params.t_cost(),
            p_cost: self.params.p_cost(),
        };

        let contents =
            serde_json::to_string_pretty(&file).map_err(|e| VaultError::Corrupt(e.to_string()))?;
        atomic_write(&self.path, contents.as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("vault.wrv")
    }

    #[test]
    fn create_then_unlock_round_trips_empty_vault() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "correct horse battery staple").unwrap());

        let vault = Vault::unlock(&path, "correct horse battery staple").unwrap();
        assert!(!vault.has("anything"));
    }

    #[test]
    fn wrong_password_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "correct password").unwrap());

        match Vault::unlock(&path, "wrong password") {
            Err(VaultError::WrongPassword) => {}
            Err(other) => panic!("expected WrongPassword, got {other:?}"),
            Ok(_) => panic!("expected WrongPassword, got Ok"),
        }
    }

    #[test]
    fn creating_twice_at_same_path_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "pw").unwrap());

        match Vault::create(&path, "pw") {
            Err(VaultError::AlreadyExists) => {}
            Err(other) => panic!("expected AlreadyExists, got {other:?}"),
            Ok(_) => panic!("expected AlreadyExists, got Ok"),
        }
    }

    #[test]
    fn set_persists_across_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault
            .set(
                "session-1".to_string(),
                VaultSecret::Password {
                    password: "hunter2".to_string(),
                },
            )
            .unwrap();
        drop(vault);

        let reopened = Vault::unlock(&path, "pw").unwrap();
        assert!(reopened.has("session-1"));
        match reopened.get("session-1") {
            Some(VaultSecret::Password { password }) => assert_eq!(password, "hunter2"),
            other => panic!("expected Password secret, got {other:?}"),
        }
    }

    #[test]
    fn remove_deletes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault
            .set(
                "session-1".to_string(),
                VaultSecret::Passphrase {
                    passphrase: "key-pass".to_string(),
                },
            )
            .unwrap();
        vault.remove("session-1").unwrap();
        assert!(!vault.has("session-1"));

        let reopened = Vault::unlock(&path, "pw").unwrap();
        assert!(!reopened.has("session-1"));
    }

    #[test]
    fn unlock_with_key_matches_password_derived_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault
            .set(
                "session-1".to_string(),
                VaultSecret::Password {
                    password: "hunter2".to_string(),
                },
            )
            .unwrap();
        let key = vault.key_bytes();
        drop(vault);

        let reopened = Vault::unlock_with_key(&path, key).unwrap();
        assert!(reopened.has("session-1"));
    }

    #[test]
    fn unlock_with_key_rejects_wrong_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "pw").unwrap());

        match Vault::unlock_with_key(&path, [0u8; 32]) {
            Err(VaultError::WrongPassword) => {}
            Err(other) => panic!("expected WrongPassword, got {other:?}"),
            Ok(_) => panic!("expected WrongPassword, got Ok"),
        }
    }

    #[test]
    fn unlocking_missing_file_reports_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        match Vault::unlock(&path, "pw") {
            Err(VaultError::NotFound) => {}
            Err(other) => panic!("expected NotFound, got {other:?}"),
            Ok(_) => panic!("expected NotFound, got Ok"),
        }
    }

    /// A vault file predating the m_cost/t_cost/p_cost fields must keep
    /// unlocking with the exact params it was actually encrypted with
    /// (`argon2`'s own old `Params::default()`) — not today's stronger
    /// defaults — or every vault created before this change becomes
    /// permanently undecryptable.
    #[test]
    fn legacy_vault_file_without_kdf_params_still_unlocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);

        let salt = crypto::random_salt();
        let legacy_params = Params::new(19 * 1024, 2, 1, None).unwrap();
        let key = crypto::derive_key("legacy pw", &salt, legacy_params).unwrap();
        let plaintext = serde_json::to_vec(&HashMap::<String, VaultSecret>::new()).unwrap();
        let (nonce, ciphertext) = crypto::encrypt(&key, &plaintext).unwrap();

        let old_format_json = serde_json::json!({
            "version": 1,
            "salt": BASE64.encode(salt),
            "nonce": BASE64.encode(nonce),
            "ciphertext": BASE64.encode(ciphertext),
        });
        std::fs::write(&path, old_format_json.to_string()).unwrap();

        let vault = Vault::unlock(&path, "legacy pw").unwrap();
        assert!(!vault.has("anything"));
    }
}
