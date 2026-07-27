use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::error::VaultError;
use crate::key::Dek;
use crate::key::Kek;
use crate::provider::{KeyProvider, PasswordProvider};
use crate::secret::VaultSecret;
use crate::wrapper::{self, StoredWrapper, WrapperKind, WrapperMeta, WrapperParams};

const FORMAT_VERSION: u32 = 2;

/// Temp-file-plus-rename write, owner-only on Unix. A crash or power loss
/// mid-write could otherwise leave a truncated or empty vault file, silently
/// destroying every stored credential; this is also what makes the v1 → v2
/// migration safe, since the old file stays intact and openable right up
/// until the single rename that replaces it. See `wr_fs` for the full
/// reasoning.
use wr_fs::write_atomic as atomic_write;

// Matches the `argon2` crate's own `Params::default()` exactly (verified
// directly against its source) — the parameters every v1 vault file
// predating the stored-params change was actually created with. A v1 file
// missing these fields must keep deriving its key with these values, not
// whatever `crypto::default_params()` happens to return today, or it becomes
// permanently undecryptable and the migration below can never run.
fn legacy_m_cost() -> u32 {
    19 * 1024
}
fn legacy_t_cost() -> u32 {
    2
}
fn legacy_p_cost() -> u32 {
    1
}

/// The pre-wrapper format: the Argon2id output *was* the file key, so there
/// was exactly one way into a vault and no place to record alternatives.
#[derive(Deserialize)]
struct V1File {
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

/// The current format: a random DEK encrypts the entries, and every enabled
/// unlock method contributes one wrapper holding its own encrypted copy of
/// that DEK.
#[derive(Serialize, Deserialize)]
struct V2File {
    version: u32,
    nonce: String,
    ciphertext: String,
    wrappers: Vec<StoredWrapper>,
}

enum AnyFile {
    V1(V1File),
    V2(V2File),
}

fn decode_b64(what: &str, value: &str) -> Result<Vec<u8>, VaultError> {
    BASE64
        .decode(value)
        .map_err(|e| VaultError::Corrupt(format!("invalid {what}: {e}")))
}

/// Dispatches on the `version` field rather than trying both shapes in turn:
/// an untagged attempt would report a corrupt v2 file as "not a valid v1
/// file either", which is the least useful thing you can tell someone whose
/// credentials won't open.
fn read_any(path: &Path) -> Result<AnyFile, VaultError> {
    let contents = std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            VaultError::NotFound
        } else {
            VaultError::Io(e)
        }
    })?;
    let value: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| VaultError::Corrupt(e.to_string()))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| VaultError::Corrupt("missing format version".into()))?;

    match version {
        1 => Ok(AnyFile::V1(
            serde_json::from_value(value).map_err(|e| VaultError::Corrupt(e.to_string()))?,
        )),
        2 => Ok(AnyFile::V2(
            serde_json::from_value(value).map_err(|e| VaultError::Corrupt(e.to_string()))?,
        )),
        other => Err(VaultError::UnsupportedVersion(other as u32)),
    }
}

/// Short random identifier, distinct from the wrapper's kind so a method can
/// be removed and re-enrolled without the new wrapper inheriting the old
/// one's AEAD binding.
fn new_wrapper_id() -> String {
    crypto::random_bytes::<8>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn wrapper_index(wrappers: &[StoredWrapper], kind: WrapperKind) -> Option<usize> {
    wrappers.iter().position(|w| w.params.kind() == kind)
}

/// An unlocked vault: decrypted entries live in memory only for as long as
/// this value does. Every mutation re-encrypts and persists immediately
/// (no separate "save" step to forget).
///
/// No explicit `Drop`: `Dek` is `ZeroizeOnDrop` and each `VaultSecret` in
/// `entries` derives it too, so drop glue already wipes everything sensitive.
/// The previous hand-written `Drop` existed only because the key was a bare
/// `[u8; 32]` that nothing else would have cleaned up.
pub struct Vault {
    path: PathBuf,
    /// Random, independent of every unlock method. Adding, removing, or
    /// re-enrolling a method — or changing the master password — rewraps this
    /// key but never re-encrypts a single credential.
    dek: Dek,
    wrappers: Vec<StoredWrapper>,
    entries: HashMap<String, VaultSecret>,
}

/// Hand-written rather than derived: a derived `Debug` would walk into
/// `entries` and print every stored password in the clear, since `VaultSecret`
/// derives `Debug` for its own reasons. This reports shape, not contents.
impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("path", &self.path)
            .field("unlock_methods", &self.unlock_methods())
            .field("entries", &self.entries.len())
            .finish_non_exhaustive()
    }
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

