//! Per-connection `accepted-patches.json` file.
//!
//! Phase 4/5 of the simplify-local-workspace plan
//! (`docs/plans/2026-05-17-simplify-local-workspace-architecture.md`).
//!
//! Once the `dirty` branch retires as the source of truth for
//! accepted-but-not-published edits, this JSON file takes over. Every accept,
//! reject, or discard mutates it; `scratchmd files upload` reads it verbatim
//! and ships it to the server as the `/upload-patch` payload.
//!
//! The file lives at
//! `<workspace>/.scratch/connections/<conn>/accepted-patches.json` and uses
//! the same `Vec<AnchoredPatch>` shape as `working-patches.json` and the
//! upload-patch DTO. All mutating callers must hold the workspace `.scratch/lock`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::commands::re_anchor::{AnchoredPatch, PatchKind};

const FILENAME: &str = "accepted-patches.json";

/// On-disk wrapper. Single `patches` key today; the wrapper exists so we can
/// add metadata (schema version, last-updated, etc.) later without breaking
/// older clients.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AcceptedPatchesFile {
    #[serde(default)]
    pub patches: Vec<AnchoredPatch>,
}

/// Resolve the file path for a given connection directory
/// (`<workspace>/.scratch/connections/<conn>`).
pub fn path(connection_dir: &Path) -> PathBuf {
    connection_dir.join(FILENAME)
}

/// Load the file. Returns `Default::default()` if it doesn't exist on disk —
/// "no accepted patches" and "no file yet" are the same state.
pub fn load(connection_dir: &Path) -> anyhow::Result<AcceptedPatchesFile> {
    let p = path(connection_dir);
    if !p.exists() {
        return Ok(AcceptedPatchesFile::default());
    }
    let bytes = fs::read(&p)
        .with_context(|| format!("failed to read accepted patches at {}", p.display()))?;
    if bytes.is_empty() {
        // A zero-byte file from a previous crash between create + write —
        // treat as empty rather than failing parse.
        return Ok(AcceptedPatchesFile::default());
    }
    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse accepted patches at {}", p.display()))
}

/// Atomic write: write to `<file>.tmp.<pid>`, fsync, rename. Matches git's
/// own `.git/index.lock` discipline; callers are expected to already hold
/// `.scratch/lock`.
pub fn save_atomic(connection_dir: &Path, file: &AcceptedPatchesFile) -> anyhow::Result<()> {
    fs::create_dir_all(connection_dir).with_context(|| {
        format!(
            "failed to create connection dir {}",
            connection_dir.display()
        )
    })?;
    let final_path = path(connection_dir);
    let tmp_path = connection_dir.join(format!("{FILENAME}.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(file).context("failed to serialize accepted patches")?;
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

/// Delete the file (used after a successful publish — the patches have been
/// shipped). No-op if absent.
pub fn clear(connection_dir: &Path) -> anyhow::Result<()> {
    let p = path(connection_dir);
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("failed to remove {}", p.display())),
    }
}

/// Get the existing patch entry for a path, if any.
pub fn get_entry<'a>(file: &'a AcceptedPatchesFile, path: &str) -> Option<&'a AnchoredPatch> {
    file.patches.iter().find(|e| e.path == path)
}

/// Upsert a single entry — matches by path. Two special collapses to keep the
/// file from accumulating useless history:
///
///   - **Create-then-Delete**: the file never existed remotely, so accepting
///     a delete after a create is the same as the user never touching it.
///     Drop the entry entirely.
///   - **Existing Create + new Update**: keep it as `Create`, but replace the
///     patch content with the new working-tree value so we ship the latest
///     intended content. (The new "Update" patch is computed against the last
///     accepted state, not against `main` — caller should pass the already-
///     composed content; see [`merge_into_create`].)
pub fn upsert_entry(file: &mut AcceptedPatchesFile, entry: AnchoredPatch) {
    let existing_pos = file.patches.iter().position(|e| e.path == entry.path);
    let Some(pos) = existing_pos else {
        file.patches.push(entry);
        return;
    };

    let existing_kind = file.patches[pos].kind;
    match (existing_kind, entry.kind) {
        (PatchKind::Create, PatchKind::Delete) => {
            file.patches.remove(pos);
        }
        _ => {
            file.patches[pos] = entry;
        }
    }
}

/// Remove the entry for a path. No-op if absent.
pub fn remove_entry(file: &mut AcceptedPatchesFile, path: &str) {
    file.patches.retain(|e| e.path != path);
}

