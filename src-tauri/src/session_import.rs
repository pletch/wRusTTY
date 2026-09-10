//! The parts every session importer shares: minting ids, appending without
//! clobbering, and saying what happened.
//!
//! There are two importers — PuTTY's registry and OpenSSH's `~/.ssh/config` —
//! and they differ only in where the sessions come from and how a foreign
//! session maps onto a [`SessionProfile`]. Everything after that mapping is
//! identical, and the identical part is the part with the sharp edges in it
//! (see [`next_id`]), so it lives here rather than being written twice.

use serde::Serialize;

use crate::profiles::SessionProfile;

/// What an import did, for the UI to report.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Profiles added.
    pub imported: usize,
    /// Sessions already present by label and host — see [`merge_into`].
    pub skipped_duplicates: usize,
    /// Sessions this app can't represent — what that means is the importer's
    /// own business (a raw-protocol PuTTY session, a wildcard `Host` pattern).
    pub skipped_unsupported: usize,
    /// Labels of what was imported, so the UI can show it rather than a count.
    pub labels: Vec<String>,
}

/// Appends the candidates that aren't already saved, leaving the rest alone.
///
/// Additive by design. A session already present — same label *and* same host —
/// is left alone rather than overwritten, so running an import twice is
/// harmless and a profile the user has since edited is never silently reverted
/// to the other client's version of it. Matching on both fields rather than the
/// label alone means an unrelated profile that happens to share a name doesn't
/// block the import.
///
/// `existing` is mutated in place: the caller holds the profile lock around the
/// whole read-modify-write, and the duplicate check has to see everything added
/// so far or two identical foreign sessions would both import.
pub fn merge_into(
    existing: &mut Vec<SessionProfile>,
    candidates: Vec<SessionProfile>,
) -> ImportSummary {
    let mut summary = ImportSummary::default();
    for profile in candidates {
        if existing
            .iter()
            .any(|p| p.label == profile.label && p.host == profile.host)
        {
            summary.skipped_duplicates += 1;
            continue;
        }
        summary.labels.push(profile.label.clone());
        summary.imported += 1;
        existing.push(profile);
    }
    summary
}

/// An id not already in use, and one that will never be minted again.
///
/// Profile ids are UUIDs when the frontend makes them, but nothing requires
/// that — they are opaque strings compared for equality. `prefix` (`"putty"`,
/// `"sshcfg"`) keeps an imported profile identifiable as such in
/// `sessions.json`; the random suffix is what makes it safe.
///
/// This counted (`putty-0`, `putty-1`, …) and picked the first free number,
/// which made ids *reusable*: deleting profiles frees their numbers, and the
/// next import hands them to different hosts. A profile id is also its vault
/// key — `resolve_auth` looks up `vault.get(&profile.id)` — and a credential
/// can outlive its profile, because deleting a profile with the vault locked
/// leaves the entry behind. A reused id therefore let a new profile silently
/// authenticate to one host with the secret saved for another, which presents
/// as a server-side problem rather than as a bug here.
///
/// Eight random bytes, the same shape as `wr-vault`'s `new_wrapper_id`. The
/// existence check stays, and is now only a formality.
pub fn next_id(existing: &[SessionProfile], prefix: &str) -> String {
    loop {
        let suffix: String = wr_vault::random_bytes::<8>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let candidate = format!("{prefix}-{suffix}");
        if !existing.iter().any(|p| p.id == candidate) {
            return candidate;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, label: &str, host: &str) -> SessionProfile {
        SessionProfile {
            id: id.to_string(),
            label: label.to_string(),
            folder: None,
            host: host.to_string(),
            port: 22,
            protocol: "ssh".to_string(),
            username: String::new(),
            auth_type: "agent".to_string(),
            key_path: None,
            has_credential: false,
            jump_profile_id: None,
            term_type: None,
            backspace_sends_ctrl_h: None,
            keepalive_seconds: None,
            wake_on_lan: None,
            auto_reconnect: None,
            import_remote_history: None,
            serial: None,
            local: None,
        }
    }

    /// The whole promise of "running one twice is harmless": an edited profile
    /// must not be reverted to the other client's version of it.
    #[test]
    fn an_already_saved_session_is_left_exactly_as_it_is() {
        let mut existing = vec![profile("mine", "prod", "10.0.0.5")];
        existing[0].username = "tim".into();

        let summary = merge_into(&mut existing, vec![profile("new", "prod", "10.0.0.5")]);

        assert_eq!(summary.imported, 0);
        assert_eq!(summary.skipped_duplicates, 1);
        assert_eq!(existing.len(), 1);
        assert_eq!(existing[0].id, "mine");
        assert_eq!(existing[0].username, "tim");
    }

    /// Matching on the label alone would let an unrelated profile that happens
    /// to share a name block the import of a real host.
    #[test]
    fn a_shared_name_on_a_different_host_still_imports() {
        let mut existing = vec![profile("mine", "router", "192.168.1.1")];
        let summary = merge_into(&mut existing, vec![profile("new", "router", "10.9.9.1")]);
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.labels, vec!["router"]);
        assert_eq!(existing.len(), 2);
    }

    /// The duplicate check has to see what this same run just added, or two
    /// identical foreign sessions both land.
    #[test]
    fn two_identical_candidates_import_once() {
        let mut existing = Vec::new();
        let summary = merge_into(
            &mut existing,
            vec![profile("a", "dup", "h"), profile("b", "dup", "h")],
        );
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.skipped_duplicates, 1);
    }

    /// A profile id is also its vault key, so an id that can come back around
    /// is a credential that can be inherited by a different host. Deleting
    /// profiles used to free their numbers for the next import to hand out.
    #[test]
    fn a_deleted_imports_id_is_never_handed_out_again() {
        let mut existing: Vec<SessionProfile> = (0..10)
            .map(|_| profile(&next_id(&[], "putty"), "h", "h"))
            .collect();

        let retired: Vec<String> = existing.split_off(8).into_iter().map(|p| p.id).collect();

        // The vault still holds an entry under each retired id: deleting a
        // profile with the vault locked can't take its credential with it.
        for _ in 0..64 {
            let minted = next_id(&existing, "putty");
            assert!(
                !retired.contains(&minted),
                "{minted} was reissued after its profile was deleted"
            );
            existing.push(profile(&minted, "h", "h"));
        }
    }

    /// The prefix is what keeps an imported profile identifiable as one in
    /// `sessions.json`, and the suffix is what makes it unrepeatable.
    #[test]
    fn imported_ids_are_prefixed_and_random() {
        let id = next_id(&[], "sshcfg");
        let suffix = id.strip_prefix("sshcfg-").expect("keeps the prefix");
        assert_eq!(suffix.len(), 16, "eight bytes as hex");
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, next_id(&[], "sshcfg"));
    }
}