/// The non-secret description of every unlock method a vault offers, without
/// unlocking it — this is what the UI needs at launch to decide which buttons
/// to show and how to label them. A v1 file has no wrappers at all, so it
/// reports the one method it has always had, with the parameters its header
/// carries.
pub fn wrappers_at(path: &Path) -> Result<Vec<WrapperMeta>, VaultError> {
    match read_any(path)? {
        AnyFile::V2(file) => Ok(file.wrappers.iter().map(StoredWrapper::meta).collect()),
        AnyFile::V1(file) => Ok(vec![WrapperMeta {
            id: "legacy".to_string(),
            params: WrapperParams::Password {
                salt: file.salt,
                m_cost: file.m_cost,
                t_cost: file.t_cost,
                p_cost: file.p_cost,
            },
        }]),
    }
}

/// Which unlock methods a vault offers, without unlocking it.
pub fn unlock_methods_at(path: &Path) -> Result<Vec<WrapperKind>, VaultError> {
    Ok(wrappers_at(path)?.iter().map(WrapperMeta::kind).collect())
}

impl Vault {
    /// Creates a new empty vault at `path`. Fails if a vault already exists
    /// there — callers must explicitly delete/import to replace one.
    pub fn create(path: impl Into<PathBuf>, master_password: &str) -> Result<Self, VaultError> {
        let path = path.into();
        if path.exists() {
            return Err(VaultError::AlreadyExists);
        }
        let (params, kek) = PasswordProvider::new(master_password).enroll_sync()?;
        let vault = Self::with_single_wrapper(path, Dek::random(), HashMap::new(), params, &kek)?;
        vault.persist()?;
        Ok(vault)
    }

    /// Unlocks with the master password, migrating a v1 file to v2 in the
    /// process. Kept synchronous — Argon2id needs no I/O, and every existing
    /// caller is simpler for it; the async [`Vault::unlock_with`] exists for
    /// providers that must prompt.
    pub fn unlock(path: impl Into<PathBuf>, master_password: &str) -> Result<Self, VaultError> {
        let path = path.into();
        let provider = PasswordProvider::new(master_password);

        match read_any(&path)? {
            AnyFile::V2(file) => {
                let index = wrapper_index(&file.wrappers, WrapperKind::Password)
                    .ok_or(VaultError::NoSuchUnlockMethod(WrapperKind::Password))?;
                let WrapperParams::Password {
                    salt,
                    m_cost,
                    t_cost,
                    p_cost,
                } = &file.wrappers[index].params
                else {
                    unreachable!("wrapper_index matched on kind");
                };
                let kek = provider.derive(salt, *m_cost, *t_cost, *p_cost)?;
                Self::open_v2(path, file, index, &kek)
            }
            AnyFile::V1(file) => {
                let legacy_kek =
                    provider.derive(&file.salt, file.m_cost, file.t_cost, file.p_cost)?;
                // Decrypt before enrolling, so a mistyped password costs one
                // Argon2id run rather than two.
                let entries = Self::v1_entries(&file, &legacy_kek)?;
                let (params, kek) = provider.enroll_sync()?;
                Self::finish_migration(path, entries, params, &kek)
            }
        }
    }

