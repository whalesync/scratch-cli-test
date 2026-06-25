//! Per-connection `accepted-patches.json` file.
//!
//! Phase 4/5 of the simplify-local-workspace plan
//! (`docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md`).
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

// `shared` is compiled for both binaries; only the CLI reaches into this
// module today. Allow at module scope to keep the service binary's build
// warning-clean without per-item annotations.
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::shared::re_anchor::{AnchoredPatch, PatchKind};

const FILENAME: &str = "accepted-patches.json";

/// On-disk schema version written by this build.
///
/// * Absent or `1` — legacy RFC 7396 (JSON Merge Patch) dialect: every `Update`
///   patch body is a merge-patch object.
/// * `2` — written by an RFC 6902-capable build. `Update` patch bodies may be in
///   *either* dialect (a freshly re-touched record is 6902; an untouched record
///   carried over from before the cutover may still be 7396). Reconstruction
///   dispatches per entry by **shape**, not by this marker — see
///   [`crate::shared::json_patch::apply_update_patch`] — so a mixed file reads
///   correctly. The marker exists for rollout telemetry and so the v1 read path
///   can eventually be retired once it shows no traffic.
pub const FORMAT_VERSION: u32 = 2;

/// serde fill for a `version` key absent from an older on-disk file.
fn legacy_format_version() -> u32 {
    1
}

/// On-disk wrapper. The in-memory shape carries only `patches`; the file-level
/// `version` is a pure serialization-boundary concern ([`save_atomic`] always
/// writes [`FORMAT_VERSION`]; readers that care call [`peek_format_version`]),
/// which keeps every in-memory constructor free of a version field.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AcceptedPatchesFile {
    #[serde(default)]
    pub patches: Vec<AnchoredPatch>,
}

/// The `version` + `patches` envelope as it actually sits on disk. Used only to
/// read the version marker; everyday loads go through [`load`] which deserializes
/// straight into [`AcceptedPatchesFile`] (serde ignores the extra `version` key).
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
/// "no accepted patches" and "no file yet" are the same state.
pub fn load(connection_dir: &Path) -> anyhow::Result<AcceptedPatchesFile> {
    let p = path(connection_dir);
    // Missing, empty, or entirely NUL/whitespace padding all mean "no accepted
    // patches yet" (the latter two are known crash / out-of-band-corruption
    // artifacts). Otherwise we get the bytes with any trailing NUL/whitespace
    // padding already stripped — so a complete document followed by zero-fill
    // (a manual edit, cloud-sync placeholder, or power-loss) parses, while a
    // genuinely truncated document still fails loud below.
    let Some(bytes) =
        crate::shared::atomic_json_state::read_json_state_file_tolerating_trailing_padding(&p)?
    else {
        return Ok(AcceptedPatchesFile::default());
    };
    // Fail loud rather than silently mis-reconstruct. A file written by a *newer*
    // scratchmd carries `Update` bodies this build can't interpret (a future
    // on-disk format), and reconstructing them would corrupt records — e.g. an
    // older build that lacks RFC 6902 awareness would treat a v2 op array as a
    // merge patch and write the literal `[{"op":…}]` into the user's record on
    // the next download. Refuse and tell the user to upgrade. Older/equal
    // versions read fine (reconstruction dispatches per entry by shape).
    let envelope: VersionedEnvelope = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse accepted patches at {}", p.display()))?;
    if envelope.version > FORMAT_VERSION {
        anyhow::bail!(
            "accepted-patches.json at {} was written by a newer scratchmd (format version {}, this build supports {}); upgrade scratchmd to read this workspace",
            p.display(),
            envelope.version,
            FORMAT_VERSION,
        );
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
    // Always stamp the current format version. Any write by this build means the
    // file now requires shape-dispatch reading (it may contain 6902 entries), so
    // the marker is honest at v2 regardless of what the in-memory entries are.
    #[derive(Serialize)]
    struct OnDisk<'a> {
        version: u32,
        patches: &'a [AnchoredPatch],
    }
    let bytes = serde_json::to_vec_pretty(&OnDisk {
        version: FORMAT_VERSION,
        patches: &file.patches,
    })
    .context("failed to serialize accepted patches")?;
    {
        let mut f = fs::File::create(&tmp_path)
            .with_context(|| format!("failed to open {}", tmp_path.display()))?;
        f.write_all(&bytes)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
    }
    fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("failed to rename to {}", final_path.display()))?;
    // Flush the rename itself so the freshly-written file survives a crash
    // (the temp's contents were already fsynced above).
    crate::shared::atomic_json_state::fsync_parent_directory_best_effort(&final_path);
    Ok(())
}

