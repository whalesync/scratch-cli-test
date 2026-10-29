//! Local disk I/O for `scratchmd routines` (DEV-12617): scanning `.scratch/routines/`, applying a
//! pull plan crash-safely, and spotting unpushed edits an older scratchmd left in the
//! pre-DEV-12617 location (`.scratch/workspace/routines/`, the config-repo worktree).

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

use super::routine_sync_planning::{
    check_routine_file_name_is_allowed, classify_local_routine_changes_against_manifest,
    routine_file_name_for_server_path, server_routine_path_for_file_name, sha256_hex_of_bytes,
    LocalRoutineFile, LocalRoutineFilesByServerPath, PlannedLocalRoutineFileOperation,
    RoutineFileChangeKind, RoutinePullPlan, SERVER_ROUTINE_PATH_PREFIX,
};
use crate::config::markers;
use crate::config::routines_state_manifest::{
    read_routines_state_manifest_for_workbook, write_routines_state_manifest_atomically,
    RoutinesStateManifest, RoutinesStateManifestOnDisk,
};
use crate::shared::layout::WorkspaceLayout;

// ── scan ─────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct LocalRoutineDirectoryScan {
    pub routines_directory_exists: bool,
    pub local_routine_files_by_server_path: LocalRoutineFilesByServerPath,
    /// Non-hidden entries that aren't routine files (wrong extension, directories, …), as
    /// `(file name, reason)`. Every routines command leaves them untouched.
    pub entries_ignored_in_routines_directory: Vec<(String, String)>,
}

/// Read every routine file directly inside `.scratch/routines/` (exact bytes + hash), keyed by
/// server-relative path. Hidden entries are skipped silently (atomic-write temp files, editor
/// locks, OS metadata); other entries that aren't routine files are reported as ignored. A
/// missing directory is not an error — it is reported via `routines_directory_exists`.
pub(crate) fn scan_local_routine_files_directory(
    local_routine_files_directory: &Path,
) -> anyhow::Result<LocalRoutineDirectoryScan> {
    let mut scan = LocalRoutineDirectoryScan::default();
    match fs::metadata(local_routine_files_directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(scan),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to read {}", local_routine_files_directory.display())
            })
        }
        Ok(metadata) if !metadata.is_dir() => anyhow::bail!(
            "{} exists but is not a directory; move it aside so routine files can live there",
            local_routine_files_directory.display()
        ),
        Ok(_) => scan.routines_directory_exists = true,
    }

    let directory_entries = fs::read_dir(local_routine_files_directory)
        .with_context(|| format!("failed to list {}", local_routine_files_directory.display()))?;
    for directory_entry in directory_entries {
        let directory_entry = directory_entry.with_context(|| {
            format!("failed to list {}", local_routine_files_directory.display())
        })?;
        let Some(file_name) = directory_entry.file_name().to_str().map(str::to_string) else {
            scan.entries_ignored_in_routines_directory.push((
                directory_entry.file_name().to_string_lossy().to_string(),
                "its name is not valid UTF-8".to_string(),
            ));
            continue;
        };
        if file_name.starts_with('.') {
            continue;
        }
        if let Err(disallowed_reason) = check_routine_file_name_is_allowed(&file_name) {
            scan.entries_ignored_in_routines_directory
                .push((file_name, disallowed_reason.describe().to_string()));
            continue;
        }
        let entry_path = directory_entry.path();
        // `fs::metadata` follows symlinks: a symlink to a regular file reads like one.
        let entry_is_regular_file = fs::metadata(&entry_path)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false);
        if !entry_is_regular_file {
            scan.entries_ignored_in_routines_directory
                .push((file_name, "it is not a regular file".to_string()));
            continue;
        }
        let file_bytes = fs::read(&entry_path)
            .with_context(|| format!("failed to read routine file {}", entry_path.display()))?;
        scan.local_routine_files_by_server_path.insert(
            server_routine_path_for_file_name(&file_name),
            LocalRoutineFile::from_bytes(file_bytes),
        );
    }
    scan.entries_ignored_in_routines_directory.sort();
    Ok(scan)
}