    /// Unlocks with any registered method. The provider is asked for its KEK
    /// exactly once, and only after we know a wrapper of its kind exists —
    /// `kek_for` may put a prompt on screen, so it must never be called
    /// speculatively.
    pub async fn unlock_with(
        path: impl Into<PathBuf>,
        provider: &dyn KeyProvider,
    ) -> Result<Self, VaultError> {
        let path = path.into();
        let kind = provider.kind();

        match read_any(&path)? {
            AnyFile::V2(file) => {
                let index = wrapper_index(&file.wrappers, kind)
                    .ok_or(VaultError::NoSuchUnlockMethod(kind))?;
                let kek = provider.kek_for(&file.wrappers[index].meta()).await?;
                Self::open_v2(path, file, index, &kek)
            }
            AnyFile::V1(file) if kind == WrapperKind::Password => {
                // A v1 file's key is Argon2id(password, its salt, its params)
                // — which is precisely what a password provider computes from
                // a `WrapperParams::Password`. Handing it a synthetic wrapper
                // built from the v1 header lets the migration run through the
                // ordinary trait surface, with no back door for reading the
                // password out of the provider.
                let synthetic = WrapperMeta {
                    id: "legacy".to_string(),
                    params: WrapperParams::Password {
                        salt: file.salt.clone(),
                        m_cost: file.m_cost,
                        t_cost: file.t_cost,
                        p_cost: file.p_cost,
                    },
                };
                let legacy_kek = provider.kek_for(&synthetic).await?;
                let entries = Self::v1_entries(&file, &legacy_kek)?;
                let (params, kek) = provider.enroll().await?;
                Self::finish_migration(path, entries, params, &kek)
            }
            // Nothing else can open a v1 file: its only key comes from the
            // master password, so there is no DEK to rewrap until that has
            // happened once.
            AnyFile::V1(_) => Err(VaultError::NeedsMasterPassword(kind)),
        }
    }

    fn open_v2(path: PathBuf, file: V2File, index: usize, kek: &Kek) -> Result<Self, VaultError> {
        let dek = wrapper::unwrap_dek(kek, &file.wrappers[index])?;
        let nonce = decode_b64("entries nonce", &file.nonce)?;
        let ciphertext = decode_b64("entries ciphertext", &file.ciphertext)?;

        // The DEK already authenticated against its wrapper's AEAD tag, so a
        // failure here is genuine damage to the entries blob and must not be
        // reported as a wrong password.
        // `Zeroizing` because this buffer is every credential in the vault, in
        // the clear, as JSON. `VaultSecret` and `Dek` are `ZeroizeOnDrop`, so
        // this intermediate was the one copy of the same bytes that would have
        // been released back to the allocator intact.
        //
        // `serde_json`'s own internal scratch buffers are still unaddressed
        // and can't be from here; that's a limitation of parsing secrets with
        // serde at all, and closing this doesn't pretend otherwise.
        let plaintext = zeroize::Zeroizing::new(
            crypto::decrypt(dek.as_bytes(), &nonce, &ciphertext, crypto::ENTRIES_AAD).ok_or_else(
                || {
                    VaultError::Corrupt(
                        "the unlock key was correct but the entries could not be decrypted — \
                         the vault file is damaged"
                            .into(),
                    )
                },
            )?,
        );
        let entries: HashMap<String, VaultSecret> =
            serde_json::from_slice(&plaintext).map_err(|e| VaultError::Corrupt(e.to_string()))?;

        Ok(Self {
            path,
            dek,
            wrappers: file.wrappers,
            entries,
        })
    }

    /// v1 entries were sealed under the password-derived key directly, with
    /// no associated data.
    fn v1_entries(
        file: &V1File,
        legacy_kek: &Kek,
    ) -> Result<HashMap<String, VaultSecret>, VaultError> {
        let nonce = decode_b64("nonce", &file.nonce)?;
        let ciphertext = decode_b64("ciphertext", &file.ciphertext)?;
        // Same reasoning as `open_v2` — this is the v1 file's entire credential
        // set in the clear.
        let plaintext = zeroize::Zeroizing::new(
            crypto::decrypt(legacy_kek.as_bytes(), &nonce, &ciphertext, b"")
                .ok_or(VaultError::WrongPassword)?,
        );
        serde_json::from_slice(&plaintext).map_err(|e| VaultError::Corrupt(e.to_string()))
    }

