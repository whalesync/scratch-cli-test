//! Per-connection `failed-patches.json` file (publish redesign, DEV-10048).
//!
//! Sibling to `accepted-patches.json` at
//! `<workspace>/.scratch/connections/<conn>/failed-patches.json`. After a publish,
//! a record the destination connector **rejected** moves out of
//! `accepted-patches.json` and into this file, carrying the connector's error so
//! the grid can re-surface it as a needs-approval edit with a per-field warning.
//!
//! The envelope mirrors `accepted-patches.json` (`{ version, patches }`) with one
//! addition per entry: an `error` (record-level connector message) and optional
//! `fieldErrors` (per-field messages keyed by RFC 6902 JSON Pointer). The error
//! lives at the **entry** level, never on the RFC 6902 ops, so the `patch` body
//! stays a conformant op array / merge patch and can be re-applied by the same
//! machinery as an accepted patch.
//!
//! The failed edit is re-applied to the **working tree** (so it shows as
//! needs-approval), but is NOT in `accepted-patches.json` (so it is not staged to
//! publish again until the user re-accepts it). All mutating callers must hold the
//! workspace `.scratch/lock`.

// `shared` is compiled for both binaries; only the CLI reaches into this module
// today. Allow at module scope to keep the service binary's build warning-clean.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::shared::re_anchor::{AnchoredPatch, PatchKind};

const FILENAME: &str = "failed-patches.json";

/// On-disk schema version written by this build. `1` is the first version; this
/// file was introduced already RFC-6902-aware, so (unlike `accepted-patches.json`)
/// there is no legacy merge-patch-only predecessor to dual-read.
pub const FORMAT_VERSION: u32 = 1;

/// One rejected record. Same shape as [`AnchoredPatch`] plus the connector's
/// rejection detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FailedPatch {
    pub path: String,
    pub kind: PatchKind,
    /// RFC 7396 merge patch / RFC 6902 op array / full Create content — exactly
    /// as an [`AnchoredPatch::patch`]. The error never rides on the ops here.
    pub patch: JsonValue,
    #[serde(default, skip_serializing_if = "is_false")]
    pub revert: bool,
    /// Record-level connector rejection message (e.g. "Organization cannot be
    /// null"). `None` when the connector gave no message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Per-field rejection messages keyed by RFC 6902 JSON Pointer (e.g.
    /// `/Organization`). Drives the per-field warning in the grid. `None`/empty
    /// when the connector only attributed a record-level `error`.
    #[serde(
        rename = "fieldErrors",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub field_errors: Option<BTreeMap<String, String>>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl FailedPatch {
    /// Build a failed entry from the anchored patch we tried to publish plus the
    /// connector's rejection detail.
    pub fn from_anchored(
        anchored: AnchoredPatch,
        error: Option<String>,
        field_errors: Option<BTreeMap<String, String>>,
    ) -> Self {
        FailedPatch {
            path: anchored.path,
            kind: anchored.kind,
            patch: anchored.patch,
            revert: anchored.revert,
            error,
            field_errors,
        }
    }

    /// View the patch portion as an [`AnchoredPatch`] (for re-applying to the
    /// worktree / re-anchoring), dropping the error detail.
    pub fn to_anchored(&self) -> AnchoredPatch {
        AnchoredPatch {
            path: self.path.clone(),
            kind: self.kind,
            patch: self.patch.clone(),
            revert: self.revert,
        }
    }
}

/// On-disk wrapper. The in-memory shape carries only `patches`; the file-level
/// `version` is a serialization-boundary concern ([`save_atomic`] always stamps
/// [`FORMAT_VERSION`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FailedPatchesFile {
    #[serde(default)]
    pub patches: Vec<FailedPatch>,
}

/// The `version` envelope as it sits on disk — used only to read the version
/// marker for the newer-format guard.
#[derive(Debug, Deserialize)]
struct VersionedEnvelope {
    #[serde(default = "default_format_version")]
    version: u32,
}

fn default_format_version() -> u32 {
    FORMAT_VERSION
}

/// Resolve the file path for a connection directory.
pub fn path(connection_dir: &Path) -> PathBuf {
    connection_dir.join(FILENAME)
}

/// Load the file. Returns `Default` when absent or empty — "no failed patches"
/// and "no file yet" are the same state. Fails loud on a newer on-disk format.
pub fn load(connection_dir: &Path) -> anyhow::Result<FailedPatchesFile> {
    let p = path(connection_dir);
    if !p.exists() {
        return Ok(FailedPatchesFile::default());
    }
    let bytes = fs::read(&p)
        .with_context(|| format!("failed to read failed patches at {}", p.display()))?;
    if bytes.is_empty() {
        return Ok(FailedPatchesFile::default());
    }
    let envelope: VersionedEnvelope = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse failed patches at {}", p.display()))?;
    if envelope.version > FORMAT_VERSION {
        anyhow::bail!(
            "failed-patches.json at {} was written by a newer scratchmd (format version {}, this build supports {}); upgrade scratchmd to read this workspace",
            p.display(),
            envelope.version,
            FORMAT_VERSION,
        );
    }
    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse failed patches at {}", p.display()))
}