// ── apply a pull plan ────────────────────────────────────────────────────────────────────────

/// Apply a pull plan, then record it: deletes, then atomic writes, then — only once every file
/// operation succeeded — the manifest. A crash or abort part-way therefore leaves files *ahead*
/// of the manifest (a re-run converges: local already equals server), never behind it (which
/// would make stale bytes look like local edits and let a push overwrite newer server content).
/// Each operation first re-checks the file still has the content the plan saw, so an edit saved
/// mid-pull — or a case-variant name on a case-insensitive filesystem — stops the pull instead
/// of being clobbered. Callers must hold the workspace lock.
pub(crate) fn apply_routine_pull_plan_then_write_manifest_last(
    local_routine_files_directory: &Path,
    routines_state_manifest_file_path: &Path,
    workbook_id: &str,
    plan: &RoutinePullPlan,
) -> anyhow::Result<()> {
    fs::create_dir_all(local_routine_files_directory).with_context(|| {
        format!(
            "failed to create {}",
            local_routine_files_directory.display()
        )
    })?;

    for planned_operation in &plan.local_file_operations_deletes_before_writes {
        match planned_operation {
            PlannedLocalRoutineFileOperation::DeleteLocalFile {
                server_relative_path,
                expected_sha256_hex_on_disk,
            } => {
                let local_file_path = local_routine_file_path_for_server_path(
                    local_routine_files_directory,
                    server_relative_path,
                )?;
                verify_local_routine_file_unchanged_since_scan(
                    &local_file_path,
                    Some(expected_sha256_hex_on_disk),
                )?;
                fs::remove_file(&local_file_path)
                    .with_context(|| format!("failed to delete {}", local_file_path.display()))?;
                crate::shared::atomic_json_state::fsync_parent_directory_best_effort(
                    &local_file_path,
                );
            }
            PlannedLocalRoutineFileOperation::WriteServerContent {
                server_relative_path,
                content,
                expected_sha256_hex_on_disk_before_write,
            } => {
                let local_file_path = local_routine_file_path_for_server_path(
                    local_routine_files_directory,
                    server_relative_path,
                )?;
                verify_local_routine_file_unchanged_since_scan(
                    &local_file_path,
                    expected_sha256_hex_on_disk_before_write.as_deref(),
                )?;
                crate::shared::atomic_json_state::write_bytes_to_file_atomically(
                    &local_file_path,
                    content.as_bytes(),
                )?;
            }
        }
    }

    write_routines_state_manifest_atomically(
        routines_state_manifest_file_path,
        &RoutinesStateManifest {
            workbook_id: workbook_id.to_string(),
            routine_file_state_at_last_sync_by_server_path: plan
                .manifest_files_after_successful_pull
                .clone(),
        },
    )
}

/// `.scratch/routines/<name>` for `routines/<name>` — re-validating the name so no server path
/// can ever escape the routines directory.
fn local_routine_file_path_for_server_path(
    local_routine_files_directory: &Path,
    server_relative_path: &str,
) -> anyhow::Result<PathBuf> {
    let file_name = routine_file_name_for_server_path(server_relative_path).map_err(|reason| {
        anyhow::anyhow!(
            "refusing to touch {server_relative_path}: {}",
            reason.describe()
        )
    })?;
    Ok(local_routine_files_directory.join(file_name))
}