/// Remove a top-level field from an Update entry. If the resulting patch
/// object is empty, removes the entry entirely. No-op on Create / Delete
/// entries (the field-level concept doesn't apply — restoring a single field
/// of a `Create` requires the caller to handle worktree restoration directly).
///
/// `discard_field_in_folder` mutates `entry.patch` inline rather than going
/// through this helper (it needs richer Create handling than the no-op
/// here). Slice D's pull rewrite may use this against `working-patches.json`.
#[allow(dead_code)]
pub fn remove_field(file: &mut AcceptedPatchesFile, path: &str, field: &str) {
    let mut drop_entry_for_path: Option<String> = None;
    if let Some(entry) = file.patches.iter_mut().find(|e| e.path == path) {
        if entry.kind != PatchKind::Update {
            return;
        }
        if let JsonValue::Object(map) = &mut entry.patch {
            map.shift_remove(field);
            if map.is_empty() {
                drop_entry_for_path = Some(path.to_string());
            }
        }
    }
    if let Some(p) = drop_entry_for_path {
        file.patches.retain(|e| e.path != p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn entry(path: &str, kind: PatchKind, patch: JsonValue) -> AnchoredPatch {
        AnchoredPatch {
            path: path.into(),
            kind,
            patch,
        }
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, AcceptedPatchesFile::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().unwrap();
        let f = AcceptedPatchesFile {
            patches: vec![
                entry(
                    "Companies/rec_1.json",
                    PatchKind::Update,
                    json!({"industry": "SaaS"}),
                ),
                entry("Companies/rec_2.json", PatchKind::Delete, JsonValue::Null),
            ],
        };
        save_atomic(dir.path(), &f).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, f);
    }

    #[test]
    fn save_atomic_leaves_no_tmp_files() {
        let dir = tempdir().unwrap();
        save_atomic(dir.path(), &AcceptedPatchesFile::default()).unwrap();
        let leftover_tmp = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp."));
        assert!(!leftover_tmp, "expected no .tmp files after atomic save");
    }

    #[test]
    fn upsert_new_entry_appends() {
        let mut f = AcceptedPatchesFile::default();
        upsert_entry(&mut f, entry("p1", PatchKind::Update, json!({"a": 1})));
        assert_eq!(f.patches.len(), 1);
        assert_eq!(f.patches[0].path, "p1");
    }

    #[test]
    fn upsert_existing_entry_replaces_by_path() {
        let mut f = AcceptedPatchesFile {
            patches: vec![entry("p1", PatchKind::Update, json!({"a": 1}))],
        };
        upsert_entry(
            &mut f,
            entry("p1", PatchKind::Update, json!({"a": 2, "b": 3})),
        );
        assert_eq!(f.patches.len(), 1);
        assert_eq!(f.patches[0].patch, json!({"a": 2, "b": 3}));
    }

    #[test]
    fn upsert_create_then_delete_collapses_to_nothing() {
        let mut f = AcceptedPatchesFile {
            patches: vec![entry("p1", PatchKind::Create, json!({"name": "Acme"}))],
        };
        upsert_entry(&mut f, entry("p1", PatchKind::Delete, JsonValue::Null));
        assert!(
            f.patches.is_empty(),
            "create-then-delete should remove the entry"
        );
    }

    #[test]
    fn upsert_create_to_update_replaces_as_update() {
        // If the user creates then later modifies, the path is still being
        // sent as Create — but the content evolves. Caller is responsible for
        // composing the new content; upsert just replaces.
        let mut f = AcceptedPatchesFile {
            patches: vec![entry("p1", PatchKind::Create, json!({"name": "Acme"}))],
        };
        upsert_entry(
            &mut f,
            entry("p1", PatchKind::Update, json!({"name": "Acme Corp"})),
        );
        assert_eq!(f.patches.len(), 1);
        assert_eq!(f.patches[0].kind, PatchKind::Update);
    }

    #[test]
    fn remove_entry_drops_path_no_op_if_absent() {
        let mut f = AcceptedPatchesFile {
            patches: vec![
                entry("p1", PatchKind::Update, json!({"a": 1})),
                entry("p2", PatchKind::Delete, JsonValue::Null),
            ],
        };
        remove_entry(&mut f, "p1");
        assert_eq!(f.patches.len(), 1);
        assert_eq!(f.patches[0].path, "p2");
        remove_entry(&mut f, "nope");
        assert_eq!(f.patches.len(), 1);
    }

    #[test]
    fn remove_field_strips_single_key_from_update() {
        let mut f = AcceptedPatchesFile {
            patches: vec![entry("p1", PatchKind::Update, json!({"a": 1, "b": 2}))],
        };
        remove_field(&mut f, "p1", "a");
        assert_eq!(f.patches[0].patch, json!({"b": 2}));
    }

    #[test]
    fn remove_field_drops_entry_when_last_field_removed() {
        let mut f = AcceptedPatchesFile {
            patches: vec![entry("p1", PatchKind::Update, json!({"a": 1}))],
        };
        remove_field(&mut f, "p1", "a");
        assert!(f.patches.is_empty());
    }

    #[test]
    fn remove_field_is_noop_on_create_or_delete() {
        let mut f = AcceptedPatchesFile {
            patches: vec![
                entry("c", PatchKind::Create, json!({"a": 1})),
                entry("d", PatchKind::Delete, JsonValue::Null),
            ],
        };
        remove_field(&mut f, "c", "a");
        remove_field(&mut f, "d", "x");
        assert_eq!(f.patches.len(), 2);
        assert_eq!(f.patches[0].patch, json!({"a": 1}));
    }

    #[test]
    fn clear_removes_file_idempotent() {
        let dir = tempdir().unwrap();
        save_atomic(
            dir.path(),
            &AcceptedPatchesFile {
                patches: vec![entry("p", PatchKind::Delete, JsonValue::Null)],
            },
        )
        .unwrap();
        assert!(path(dir.path()).exists());
        clear(dir.path()).unwrap();
        assert!(!path(dir.path()).exists());
        // Second clear is a no-op, not an error.
        clear(dir.path()).unwrap();
    }
}
