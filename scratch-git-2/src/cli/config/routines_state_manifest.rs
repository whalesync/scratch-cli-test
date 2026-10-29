//! `<workspace>/.scratch/routines-state.json` — the routines manifest (DEV-12617).
//!
//! Records, per routine file, the server `version` and the SHA-256 of the exact content
//! bytes as of the last `scratchmd routines pull` / `push`. It is the merge base for all
//! three routines commands: local changes = files on disk vs these hashes, remote changes =
//! the server's files vs this snapshot, and each file's `version` is echoed back as the
//! push's per-file `baseVersion` optimistic-concurrency token.
//!
//! Written only by the CLI, atomically (temp → fsync → rename), under the workspace lock.
//! The file-level `formatVersion` is a pure serialization-boundary concern (always stamped
//! on write, checked on read), mirroring `shared/accepted_patches.rs`.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

/// On-disk format version written by this build. A manifest with a higher version was
/// written by a newer scratchmd and is refused rather than misread.
pub const ROUTINES_STATE_MANIFEST_FORMAT_VERSION: u32 = 1;

/// What the manifest knows about one routine file at the last pull or push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineFileStateAtLastSync {
    /// The server's optimistic-concurrency version of the file at the last pull/push.
    pub version: i64,
    /// Lowercase hex SHA-256 of the file's exact bytes at the last pull/push.
    pub sha256: String,
}

/// Manifest entries keyed by server-relative routine path (`routines/<name>.yaml`).
pub type RoutineFileStateAtLastSyncByServerPath = BTreeMap<String, RoutineFileStateAtLastSync>;

/// The in-memory manifest.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoutinesStateManifest {
    /// The workbook whose routines this manifest describes. Stops a `.scratch/` copied from
    /// another workspace from supplying base versions for a different workbook.
    pub workbook_id: String,
    pub routine_file_state_at_last_sync_by_server_path: RoutineFileStateAtLastSyncByServerPath,
}