/// Atomic write: `<file>.tmp.<pid>` → fsync → rename. Callers hold `.scratch/lock`.
/// An empty patch list removes the file entirely (a clean publish leaves no
/// `failed-patches.json` behind).
pub fn save_atomic(connection_dir: &Path, file: &FailedPatchesFile) -> anyhow::Result<()> {
    let final_path = path(connection_dir);
    if file.patches.is_empty() {
        // Nothing failed — don't leave a stale/empty file around.
        if final_path.exists() {
            fs::remove_file(&final_path)
                .with_context(|| format!("failed to remove {}", final_path.display()))?;
        }
        return Ok(());
    }
    fs::create_dir_all(connection_dir).with_context(|| {
        format!(
            "failed to create connection dir {}",
            connection_dir.display()
        )
    })?;
    let tmp_path = connection_dir.join(format!("{FILENAME}.tmp.{}", std::process::id()));
    #[derive(Serialize)]
    struct OnDisk<'a> {
        version: u32,
        patches: &'a [FailedPatch],
    }
    let bytes = serde_json::to_vec_pretty(&OnDisk {
        version: FORMAT_VERSION,
        patches: &file.patches,
    })
    .context("failed to serialize failed patches")?;
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

/// Get the existing entry for a path, if any.
pub fn get_entry<'a>(file: &'a FailedPatchesFile, path: &str) -> Option<&'a FailedPatch> {
    file.patches.iter().find(|e| e.path == path)
}

/// Upsert an entry by path.
pub fn upsert_entry(file: &mut FailedPatchesFile, entry: FailedPatch) {
    match file.patches.iter().position(|e| e.path == entry.path) {
        Some(pos) => file.patches[pos] = entry,
        None => file.patches.push(entry),
    }
}

/// Remove the entry for a path. No-op if absent. Used when the user re-accepts or
/// discards a failed edit (it leaves `failed-patches.json` and re-enters the
/// normal review ladder).
pub fn remove_entry(file: &mut FailedPatchesFile, path: &str) {
    file.patches.retain(|e| e.path != path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn failed(path: &str, patch: JsonValue, error: &str) -> FailedPatch {
        FailedPatch {
            path: path.into(),
            kind: PatchKind::Update,
            patch,
            revert: false,
            error: Some(error.into()),
            field_errors: None,
        }
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), FailedPatchesFile::default());
    }

    #[test]
    fn save_then_load_round_trips_with_errors() {
        let dir = tempdir().unwrap();
        let mut entry = failed(
            "Contacts/bobby.json",
            json!([{"op": "add", "path": "/Organization", "value": null}]),
            "Organization cannot be null",
        );
        entry.field_errors = Some(
            [(
                "/Organization".to_string(),
                "Organization cannot be null".to_string(),
            )]
            .into_iter()
            .collect(),
        );
        let f = FailedPatchesFile {
            patches: vec![entry],
        };
        save_atomic(dir.path(), &f).unwrap();
        assert_eq!(load(dir.path()).unwrap(), f);
    }

    #[test]
    fn save_empty_removes_the_file() {
        let dir = tempdir().unwrap();
        save_atomic(
            dir.path(),
            &FailedPatchesFile {
                patches: vec![failed("p", json!({"a": 1}), "boom")],
            },
        )
        .unwrap();
        assert!(path(dir.path()).exists());
        // A subsequent clean publish writes an empty set → file is removed.
        save_atomic(dir.path(), &FailedPatchesFile::default()).unwrap();
        assert!(
            !path(dir.path()).exists(),
            "empty save must remove the file"
        );
    }

    #[test]
    fn upsert_replaces_by_path_and_remove_drops() {
        let mut f = FailedPatchesFile::default();
        upsert_entry(&mut f, failed("p", json!({"a": 1}), "e1"));
        upsert_entry(&mut f, failed("p", json!({"a": 2}), "e2"));
        assert_eq!(f.patches.len(), 1);
        assert_eq!(f.patches[0].error.as_deref(), Some("e2"));
        remove_entry(&mut f, "p");
        assert!(f.patches.is_empty());
    }

    #[test]
    fn anchored_round_trip_drops_and_restores_error() {
        let anchored = AnchoredPatch {
            path: "p".into(),
            kind: PatchKind::Update,
            patch: json!([{"op": "add", "path": "/a", "value": 1}]),
            revert: false,
        };
        let fp = FailedPatch::from_anchored(anchored.clone(), Some("boom".into()), None);
        assert_eq!(fp.error.as_deref(), Some("boom"));
        assert_eq!(fp.to_anchored(), anchored);
    }

    #[test]
    fn load_rejects_newer_format() {
        let dir = tempdir().unwrap();
        fs::write(path(dir.path()), br#"{"version":999,"patches":[]}"#).unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(err.to_string().contains("newer scratchmd"), "got: {err}");
    }
}