/// Check `local_file_path` still has the content hash the plan was built from (`None` = must
/// not exist).
fn verify_local_routine_file_unchanged_since_scan(
    local_file_path: &Path,
    expected_sha256_hex_on_disk: Option<&str>,
) -> anyhow::Result<()> {
    let current_sha256_hex_on_disk = match fs::read(local_file_path) {
        Ok(file_bytes) => Some(sha256_hex_of_bytes(&file_bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to read {}", local_file_path.display()))
        }
    };
    if current_sha256_hex_on_disk.as_deref() == expected_sha256_hex_on_disk {
        return Ok(());
    }
    match expected_sha256_hex_on_disk {
        None => anyhow::bail!(
            "{} already exists on disk (perhaps under a different letter case), so the pull stopped before recording anything. Rename or remove that local file, then re-run `scratchmd routines pull`.",
            local_file_path.display()
        ),
        Some(_) => anyhow::bail!(
            "{} changed on disk while the pull was running, so the pull stopped before recording anything. Re-run `scratchmd routines pull`.",
            local_file_path.display()
        ),
    }
}

// ── legacy location (pre-DEV-12617) ──────────────────────────────────────────────────────────

/// Uncommitted routine edits an older scratchmd left in `.scratch/workspace/routines/` (the
/// config-repo worktree it used before routines moved to `.scratch/routines/`), as
/// server-relative paths. The new commands never read that copy, so these edits would otherwise
/// be silently ignored.
///
/// Runs `git status` there only when the worktree is this workspace's linked config worktree:
/// a bare config repo exists and `.scratch/workspace/.git` is a gitlink into this workspace's
/// `.repos/`. Otherwise git would walk up into whatever repository encloses the workspace (or a
/// copied workspace's original). A failing check warns and reports nothing.
pub(crate) fn detect_uncommitted_routine_edits_in_legacy_config_worktree(
    workspace_dir: &Path,
    workbook_id: &str,
) -> Vec<String> {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let legacy_config_worktree = layout.workbook_materialization_path();
    if !layout.bare_repo_path(workbook_id).is_dir()
        || !legacy_config_worktree_gitlink_points_into_workspace_repos_dir(
            &legacy_config_worktree,
            &layout.repos_dir(),
        )
    {
        return Vec::new();
    }
    match crate::git_ops::worktree_status_porcelain(
        &legacy_config_worktree,
        SERVER_ROUTINE_PATH_PREFIX,
    ) {
        Ok(status_entries) => {
            let mut edited_paths: Vec<String> =
                status_entries.into_iter().map(|(_, path)| path).collect();
            edited_paths.sort();
            edited_paths.dedup();
            edited_paths
        }
        Err(error) => {
            eprintln!(
                "Warning: couldn't check {} for unpushed routine edits made by an older scratchmd: {error:#}",
                legacy_config_worktree.join("routines").display()
            );
            Vec::new()
        }
    }
}

/// True when `<config worktree>/.git` is a linked-worktree gitlink (`gitdir: …`) resolving
/// inside `workspace_repos_dir`. No `.git`, a `.git` directory, or a gitlink elsewhere → false.
fn legacy_config_worktree_gitlink_points_into_workspace_repos_dir(
    config_worktree_dir: &Path,
    workspace_repos_dir: &Path,
) -> bool {
    let Ok(gitlink_text) = fs::read_to_string(config_worktree_dir.join(".git")) else {
        return false;
    };
    let Some(gitdir_value) = gitlink_text
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
    else {
        return false;
    };
    let gitdir_path = Path::new(gitdir_value);
    let gitdir_absolute_path = if gitdir_path.is_absolute() {
        gitdir_path.to_path_buf()
    } else {
        config_worktree_dir.join(gitdir_path)
    };
    match (
        dunce::canonicalize(&gitdir_absolute_path),
        dunce::canonicalize(workspace_repos_dir),
    ) {
        (Ok(canonical_gitdir), Ok(canonical_repos_dir)) => {
            canonical_gitdir.starts_with(&canonical_repos_dir)
        }
        _ => false,
    }
}

// ── `workspaces init --force` salvage check ──────────────────────────────────────────────────

/// Whether the workspace holds routine content that exists nowhere else: a routine file in
/// `.scratch/routines/` added or edited since the last pull/push (a pending local *delete* loses
/// no content). `workspaces init --force` preserves such a workspace instead of deleting it.
/// Conservative: any uncertainty — an unreadable marker, manifest, or directory — answers `true`.
pub(crate) fn workspace_has_unpushed_routine_file_edits(workspace_dir: &Path) -> bool {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let scan =
        match scan_local_routine_files_directory(&layout.local_routine_files_directory_path()) {
            Ok(scan) => scan,
            Err(_) => return true,
        };
    if scan.local_routine_files_by_server_path.is_empty() {
        return false;
    }
    let workbook_id = match markers::read(&markers::marker_path(workspace_dir)) {
        Ok(markers::Marker::Workspace(workspace_marker)) => workspace_marker.workbook.id,
        _ => return true,
    };
    let manifest_files_at_last_sync = match read_routines_state_manifest_for_workbook(
        &layout.routines_state_manifest_file_path(),
        &workbook_id,
    ) {
        Ok(RoutinesStateManifestOnDisk::BelongsToThisWorkbook(manifest)) => {
            manifest.routine_file_state_at_last_sync_by_server_path
        }
        // Never pulled, or a foreign manifest: every local routine file counts as unpushed.
        Ok(_) => Default::default(),
        Err(_) => return true,
    };
    classify_local_routine_changes_against_manifest(
        &manifest_files_at_last_sync,
        &scan.local_routine_files_by_server_path,
    )
    .iter()
    .any(|(_, local_change)| *local_change != RoutineFileChangeKind::Deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::routines_state_manifest::RoutineFileStateAtLastSync;
    use crate::shared::git_exec::git_command;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    const VALID_YAML: &str = "name: Daily\nsteps:\n  - action: pull\n";

    fn git_available() -> bool {
        git_command().arg("--version").output().is_ok()
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = git_command()
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap_or_else(|err| panic!("failed to spawn git {args:?}: {err}"));
        assert!(status.success(), "git {args:?} failed in {}", cwd.display());
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn manifest_entry(version: i64, content: &str) -> RoutineFileStateAtLastSync {
        RoutineFileStateAtLastSync {
            version,
            sha256: sha256_hex_of_bytes(content.as_bytes()),
        }
    }

    fn write_op(
        path: &str,
        content: &str,
        expected_before: Option<&str>,
    ) -> PlannedLocalRoutineFileOperation {
        PlannedLocalRoutineFileOperation::WriteServerContent {
            server_relative_path: path.to_string(),
            content: content.to_string(),
            expected_sha256_hex_on_disk_before_write: expected_before
                .map(|content| sha256_hex_of_bytes(content.as_bytes())),
        }
    }

    // ── scan ──

    #[test]
    fn scan_reports_a_missing_routines_directory() {
        let tmp = TempDir::new().unwrap();
        let scan = scan_local_routine_files_directory(&tmp.path().join("routines")).unwrap();
        assert!(!scan.routines_directory_exists);
        assert!(scan.local_routine_files_by_server_path.is_empty());
    }

    #[test]
    fn scan_reads_exact_bytes_of_routine_files_and_skips_hidden_entries() {
        let tmp = TempDir::new().unwrap();
        let routines_dir = tmp.path().join("routines");
        let bytes_with_bom_and_crlf = b"\xEF\xBB\xBFname: Daily\r\nsteps:\r\n  - action: pull\r\n";
        write_file(&routines_dir.join("daily.yaml"), bytes_with_bom_and_crlf);
        write_file(&routines_dir.join("weekly.yml"), VALID_YAML.as_bytes());
        write_file(&routines_dir.join(".daily.yaml.tmp.4242"), b"half-written");
        write_file(&routines_dir.join(".DS_Store"), b"junk");

        let scan = scan_local_routine_files_directory(&routines_dir).unwrap();

        assert!(scan.routines_directory_exists);
        assert_eq!(
            scan.local_routine_files_by_server_path
                .keys()
                .collect::<Vec<_>>(),
            vec!["routines/daily.yaml", "routines/weekly.yml"]
        );
        let daily = &scan.local_routine_files_by_server_path["routines/daily.yaml"];
        assert_eq!(daily.file_bytes, bytes_with_bom_and_crlf);
        assert_eq!(
            daily.file_bytes_sha256_hex,
            sha256_hex_of_bytes(bytes_with_bom_and_crlf)
        );
        assert!(scan.entries_ignored_in_routines_directory.is_empty());
    }

    #[test]
    fn scan_lists_non_routine_entries_as_ignored() {
        let tmp = TempDir::new().unwrap();
        let routines_dir = tmp.path().join("routines");
        write_file(&routines_dir.join("notes.txt"), b"notes");
        write_file(&routines_dir.join("Daily.YAML"), VALID_YAML.as_bytes());
        fs::create_dir_all(routines_dir.join("folder.yaml")).unwrap();

        let scan = scan_local_routine_files_directory(&routines_dir).unwrap();

        assert!(scan.local_routine_files_by_server_path.is_empty());
        let ignored_names: Vec<&str> = scan
            .entries_ignored_in_routines_directory
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            ignored_names,
            vec!["Daily.YAML", "folder.yaml", "notes.txt"]
        );
        assert!(scan.entries_ignored_in_routines_directory[1]
            .1
            .contains("not a regular file"));
    }

    // ── apply ──

    #[test]
    fn apply_performs_the_file_operations_then_writes_the_manifest() {
        let tmp = TempDir::new().unwrap();
        let routines_dir = tmp.path().join("routines");
        let manifest_path = tmp.path().join("routines-state.json");
        write_file(&routines_dir.join("old.yaml"), b"old");
        write_file(&routines_dir.join("daily.yaml"), b"daily-v1");

        let plan = RoutinePullPlan {
            local_file_operations_deletes_before_writes: vec![
                PlannedLocalRoutineFileOperation::DeleteLocalFile {
                    server_relative_path: "routines/old.yaml".to_string(),
                    expected_sha256_hex_on_disk: sha256_hex_of_bytes(b"old"),
                },
                write_op("routines/daily.yaml", "daily-v2", Some("daily-v1")),
                write_op("routines/new.yaml", "new", None),
            ],
            manifest_files_after_successful_pull: BTreeMap::from([
                (
                    "routines/daily.yaml".to_string(),
                    manifest_entry(2, "daily-v2"),
                ),
                ("routines/new.yaml".to_string(), manifest_entry(1, "new")),
            ]),
            ..Default::default()
        };
        apply_routine_pull_plan_then_write_manifest_last(
            &routines_dir,
            &manifest_path,
            "wkb_1",
            &plan,
        )
        .unwrap();

        assert!(!routines_dir.join("old.yaml").exists());
        assert_eq!(
            fs::read(routines_dir.join("daily.yaml")).unwrap(),
            b"daily-v2"
        );
        assert_eq!(fs::read(routines_dir.join("new.yaml")).unwrap(), b"new");
        match read_routines_state_manifest_for_workbook(&manifest_path, "wkb_1").unwrap() {
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(manifest) => assert_eq!(
                manifest.routine_file_state_at_last_sync_by_server_path,
                plan.manifest_files_after_successful_pull
            ),
            other => panic!("unexpected manifest state: {other:?}"),
        }
    }

    #[test]
    fn apply_creates_the_routines_directory_and_manifest_for_zero_server_files() {
        let tmp = TempDir::new().unwrap();
        let routines_dir = tmp.path().join("routines");
        let manifest_path = tmp.path().join("routines-state.json");

        apply_routine_pull_plan_then_write_manifest_last(
            &routines_dir,
            &manifest_path,
            "wkb_1",
            &RoutinePullPlan::default(),
        )
        .unwrap();

        assert!(routines_dir.is_dir());
        assert_eq!(
            read_routines_state_manifest_for_workbook(&manifest_path, "wkb_1").unwrap(),
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(RoutinesStateManifest {
                workbook_id: "wkb_1".to_string(),
                routine_file_state_at_last_sync_by_server_path: BTreeMap::new(),
            })
        );
    }

    #[test]
    fn apply_aborts_without_writing_the_manifest_when_a_file_changed_since_the_scan() {
        let tmp = TempDir::new().unwrap();
        let routines_dir = tmp.path().join("routines");
        let manifest_path = tmp.path().join("routines-state.json");
        // The plan expected "daily-v1", but the user saved an edit after the scan.
        write_file(&routines_dir.join("daily.yaml"), b"saved-mid-pull");

        let plan = RoutinePullPlan {
            local_file_operations_deletes_before_writes: vec![write_op(
                "routines/daily.yaml",
                "daily-v2",
                Some("daily-v1"),
            )],
            ..Default::default()
        };
        let error = apply_routine_pull_plan_then_write_manifest_last(
            &routines_dir,
            &manifest_path,
            "wkb_1",
            &plan,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("changed on disk while the pull was running"));
        assert_eq!(
            fs::read(routines_dir.join("daily.yaml")).unwrap(),
            b"saved-mid-pull"
        );
        assert!(!manifest_path.exists());
    }

    #[test]
    fn apply_refuses_to_create_a_file_that_already_exists() {
        let tmp = TempDir::new().unwrap();
        let routines_dir = tmp.path().join("routines");
        let manifest_path = tmp.path().join("routines-state.json");
        write_file(&routines_dir.join("new.yaml"), b"appeared-after-scan");

        let plan = RoutinePullPlan {
            local_file_operations_deletes_before_writes: vec![write_op(
                "routines/new.yaml",
                "server",
                None,
            )],
            ..Default::default()
        };
        let error = apply_routine_pull_plan_then_write_manifest_last(
            &routines_dir,
            &manifest_path,
            "wkb_1",
            &plan,
        )
        .unwrap_err();

        assert!(error.to_string().contains("already exists on disk"));
        assert_eq!(
            fs::read(routines_dir.join("new.yaml")).unwrap(),
            b"appeared-after-scan"
        );
        assert!(!manifest_path.exists());
    }

    // ── legacy location ──

    #[test]
    fn legacy_detection_reports_uncommitted_routine_edits_in_a_real_config_worktree() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        run_git(&source, &["init", "-b", "main"]);
        write_file(&source.join("routines/daily.yaml"), VALID_YAML.as_bytes());
        write_file(&source.join("syncs/sync.json"), b"{}");
        run_git(&source, &["add", "-A"]);
        run_git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@t",
                "commit",
                "-m",
                "base",
            ],
        );

        let workspace_dir = tmp.path().join("workspace");
        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        let bare_config_repo = layout.bare_repo_path("wkb_test");
        fs::create_dir_all(layout.repos_dir()).unwrap();
        run_git(
            tmp.path(),
            &[
                "clone",
                "--bare",
                source.to_str().unwrap(),
                bare_config_repo.to_str().unwrap(),
            ],
        );
        crate::git_ops::setup_sparse_worktree(
            &bare_config_repo,
            &layout.workbook_materialization_path(),
            "main",
        )
        .unwrap();

        assert!(
            detect_uncommitted_routine_edits_in_legacy_config_worktree(&workspace_dir, "wkb_test")
                .is_empty(),
            "a freshly materialized worktree has no edits"
        );

        write_file(
            &layout
                .workbook_materialization_path()
                .join("routines/daily.yaml"),
            b"name: Edited by an old scratchmd\nsteps:\n  - action: pull\n",
        );
        write_file(
            &layout
                .workbook_materialization_path()
                .join("syncs/sync.json"),
            b"{\"edited\": true}",
        );
        assert_eq!(
            detect_uncommitted_routine_edits_in_legacy_config_worktree(&workspace_dir, "wkb_test"),
            vec!["routines/daily.yaml".to_string()]
        );
    }

    #[test]
    fn legacy_detection_is_skipped_when_the_config_worktree_has_no_gitlink() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        // The workspace sits inside an unrelated repository with an untracked routine file at
        // the legacy location: running `git status` there would walk up and report it.
        let tmp = TempDir::new().unwrap();
        let enclosing_repo = tmp.path().join("enclosing");
        fs::create_dir_all(&enclosing_repo).unwrap();
        run_git(&enclosing_repo, &["init", "-b", "main"]);
        let workspace_dir = enclosing_repo.join("workspace");
        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        fs::create_dir_all(layout.bare_repo_path("wkb_test")).unwrap();
        write_file(
            &layout
                .workbook_materialization_path()
                .join("routines/daily.yaml"),
            VALID_YAML.as_bytes(),
        );

        assert!(detect_uncommitted_routine_edits_in_legacy_config_worktree(
            &workspace_dir,
            "wkb_test"
        )
        .is_empty());
    }

    #[test]
    fn legacy_detection_is_skipped_when_the_gitlink_points_outside_the_workspace() {
        let tmp = TempDir::new().unwrap();
        let workspace_dir = tmp.path().join("copied-workspace");
        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        fs::create_dir_all(layout.bare_repo_path("wkb_test")).unwrap();
        let original_workspace_gitdir = tmp
            .path()
            .join("original-workspace/.repos/wkb_test.git/worktrees/workspace");
        fs::create_dir_all(&original_workspace_gitdir).unwrap();
        write_file(
            &layout.workbook_materialization_path().join(".git"),
            format!("gitdir: {}\n", original_workspace_gitdir.display()).as_bytes(),
        );
        write_file(
            &layout
                .workbook_materialization_path()
                .join("routines/daily.yaml"),
            VALID_YAML.as_bytes(),
        );

        assert!(detect_uncommitted_routine_edits_in_legacy_config_worktree(
            &workspace_dir,
            "wkb_test"
        )
        .is_empty());
    }

    // ── init --force salvage check ──

    fn workspace_with_marker(tmp: &TempDir) -> PathBuf {
        let workspace_dir = tmp.path().join("workspace");
        markers::write_workspace(
            &workspace_dir,
            "wkb_test",
            "Test",
            "org_1",
            "http://localhost:3010",
            &[],
        )
        .unwrap();
        workspace_dir
    }

    #[test]
    fn workspace_without_routine_files_has_no_unpushed_routine_edits() {
        let tmp = TempDir::new().unwrap();
        let workspace_dir = workspace_with_marker(&tmp);
        assert!(!workspace_has_unpushed_routine_file_edits(&workspace_dir));
    }

    #[test]
    fn workspace_whose_routine_files_match_the_manifest_or_were_only_deleted_has_no_unpushed_edits()
    {
        let tmp = TempDir::new().unwrap();
        let workspace_dir = workspace_with_marker(&tmp);
        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        write_file(
            &layout
                .local_routine_files_directory_path()
                .join("daily.yaml"),
            VALID_YAML.as_bytes(),
        );
        write_routines_state_manifest_atomically(
            &layout.routines_state_manifest_file_path(),
            &RoutinesStateManifest {
                workbook_id: "wkb_test".to_string(),
                routine_file_state_at_last_sync_by_server_path: BTreeMap::from([
                    (
                        "routines/daily.yaml".to_string(),
                        manifest_entry(1, VALID_YAML),
                    ),
                    (
                        "routines/deleted.yaml".to_string(),
                        manifest_entry(1, "gone"),
                    ),
                ]),
            },
        )
        .unwrap();
        assert!(!workspace_has_unpushed_routine_file_edits(&workspace_dir));
    }

    #[test]
    fn workspace_with_an_edited_or_never_pushed_routine_file_has_unpushed_edits() {
        let tmp = TempDir::new().unwrap();
        let workspace_dir = workspace_with_marker(&tmp);
        let layout = WorkspaceLayout::for_cli(&workspace_dir);
        // No manifest at all: the local file was never pushed.
        write_file(
            &layout
                .local_routine_files_directory_path()
                .join("draft.yaml"),
            VALID_YAML.as_bytes(),
        );
        assert!(workspace_has_unpushed_routine_file_edits(&workspace_dir));

        // With a manifest that records different content: an unpushed edit.
        write_routines_state_manifest_atomically(
            &layout.routines_state_manifest_file_path(),
            &RoutinesStateManifest {
                workbook_id: "wkb_test".to_string(),
                routine_file_state_at_last_sync_by_server_path: BTreeMap::from([(
                    "routines/draft.yaml".to_string(),
                    manifest_entry(3, "older content"),
                )]),
            },
        )
        .unwrap();
        assert!(workspace_has_unpushed_routine_file_edits(&workspace_dir));
    }
}