/// The result of reading the manifest for a specific workbook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutinesStateManifestOnDisk {
    /// No manifest yet (missing, empty, or all-padding file): routines were never pulled into
    /// this workspace by a REST-backed scratchmd.
    NeverPulled,
    BelongsToThisWorkbook(RoutinesStateManifest),
    /// The manifest names another workbook — its versions mean nothing for this one.
    BelongsToDifferentWorkbook {
        workbook_id_recorded_in_manifest: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesStateManifestAsWrittenToDisk<'a> {
    format_version: u32,
    workbook_id: &'a str,
    files: &'a RoutineFileStateAtLastSyncByServerPath,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesStateManifestFormatVersionOnly {
    format_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesStateManifestAsReadFromDisk {
    workbook_id: String,
    #[serde(default)]
    files: RoutineFileStateAtLastSyncByServerPath,
}

/// Read the manifest at `manifest_file_path` and check it belongs to `expected_workbook_id`.
/// Fails loudly on a manifest written by a newer scratchmd or one that doesn't parse, telling
/// the user how to rebuild it (the routine files themselves are never touched by a rebuild).
pub fn read_routines_state_manifest_for_workbook(
    manifest_file_path: &Path,
    expected_workbook_id: &str,
) -> anyhow::Result<RoutinesStateManifestOnDisk> {
    let Some(manifest_bytes) =
        crate::shared::atomic_json_state::read_json_state_file_tolerating_trailing_padding(
            manifest_file_path,
        )?
    else {
        return Ok(RoutinesStateManifestOnDisk::NeverPulled);
    };

    let how_to_rebuild = format!(
        "{} is written only by scratchmd; delete it and run `scratchmd routines pull` to rebuild it (your routine files are kept)",
        manifest_file_path.display()
    );
    let format_version_only: RoutinesStateManifestFormatVersionOnly =
        serde_json::from_slice(&manifest_bytes)
            .with_context(|| format!("failed to parse the routines manifest. {how_to_rebuild}"))?;
    if format_version_only.format_version > ROUTINES_STATE_MANIFEST_FORMAT_VERSION {
        anyhow::bail!(
            "{} was written by a newer scratchmd (format version {}, this build supports {}); upgrade scratchmd to use routines in this workspace",
            manifest_file_path.display(),
            format_version_only.format_version,
            ROUTINES_STATE_MANIFEST_FORMAT_VERSION,
        );
    }
    let manifest_as_read: RoutinesStateManifestAsReadFromDisk =
        serde_json::from_slice(&manifest_bytes)
            .with_context(|| format!("failed to parse the routines manifest. {how_to_rebuild}"))?;

    if manifest_as_read.workbook_id != expected_workbook_id {
        return Ok(RoutinesStateManifestOnDisk::BelongsToDifferentWorkbook {
            workbook_id_recorded_in_manifest: manifest_as_read.workbook_id,
        });
    }
    Ok(RoutinesStateManifestOnDisk::BelongsToThisWorkbook(
        RoutinesStateManifest {
            workbook_id: manifest_as_read.workbook_id,
            routine_file_state_at_last_sync_by_server_path: manifest_as_read.files,
        },
    ))
}

/// Atomically write the manifest (temp → fsync → rename), always stamping the current format
/// version. Callers must hold the workspace lock.
pub fn write_routines_state_manifest_atomically(
    manifest_file_path: &Path,
    manifest: &RoutinesStateManifest,
) -> anyhow::Result<()> {
    let mut manifest_bytes = serde_json::to_vec_pretty(&RoutinesStateManifestAsWrittenToDisk {
        format_version: ROUTINES_STATE_MANIFEST_FORMAT_VERSION,
        workbook_id: &manifest.workbook_id,
        files: &manifest.routine_file_state_at_last_sync_by_server_path,
    })
    .context("failed to serialize the routines manifest")?;
    manifest_bytes.push(b'\n');
    crate::shared::atomic_json_state::write_bytes_to_file_atomically(
        manifest_file_path,
        &manifest_bytes,
    )
    .with_context(|| {
        format!(
            "failed to write the routines manifest {}",
            manifest_file_path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn manifest_with_one_file(workbook_id: &str) -> RoutinesStateManifest {
        let mut routine_file_state_at_last_sync_by_server_path = BTreeMap::new();
        routine_file_state_at_last_sync_by_server_path.insert(
            "routines/weekly.yaml".to_string(),
            RoutineFileStateAtLastSync {
                version: 2,
                sha256: "b".repeat(64),
            },
        );
        routine_file_state_at_last_sync_by_server_path.insert(
            "routines/daily.yaml".to_string(),
            RoutineFileStateAtLastSync {
                version: 7,
                sha256: "a".repeat(64),
            },
        );
        RoutinesStateManifest {
            workbook_id: workbook_id.to_string(),
            routine_file_state_at_last_sync_by_server_path,
        }
    }

    #[test]
    fn missing_manifest_reads_as_never_pulled() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        assert_eq!(
            read_routines_state_manifest_for_workbook(&manifest_file_path, "wkb_1").unwrap(),
            RoutinesStateManifestOnDisk::NeverPulled
        );
    }

    #[test]
    fn manifest_round_trips_with_format_version_and_sorted_camel_case_keys() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        let manifest = manifest_with_one_file("wkb_1");

        write_routines_state_manifest_atomically(&manifest_file_path, &manifest).unwrap();

        let written_text = fs::read_to_string(&manifest_file_path).unwrap();
        assert!(written_text.contains("\"formatVersion\": 1"));
        assert!(written_text.contains("\"workbookId\": \"wkb_1\""));
        let daily_position = written_text.find("routines/daily.yaml").unwrap();
        let weekly_position = written_text.find("routines/weekly.yaml").unwrap();
        assert!(daily_position < weekly_position, "keys must be sorted");
        assert_eq!(
            read_routines_state_manifest_for_workbook(&manifest_file_path, "wkb_1").unwrap(),
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(manifest)
        );
    }

    #[test]
    fn manifest_written_by_a_newer_scratchmd_is_refused() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        fs::write(
            &manifest_file_path,
            br#"{"formatVersion": 99, "workbookId": "wkb_1", "files": {}}"#,
        )
        .unwrap();
        let error =
            read_routines_state_manifest_for_workbook(&manifest_file_path, "wkb_1").unwrap_err();
        assert!(error.to_string().contains("newer scratchmd"));
    }

    #[test]
    fn manifest_for_a_different_workbook_is_reported_not_used() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        write_routines_state_manifest_atomically(
            &manifest_file_path,
            &manifest_with_one_file("wkb_other"),
        )
        .unwrap();
        assert_eq!(
            read_routines_state_manifest_for_workbook(&manifest_file_path, "wkb_1").unwrap(),
            RoutinesStateManifestOnDisk::BelongsToDifferentWorkbook {
                workbook_id_recorded_in_manifest: "wkb_other".to_string()
            }
        );
    }

    #[test]
    fn manifest_with_trailing_nul_padding_still_reads() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        fs::write(
            &manifest_file_path,
            b"{\"formatVersion\": 1, \"workbookId\": \"wkb_1\", \"files\": {}}\n\0\0\0",
        )
        .unwrap();
        assert_eq!(
            read_routines_state_manifest_for_workbook(&manifest_file_path, "wkb_1").unwrap(),
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(RoutinesStateManifest {
                workbook_id: "wkb_1".to_string(),
                routine_file_state_at_last_sync_by_server_path: BTreeMap::new(),
            })
        );
    }

    #[test]
    fn unparseable_manifest_error_explains_how_to_rebuild() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        fs::write(&manifest_file_path, b"{\"formatVersion\": 1, \"files\": [").unwrap();
        let error =
            read_routines_state_manifest_for_workbook(&manifest_file_path, "wkb_1").unwrap_err();
        assert!(format!("{error:#}").contains("scratchmd routines pull"));
    }

    #[test]
    fn writing_the_manifest_leaves_no_temp_file_behind() {
        let dir = tempdir().unwrap();
        let manifest_file_path = dir.path().join("routines-state.json");
        write_routines_state_manifest_atomically(
            &manifest_file_path,
            &manifest_with_one_file("wkb_1"),
        )
        .unwrap();
        let entry_names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entry_names, vec!["routines-state.json".to_string()]);
    }
}
