//! Per-connection `unreviewed-changes.json` stash file (DEV-10523).
//!
//! When `files download` pulls a server advance while the worktree holds
//! **unreviewed** edits (`local != approved`), those edits are re-applied on
//! top of the freshly-pulled state user-wins (see
//! [`crate::shared::re_anchor`] and the per-connection algorithm in
//! `download_single_repo`). Most edits re-apply cleanly. The narrow set that
//! **can't** be re-applied — the server deleted the very record the user was
//! editing, or the patch genuinely fails to reconstruct — would otherwise be
//! lost when `materialize_local_repo` overwrites the worktree with the new
//! approved state.
//!
//! This file is the recovery artifact for exactly those hard-conflict records.
//! It is written (with each record's **full intended content** as a
//! self-contained `Create`-shaped entry, since the base it was diffed against
//! no longer exists) **before** the worktree is overwritten, so a crash mid-pull
//! can't drop the user's work. It is a manual/AI recovery artifact — nothing
//! auto-replays it on a later pull.
//!
//! It lives at
//! `<workspace>/.scratch/connections/<conn>/unreviewed-changes.json`, sibling to
//! `accepted-patches.json`, and uses the same `{ version, patches }` envelope
//! (`Vec<AnchoredPatch>`) so an agent can fold entries into
//! `accepted-patches.json` if desired. All mutating callers must hold the
//! workspace `.scratch/lock`.

// `shared` is compiled for both binaries; only the CLI reaches into this
// module today. Allow at module scope to keep the service binary's build
// warning-clean without per-item annotations.
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::shared::re_anchor::AnchoredPatch;

const FILENAME: &str = "unreviewed-changes.json";

/// On-disk schema version written by this build. Shares the
/// [`crate::shared::accepted_patches::FORMAT_VERSION`] semantics: an `Update`
/// body may be RFC 6902 or legacy RFC 7396, dispatched per entry by shape at
/// read time. A file written by a newer build is refused rather than
/// mis-reconstructed.
pub const FORMAT_VERSION: u32 = 2;

/// serde fill for a `version` key absent from an older on-disk file.
fn legacy_format_version() -> u32 {
    1
}

/// On-disk wrapper. The in-memory shape carries only `patches`; the file-level
/// `version` is a pure serialization-boundary concern ([`save_atomic`] always
/// writes [`FORMAT_VERSION`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UnreviewedChangesFile {
    #[serde(default)]
    pub patches: Vec<AnchoredPatch>,
}

/// The `version` + `patches` envelope as it actually sits on disk. Used only to
/// read the version marker; everyday loads go through [`load`] which
/// deserializes straight into [`UnreviewedChangesFile`] (serde ignores the
/// extra `version` key).
#[derive(Debug, Deserialize)]
struct VersionedEnvelope {
    #[serde(default = "legacy_format_version")]
    version: u32,
}

/// Resolve the file path for a given connection directory
/// (`<workspace>/.scratch/connections/<conn>`).
pub fn path(connection_dir: &Path) -> PathBuf {
    connection_dir.join(FILENAME)
}

/// Load the file. Returns `Default::default()` if it doesn't exist on disk —
/// "no stashed conflicts" and "no file yet" are the same state.
pub fn load(connection_dir: &Path) -> anyhow::Result<UnreviewedChangesFile> {
    let p = path(connection_dir);
    if !p.exists() {
        return Ok(UnreviewedChangesFile::default());
    }
    let bytes = fs::read(&p)
        .with_context(|| format!("failed to read unreviewed changes at {}", p.display()))?;
    if bytes.is_empty() {
        // A zero-byte file from a previous crash between create + write —
        // treat as empty rather than failing parse.
        return Ok(UnreviewedChangesFile::default());
    }
    // Refuse a file written by a newer scratchmd rather than mis-reconstruct
    // its patch bodies (mirrors accepted-patches.json's guard).
    let envelope: VersionedEnvelope = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse unreviewed changes at {}", p.display()))?;
    if envelope.version > FORMAT_VERSION {
        anyhow::bail!(
            "unreviewed-changes.json at {} was written by a newer scratchmd (format version {}, this build supports {}); upgrade scratchmd to read this workspace",
            p.display(),
            envelope.version,
            FORMAT_VERSION,
        );
    }
    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse unreviewed changes at {}", p.display()))
}