    /// Completes a v1 → v2 upgrade by re-keying onto a **fresh** DEK rather
    /// than adopting the old password-derived key as the DEK.
    ///
    /// That costs one re-encryption of a file measured in kilobytes, and buys
    /// something worth much more: every copy of the old key stops being
    /// useful the moment the rename lands. In particular the plaintext copy
    /// that v1's "unlock with Windows sign-in" left sitting in the OS
    /// credential store — the weakness this whole format change exists to
    /// close — is dead weight afterwards instead of a live key to the vault.
    fn finish_migration(
        path: PathBuf,
        entries: HashMap<String, VaultSecret>,
        params: WrapperParams,
        kek: &Kek,
    ) -> Result<Self, VaultError> {
        let vault = Self::with_single_wrapper(path, Dek::random(), entries, params, kek)?;
        vault.persist()?;
        Ok(vault)
    }

    fn with_single_wrapper(
        path: PathBuf,
        dek: Dek,
        entries: HashMap<String, VaultSecret>,
        params: WrapperParams,
        kek: &Kek,
    ) -> Result<Self, VaultError> {
        let id = new_wrapper_id();
        let (nonce, wrapped_dek) = wrapper::wrap_dek(kek, &dek, &id, params.kind())?;
        Ok(Self {
            path,
            dek,
            wrappers: vec![StoredWrapper {
                id,
                params,
                nonce,
                wrapped_dek,
            }],
            entries,
        })
    }

    /// Enables an unlock method on an already-unlocked vault, replacing any
    /// existing wrapper of the same kind (re-enrolling Windows Hello after a
    /// PIN reset takes this path).
    pub async fn add_unlock_method(
        &mut self,
        provider: &dyn KeyProvider,
    ) -> Result<(), VaultError> {
        let (params, kek) = provider.enroll().await?;
        self.add_enrolled_unlock_method(params, &kek)
    }

    /// The second half of [`Vault::add_unlock_method`], for callers that need
    /// to run enrolment *outside* whatever lock guards this vault.
    ///
    /// That separation matters more than it looks: enrolment can sit for as
    /// long as a user takes to answer a Windows Hello prompt, and holding the
    /// vault's mutex across that stalls every other vault operation behind
    /// it — including the ones the UI uses to notice that anything is
    /// happening. Worse, repeated attempts queue up on the mutex rather than
    /// failing fast, so each one raises its own prompt in turn.
    pub fn add_enrolled_unlock_method(
        &mut self,
        params: WrapperParams,
        kek: &Kek,
    ) -> Result<(), VaultError> {
        let kind = params.kind();
        let id = new_wrapper_id();
        let (nonce, wrapped_dek) = wrapper::wrap_dek(kek, &self.dek, &id, kind)?;

        let mut updated: Vec<StoredWrapper> = self
            .wrappers
            .iter()
            .filter(|w| w.params.kind() != kind)
            .cloned()
            .collect();
        updated.push(StoredWrapper {
            id,
            params,
            nonce,
            wrapped_dek,
        });

        // Swap first, then persist, then roll back on failure — leaving the
        // in-memory wrapper list ahead of the file would have this vault
        // reporting a method that a restart wouldn't find.
        let previous = std::mem::replace(&mut self.wrappers, updated);
        if let Err(e) = self.persist() {
            self.wrappers = previous;
            return Err(e);
        }
        Ok(())
    }

