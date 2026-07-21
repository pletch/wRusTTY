//! The two key types the vault deals in, kept distinct at the type level.
//!
//! A vault holds exactly one **DEK** (data encryption key) that encrypts the
//! credential entries, and any number of **KEK**s (key encryption keys), one
//! per enabled unlock method, each of which wraps its own copy of that DEK.
//! Mixing the two up — wrapping the DEK under itself, say — is a silent,
//! catastrophic bug that produces a file which still round-trips in tests, so
//! they get separate types rather than a shared `[u8; 32]` alias.

use zeroize::ZeroizeOnDrop;

pub const KEY_LEN: usize = 32;

macro_rules! secret_key_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        ///
        /// Deliberately neither `Copy` nor `Debug`. A `Copy` key type spawns
        /// un-zeroized duplicates at every use site without anyone writing
        /// anything that looks like a copy (which is exactly what the old
        /// `Vault::key_bytes() -> [u8; 32]` did — it leaned on each caller
        /// remembering to `.zeroize()` its own copy afterwards), and a
        /// derived `Debug` is one stray `dbg!` away from putting key
        /// material in a log file. Copies must be spelled `.clone()`.
        #[derive(Clone, ZeroizeOnDrop)]
        pub struct $name([u8; KEY_LEN]);

        impl $name {
            pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
                Self(bytes)
            }

            pub fn random() -> Self {
                Self(crate::crypto::random_bytes())
            }

            /// Crate-internal on purpose: outside `wr-vault`, a `KeyProvider`
            /// can *construct* key material but can never read it back out,
            /// so no provider implementation can leak a key it was handed.
            pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
                &self.0
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }
    };
}

secret_key_type! {
    /// Data encryption key: encrypts the credential entries themselves.
    /// Generated once at vault creation and never derived from anything the
    /// user knows, so unlock methods can be added and removed, and the master
    /// password changed, without re-encrypting a single credential.
    Dek
}

secret_key_type! {
    /// Key encryption key: wraps the [`Dek`] for one unlock method. Produced
    /// fresh by a `KeyProvider` on every unlock and dropped immediately after
    /// the unwrap — a KEK is never written to disk.
    Kek
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_does_not_leak_key_material() {
        let dek = Dek::from_bytes([0xAB; KEY_LEN]);
        let rendered = format!("{dek:?}");
        assert_eq!(rendered, "Dek(<redacted>)");
        assert!(
            !rendered.contains("ab"),
            "key bytes must not appear in Debug"
        );
    }

    #[test]
    fn random_keys_differ() {
        assert_ne!(Dek::random().as_bytes(), Dek::random().as_bytes());
    }
}