/// Atomic write: write to `<file>.tmp.<pid>`, fsync, rename. Matches git's own
/// `.git/index.lock` discipline; callers are expected to already hold
/// `.scratch/lock`.
pub fn save_atomic(connection_dir: &Path, file: &UnreviewedChangesFile) -> anyhow::Result<()> {
    fs::create_dir_all(connection_dir).with_context(|| {
        format!(
            "failed to create connection dir {}",
            connection_dir.display()
        )
    })?;
    let final_path = path(connection_dir);
    let tmp_path = connection_dir.join(format!("{FILENAME}.tmp.{}", std::process::id()));
    #[derive(Serialize)]
    struct OnDisk<'a> {
        version: u32,
        patches: &'a [AnchoredPatch],
    }
    let bytes = serde_json::to_vec_pretty(&OnDisk {
        version: FORMAT_VERSION,
        patches: &file.patches,
    })
    .context("failed to serialize unreviewed changes")?;
    {
        let mut f = fs::File::create(&tmp_path)
            .with_context(|| format!("failed to open {}", tmp_path.display()))?;
        f.write_all(&bytes)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
    }
    fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("failed to rename to {}", final_path.display()))?;
    Ok(())
}

/// Remove the stash file if it exists. No-op when absent. Used on a clean pull
/// (no hard conflicts) to clear a stash this run wrote during a crash-safety
/// pre-write. Never deletes a leftover stash that this run did not itself
/// create — callers only invoke this after writing one.
pub fn delete_if_present(connection_dir: &Path) -> anyhow::Result<()> {
    let p = path(connection_dir);
    if p.exists() {
        fs::remove_file(&p).with_context(|| format!("failed to remove {}", p.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::re_anchor::PatchKind;
    use serde_json::json;
    use tempfile::tempdir;

    fn create_entry(path: &str, content: serde_json::Value) -> AnchoredPatch {
        AnchoredPatch {
            path: path.to_string(),
            kind: PatchKind::Create,
            patch: content,
            revert: false,
        }
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), UnreviewedChangesFile::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().unwrap();
        let file = UnreviewedChangesFile {
            patches: vec![create_entry(
                "Companies/rec_1.json",
                json!({"name": "Acme"}),
            )],
        };
        save_atomic(dir.path(), &file).unwrap();
        assert_eq!(load(dir.path()).unwrap(), file);
    }

    #[test]
    fn save_stamps_current_version() {
        let dir = tempdir().unwrap();
        save_atomic(dir.path(), &UnreviewedChangesFile::default()).unwrap();
        let raw = fs::read_to_string(path(dir.path())).unwrap();
        assert!(
            raw.contains("\"version\""),
            "saved file must carry a version marker"
        );
    }

    #[test]
    fn save_atomic_leaves_no_tmp_files() {
        let dir = tempdir().unwrap();
        save_atomic(dir.path(), &UnreviewedChangesFile::default()).unwrap();
        let leftover_tmp = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp."));
        assert!(!leftover_tmp, "no .tmp.<pid> file should survive the write");
    }

    #[test]
    fn delete_if_present_removes_then_is_noop() {
        let dir = tempdir().unwrap();
        save_atomic(dir.path(), &UnreviewedChangesFile::default()).unwrap();
        assert!(path(dir.path()).exists());
        delete_if_present(dir.path()).unwrap();
        assert!(!path(dir.path()).exists());
        // Second call is a no-op (file already gone).
        delete_if_present(dir.path()).unwrap();
    }

    #[test]
    fn load_rejects_a_newer_format_version() {
        let dir = tempdir().unwrap();
        fs::write(path(dir.path()), br#"{"version":999,"patches":[]}"#).unwrap();
        assert!(load(dir.path()).is_err(), "newer version must be refused");
    }

    #[test]
    fn load_accepts_current_and_legacy_versions() {
        let dir = tempdir().unwrap();
        fs::write(path(dir.path()), br#"{"version":2,"patches":[]}"#).unwrap();
        assert!(load(dir.path()).is_ok(), "current version must load");
        fs::write(path(dir.path()), br#"{"patches":[]}"#).unwrap();
        assert!(
            load(dir.path()).is_ok(),
            "legacy (versionless) file must load"
        );
    }
}