    pub fn remove_unlock_method(&mut self, kind: WrapperKind) -> Result<(), VaultError> {
        // A vault reachable only through hardware-backed unlock is one PIN
        // reset, TPM clear, or dead motherboard away from being gone for
        // good — and in the Windows Hello case, one Microsoft change to
        // signature determinism away as well. The master password is the
        // fallback that makes every other method safe to rely on, so it
        // isn't removable. (If you decide that's too paternalistic, this is
        // the single line to drop — but read the note on
        // `WrapperParams::Hello` first.)
        if kind == WrapperKind::Password {
            return Err(VaultError::PasswordRequired);
        }
        if wrapper_index(&self.wrappers, kind).is_none() {
            return Err(VaultError::NoSuchUnlockMethod(kind));
        }
        if self.wrappers.len() <= 1 {
            return Err(VaultError::LastUnlockMethod);
        }

        let previous = self.wrappers.clone();
        self.wrappers.retain(|w| w.params.kind() != kind);
        if let Err(e) = self.persist() {
            self.wrappers = previous;
            return Err(e);
        }
        Ok(())
    }

    pub fn unlock_methods(&self) -> Vec<WrapperKind> {
        self.wrappers.iter().map(|w| w.params.kind()).collect()
    }

    pub fn has_unlock_method(&self, kind: WrapperKind) -> bool {
        wrapper_index(&self.wrappers, kind).is_some()
    }

    /// Re-wraps the DEK under a new password. Note what this *doesn't* do:
    /// touch a single credential. In v1 the password derived the file key, so
    /// changing it meant decrypting and re-encrypting everything; here it's
    /// one 32-byte rewrap. The caller is responsible for having established
    /// that the person asking is the owner — possession of an unlocked vault
    /// is normally that proof.
    pub async fn change_master_password(&mut self, new_password: &str) -> Result<(), VaultError> {
        self.add_unlock_method(&PasswordProvider::new(new_password))
            .await
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
        // The decrypt side of this round-trip is `Zeroizing` for the same
        // reason: serialised entries are every credential in the clear, and
        // this buffer outlives the encrypt call that consumes it.
        let plaintext = zeroize::Zeroizing::new(
            serde_json::to_vec(&self.entries).map_err(|e| VaultError::Corrupt(e.to_string()))?,
        );
        let (nonce, ciphertext) =
            crypto::encrypt(self.dek.as_bytes(), &plaintext, crypto::ENTRIES_AAD)?;

        let file = V2File {
            version: FORMAT_VERSION,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
            wrappers: self.wrappers.clone(),
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
    use crate::provider::ProviderError;
    use async_trait::async_trait;

    fn vault_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("vault.wrv")
    }

    /// Stands in for Windows Hello / the OS keyring: a provider whose KEK
    /// comes from somewhere the vault can't reach. `kek` is fixed so a test
    /// can simulate the key changing underneath us (a reset PIN) simply by
    /// building a second one.
    struct FakeProvider {
        kind: WrapperKind,
        kek: [u8; 32],
        calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeProvider {
        fn new(kind: WrapperKind, byte: u8) -> Self {
            Self {
                kind,
                kek: [byte; 32],
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl KeyProvider for FakeProvider {
        fn kind(&self) -> WrapperKind {
            self.kind
        }
        async fn kek_for(&self, meta: &WrapperMeta) -> Result<Kek, ProviderError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if meta.kind() != self.kind {
                return Err(ProviderError::WrongKind {
                    expected: self.kind,
                    found: meta.kind(),
                });
            }
            Ok(Kek::from_bytes(self.kek))
        }
        async fn enroll(&self) -> Result<(WrapperParams, Kek), ProviderError> {
            Ok((WrapperParams::OsKeyring {}, Kek::from_bytes(self.kek)))
        }
    }

    fn pw_secret(v: &str) -> VaultSecret {
        VaultSecret::Password {
            password: v.to_string(),
        }
    }

    // ---- basics, carried over from v1 ------------------------------------

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
            other => panic!("expected WrongPassword, got {other:?}"),
        }
    }

    #[test]
    fn creating_twice_at_same_path_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "pw").unwrap());

