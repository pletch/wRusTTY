//! The vault's two key types, distinct at the type level: one **DEK** encrypts
//! the entries, and one **KEK** per unlock method wraps a copy of it. Mixing
//! them up (wrapping the DEK under itself) would still round-trip in tests.

use zeroize::ZeroizeOnDrop;

pub const KEY_LEN: usize = 32;

macro_rules! secret_key_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        ///
        /// Neither `Copy` (which would scatter un-zeroized duplicates) nor `Debug`
        /// (one `dbg!` from a log file). Copies must be spelled `.clone()`.
        #[derive(Clone, ZeroizeOnDrop)]
        pub struct $name([u8; KEY_LEN]);

        impl $name {
            pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
                Self(bytes)
            }

            pub fn random() -> Self {
                Self(crate::crypto::random_bytes())
            }

            /// Crate-internal: a `KeyProvider` outside `wr-vault` can construct key
            /// material but never read it back.
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
    /// Data encryption key for the credential entries. Random, never derived
    /// from anything the user knows, so unlock methods and the master password
    /// change without re-encrypting entries.
    Dek
}

secret_key_type! {
    /// Key encryption key: wraps the [`Dek`] for one unlock method. Produced on
    /// each unlock and dropped right after; never written to disk.
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