/// Read just the on-disk format version marker for a connection's
/// `accepted-patches.json`. Returns [`FORMAT_VERSION`] when the file is missing
/// (a not-yet-created file is conceptually current), `1` when the file exists
/// but predates the version marker, or the stored version otherwise. Used by
/// rollout telemetry to spot lingering legacy (v1) files without parsing the
/// whole patch list.
pub fn peek_format_version(connection_dir: &Path) -> anyhow::Result<u32> {
    let p = path(connection_dir);
    let Some(bytes) =
        crate::shared::atomic_json_state::read_json_state_file_tolerating_trailing_padding(&p)?
    else {
        return Ok(FORMAT_VERSION);
    };
    let envelope: VersionedEnvelope = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "failed to parse accepted patches version at {}",
            p.display()
        )
    })?;
    Ok(envelope.version)
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
            revert: false,
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
    fn save_stamps_current_version_and_peek_reads_it() {
        let dir = tempdir().unwrap();
        save_atomic(dir.path(), &AcceptedPatchesFile::default()).unwrap();
        assert_eq!(peek_format_version(dir.path()).unwrap(), FORMAT_VERSION);
        let raw = fs::read_to_string(path(dir.path())).unwrap();
        assert!(
            raw.contains("\"version\""),
            "saved file must carry a version marker"
        );
    }

    #[test]
    fn peek_treats_versionless_file_as_legacy_v1() {
        let dir = tempdir().unwrap();
        // A file written before the version marker existed.
        fs::write(path(dir.path()), b"{\"patches\":[]}").unwrap();
        assert_eq!(peek_format_version(dir.path()).unwrap(), 1);
    }

    #[test]
    fn peek_missing_file_is_current_version() {
        let dir = tempdir().unwrap();
        assert_eq!(peek_format_version(dir.path()).unwrap(), FORMAT_VERSION);
    }

    #[test]
    fn load_rejects_a_newer_format_version() {
        // Fail-loud guard against the downgrade-corruption path: an older build
        // must refuse a file a newer scratchmd wrote rather than mis-reconstruct.
        let dir = tempdir().unwrap();
        fs::write(path(dir.path()), br#"{"version":999,"patches":[]}"#).unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(
            err.to_string().contains("newer scratchmd"),
            "expected an upgrade error, got: {err}"
        );
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

    #[test]
    fn load_ignores_version_marker_and_keeps_6902_array_body() {
        let dir = tempdir().unwrap();
        fs::write(
            path(dir.path()),
            br#"{"version":2,"patches":[{"path":"p","kind":"update","patch":[{"op":"add","path":"/a","value":1}]}]}"#,
        )
        .unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.patches.len(), 1);
        assert_eq!(loaded.patches[0].kind, PatchKind::Update);
        // A 6902 op-array body survives the round trip as a JSON array.
        assert!(loaded.patches[0].patch.is_array());
    }

    #[test]
    fn load_tolerates_trailing_nul_padding_after_a_complete_document() {
        // The reported corruption: a complete, valid JSON document followed by
        // NUL bytes (left by an out-of-band edit, a cloud-sync placeholder, or
        // power-loss zero-fill). It must load rather than failing to parse.
        let dir = tempdir().unwrap();
        let mut bytes = br#"{"version":2,"patches":[{"path":"Companies/rec_1.json","kind":"update","patch":{"industry":"SaaS"}}]}"#.to_vec();
        bytes.extend_from_slice(b"\n\0\0\0\0");
        fs::write(path(dir.path()), &bytes).unwrap();
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.patches.len(), 1);
        assert_eq!(loaded.patches[0].path, "Companies/rec_1.json");
    }

    #[test]
    fn load_treats_an_all_nul_file_as_empty() {
        // A wholly zero-filled file (e.g. a power-loss artifact) reads as "no
        // accepted patches", matching the zero-byte crash-recovery behavior.
        let dir = tempdir().unwrap();
        fs::write(path(dir.path()), b"\0\0\0\0\0").unwrap();
        assert_eq!(load(dir.path()).unwrap(), AcceptedPatchesFile::default());
    }

    #[test]
    fn load_still_fails_loud_on_a_truncated_document_with_nul_padding() {
        // Trimming trailing padding must NOT rescue genuinely truncated JSON: an
        // incomplete value does not parse even after the NULs are stripped, so
        // fail-loud is preserved for real mid-data corruption.
        let dir = tempdir().unwrap();
        let mut bytes = br#"{"version":2,"patches":[{"path":"a"#.to_vec();
        bytes.extend_from_slice(b"\0\0\0\0");
        fs::write(path(dir.path()), &bytes).unwrap();
        assert!(
            load(dir.path()).is_err(),
            "a truncated document must still fail to parse"
        );
    }
}