        match Vault::create(&path, "pw") {
            Err(VaultError::AlreadyExists) => {}
            other => panic!("expected AlreadyExists, got {other:?}"),
        }
    }

    #[test]
    fn set_persists_across_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault.set("session-1".into(), pw_secret("hunter2")).unwrap();
        drop(vault);

        let reopened = Vault::unlock(&path, "pw").unwrap();
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
                "session-1".into(),
                VaultSecret::Passphrase {
                    passphrase: "key-pass".into(),
                },
            )
            .unwrap();
        vault.remove("session-1").unwrap();
        assert!(!vault.has("session-1"));
        assert!(!Vault::unlock(&path, "pw").unwrap().has("session-1"));
    }

    #[test]
    fn unlocking_missing_file_reports_not_found() {
        let dir = tempfile::tempdir().unwrap();
        match Vault::unlock(vault_path(&dir), "pw") {
            Err(VaultError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_newer_format_version_is_reported_as_such_not_as_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        std::fs::write(&path, r#"{"version":99}"#).unwrap();
        match Vault::unlock(&path, "pw") {
            Err(VaultError::UnsupportedVersion(99)) => {}
            other => panic!("expected UnsupportedVersion(99), got {other:?}"),
        }
    }

    // ---- v1 migration ----------------------------------------------------

    /// Builds a genuine v1 file the way the old code did: Argon2id output
    /// used directly as the AEAD key, no wrappers, no associated data.
    fn write_v1_file(path: &Path, password: &str, entries: &HashMap<String, VaultSecret>) {
        let salt = crypto::random_salt();
        let params = argon2::Params::new(19 * 1024, 2, 1, None).unwrap();
        let key = crypto::derive_kek_from_password(password, &salt, params).unwrap();
        let plaintext = serde_json::to_vec(entries).unwrap();
        let (nonce, ciphertext) = crypto::encrypt(key.as_bytes(), &plaintext, b"").unwrap();
        let json = serde_json::json!({
            "version": 1,
            "salt": BASE64.encode(salt),
            "nonce": BASE64.encode(nonce),
            "ciphertext": BASE64.encode(ciphertext),
        });
        std::fs::write(path, json.to_string()).unwrap();
    }

    /// A v1 file predating the m_cost/t_cost/p_cost fields must keep
    /// unlocking with the exact params it was actually encrypted with
    /// (`argon2`'s own old `Params::default()`) — not today's stronger
    /// defaults — or every vault created before that change becomes
    /// permanently undecryptable.
    #[test]
    fn legacy_v1_vault_without_kdf_params_still_unlocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut entries = HashMap::new();
        entries.insert("session-1".to_string(), pw_secret("hunter2"));
        write_v1_file(&path, "legacy pw", &entries);

        let vault = Vault::unlock(&path, "legacy pw").unwrap();
        match vault.get("session-1") {
            Some(VaultSecret::Password { password }) => assert_eq!(password, "hunter2"),
            other => panic!("expected the v1 credential to survive, got {other:?}"),
        }
    }

    #[test]
    fn unlocking_a_v1_vault_rewrites_it_as_v2_with_a_password_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        write_v1_file(&path, "pw", &HashMap::new());

        drop(Vault::unlock(&path, "pw").unwrap());

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["version"], 2);
        assert_eq!(json["wrappers"].as_array().unwrap().len(), 1);
        assert_eq!(json["wrappers"][0]["params"]["kind"], "password");
        assert!(
            json.get("salt").is_none(),
            "v1's top-level salt should be gone"
        );

        // And it still opens on the next launch, through the v2 path.
        assert!(Vault::unlock(&path, "pw").is_ok());
    }

    /// The migration must re-key rather than adopt the old key, or every
    /// copy of that old key — including the plaintext one v1 left in the OS
    /// credential store — would still open the migrated vault.
    #[test]
    fn migration_re_encrypts_under_a_fresh_dek() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        write_v1_file(&path, "pw", &HashMap::new());

        let v1_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let v1_salt = BASE64.decode(v1_json["salt"].as_str().unwrap()).unwrap();
        let v1_key = crypto::derive_kek_from_password(
            "pw",
            &v1_salt,
            argon2::Params::new(19 * 1024, 2, 1, None).unwrap(),
        )
        .unwrap();

        drop(Vault::unlock(&path, "pw").unwrap());

        let v2_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let nonce = BASE64.decode(v2_json["nonce"].as_str().unwrap()).unwrap();
        let ciphertext = BASE64
            .decode(v2_json["ciphertext"].as_str().unwrap())
            .unwrap();
        assert!(
            crypto::decrypt(v1_key.as_bytes(), &nonce, &ciphertext, crypto::ENTRIES_AAD).is_none(),
            "the old v1 key must no longer decrypt the migrated entries"
        );
    }

    /// A failed migration must not touch the file — otherwise a mistyped
    /// password at the wrong moment destroys the vault.
    #[test]
    fn a_wrong_password_leaves_a_v1_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        write_v1_file(&path, "right", &HashMap::new());
        let before = std::fs::read_to_string(&path).unwrap();

        match Vault::unlock(&path, "wrong") {
            Err(VaultError::WrongPassword) => {}
            other => panic!("expected WrongPassword, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[tokio::test]
    async fn a_non_password_method_cannot_open_a_v1_vault() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        write_v1_file(&path, "pw", &HashMap::new());

        let provider = FakeProvider::new(WrapperKind::OsKeyring, 0xAA);
        match Vault::unlock_with(&path, &provider).await {
            Err(VaultError::NeedsMasterPassword(WrapperKind::OsKeyring)) => {}
            other => panic!("expected NeedsMasterPassword, got {other:?}"),
        }
        assert_eq!(
            provider.calls(),
            0,
            "must not prompt the user before discovering there's nothing to unlock"
        );
    }

    #[tokio::test]
    async fn a_password_provider_migrates_a_v1_vault_through_the_trait() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut entries = HashMap::new();
        entries.insert("s1".to_string(), pw_secret("hunter2"));
        write_v1_file(&path, "pw", &entries);

        let vault = Vault::unlock_with(&path, &PasswordProvider::new("pw"))
            .await
            .unwrap();
        assert!(vault.has("s1"));
        assert_eq!(vault.unlock_methods(), vec![WrapperKind::Password]);
    }

    // ---- multiple unlock methods -----------------------------------------

    #[tokio::test]
    async fn a_second_method_opens_the_same_vault() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault.set("s1".into(), pw_secret("hunter2")).unwrap();

        let provider = FakeProvider::new(WrapperKind::OsKeyring, 0xAA);
        vault.add_unlock_method(&provider).await.unwrap();
        drop(vault);

        let via_provider = Vault::unlock_with(&path, &provider).await.unwrap();
        assert!(via_provider.has("s1"));
        // ...and the password still works, unchanged.
        assert!(Vault::unlock(&path, "pw").unwrap().has("s1"));
    }

    #[tokio::test]
    async fn a_method_whose_key_changed_reports_unlock_failed() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault
            .add_unlock_method(&FakeProvider::new(WrapperKind::OsKeyring, 0xAA))
            .await
            .unwrap();
        drop(vault);

        // Same kind, different key — a reset PIN, a cleared Hello container.
        let rotated = FakeProvider::new(WrapperKind::OsKeyring, 0xBB);
        match Vault::unlock_with(&path, &rotated).await {
            Err(VaultError::UnlockFailed(WrapperKind::OsKeyring)) => {}
            other => panic!("expected UnlockFailed, got {other:?}"),
        }
        // The password must remain unaffected by the broken method.
        assert!(Vault::unlock(&path, "pw").is_ok());
    }

    #[tokio::test]
    async fn re_enrolling_replaces_rather_than_duplicates_a_method() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();

        vault
            .add_unlock_method(&FakeProvider::new(WrapperKind::OsKeyring, 0xAA))
            .await
            .unwrap();
        let replacement = FakeProvider::new(WrapperKind::OsKeyring, 0xBB);
        vault.add_unlock_method(&replacement).await.unwrap();
        assert_eq!(vault.unlock_methods().len(), 2, "password + one os-keyring");
        drop(vault);

        assert!(Vault::unlock_with(&path, &replacement).await.is_ok());
        assert!(
            Vault::unlock_with(&path, &FakeProvider::new(WrapperKind::OsKeyring, 0xAA))
                .await
                .is_err(),
            "the superseded key must stop working"
        );
    }

    #[tokio::test]
    async fn an_unregistered_method_is_reported_before_any_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "pw").unwrap());

        let provider = FakeProvider::new(WrapperKind::Hello, 0xAA);
        match Vault::unlock_with(&path, &provider).await {
            Err(VaultError::NoSuchUnlockMethod(WrapperKind::Hello)) => {}
            other => panic!("expected NoSuchUnlockMethod, got {other:?}"),
        }
        assert_eq!(provider.calls(), 0);
    }

    #[tokio::test]
    async fn removing_a_method_takes_effect_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        let provider = FakeProvider::new(WrapperKind::OsKeyring, 0xAA);
        vault.add_unlock_method(&provider).await.unwrap();
        vault.remove_unlock_method(WrapperKind::OsKeyring).unwrap();
        drop(vault);

        assert_eq!(
            unlock_methods_at(&path).unwrap(),
            vec![WrapperKind::Password]
        );
        match Vault::unlock_with(&path, &provider).await {
            Err(VaultError::NoSuchUnlockMethod(WrapperKind::OsKeyring)) => {}
            other => panic!("expected NoSuchUnlockMethod, got {other:?}"),
        }
    }

    #[test]
    fn the_master_password_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        match vault.remove_unlock_method(WrapperKind::Password) {
            Err(VaultError::PasswordRequired) => {}
            other => panic!("expected PasswordRequired, got {other:?}"),
        }
    }

    #[test]
    fn removing_a_method_that_was_never_enabled_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        match vault.remove_unlock_method(WrapperKind::Hello) {
            Err(VaultError::NoSuchUnlockMethod(WrapperKind::Hello)) => {}
            other => panic!("expected NoSuchUnlockMethod, got {other:?}"),
        }
    }

    // ---- password change --------------------------------------------------

    #[tokio::test]
    async fn changing_the_master_password_keeps_credentials_and_other_methods() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "old pw").unwrap();
        vault.set("s1".into(), pw_secret("hunter2")).unwrap();
        let provider = FakeProvider::new(WrapperKind::OsKeyring, 0xAA);
        vault.add_unlock_method(&provider).await.unwrap();

        vault.change_master_password("new pw").await.unwrap();
        drop(vault);

        assert!(Vault::unlock(&path, "new pw").unwrap().has("s1"));
        assert!(matches!(
            Vault::unlock(&path, "old pw"),
            Err(VaultError::WrongPassword)
        ));
        assert!(
            Vault::unlock_with(&path, &provider)
                .await
                .unwrap()
                .has("s1"),
            "changing the password must not disturb other unlock methods"
        );
    }

    // ---- file hygiene -----------------------------------------------------

    /// `persist()` writes to a temp file and renames it over the target
    /// (atomic on the same volume) rather than truncating in place — this
    /// confirms that mechanism actually leaves no stray temp file behind.
    #[test]
    fn persist_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault.set("session-1".into(), pw_secret("hunter2")).unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("vault.wrv")]);
    }

    /// Nothing in the file may be readable without a key — in particular the
    /// wrappers section, which is the part that's new and the part most
    /// likely to grow an accidental plaintext field.
    #[test]
    fn the_persisted_file_contains_no_plaintext_secret() {
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        let mut vault = Vault::create(&path, "pw").unwrap();
        vault
            .set("session-1".into(), pw_secret("swordfish-9182"))
            .unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(!contents.contains("swordfish-9182"));
        assert!(!contents.contains("session-1"), "entry ids are secrets too");
    }

    #[cfg(unix)]
    #[test]
    fn persisted_vault_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = vault_path(&dir);
        drop(Vault::create(&path, "pw").unwrap());
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
