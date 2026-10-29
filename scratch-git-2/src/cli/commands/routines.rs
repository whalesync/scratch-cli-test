//! `scratchmd routines` — pull / push / status for the workbook's routine YAML files.
//!
//! The Scratch server is the source of truth for routine definitions (Postgres, DEV-11399).
//! These commands keep a local copy at `<workspace>/.scratch/routines/<name>.yaml` in sync with
//! it over the REST API (DEV-12617) — no git involved:
//!
//! - `pull`   — `GET /cli/v1/workbooks/:id/routines/files`, merged into the local copy file by
//!   file (three-way against the manifest); refuses on a conflicting edit unless `--discard-local`.
//! - `push`   — send local creates / edits / deletes to `POST …/routines/push`, each guarded by
//!   the file's `baseVersion`, so a stale push is refused (`409 blocked_stale`), never clobbers.
//! - `status` — local edits not yet pushed and server changes not yet pulled. Read-only.
//!
//! `<workspace>/.scratch/routines-state.json` (`config::routines_state_manifest`) records each
//! file's server version and content hash at the last pull/push — the merge base for all three.
//! Paths in `--json` output and messages are server-relative (`routines/<name>.yaml`).
//!
//! The work is factored into result-returning functions with structured `--json` output, so the
//! Scratch Desktop app can reuse them by shelling out to this binary (`runScratchmd(['routines',
//! ...], cwd)`) exactly as it already runs `files download` / `syncs run-local`.

mod local_routine_files;
mod routine_sync_planning;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Context;
use clap::Subcommand;

use crate::api::{
    ApiClient, ApiError, PushRoutineFilesBlockedStale, PushRoutineFilesOutcome,
    PushRoutineStaleFile,
};
use crate::config::markers;
use crate::config::routines_state_manifest::{
    read_routines_state_manifest_for_workbook, write_routines_state_manifest_atomically,
    RoutineFileStateAtLastSyncByServerPath, RoutinesStateManifest, RoutinesStateManifestOnDisk,
};
use crate::shared::layout::WorkspaceLayout;

pub(crate) use local_routine_files::workspace_has_unpushed_routine_file_edits;
use local_routine_files::{
    apply_routine_pull_plan_then_write_manifest_last,
    detect_uncommitted_routine_edits_in_legacy_config_worktree, scan_local_routine_files_directory,
    LocalRoutineDirectoryScan,
};
use routine_sync_planning::{
    build_routine_push_change_set_from_local_changes,
    classify_local_routine_changes_against_manifest,
    classify_server_routine_changes_against_manifest_by_version,
    format_blocked_stale_routine_push_message, format_routine_pull_conflicts_message,
    index_server_routine_files_skipping_paths_unusable_locally,
    merge_successful_routine_push_into_manifest_files, plan_three_way_routine_pull_by_content_hash,
    require_content_for_every_server_routine_file, server_routine_path_for_file_name,
    RoutineFileChangeKind, RoutinePullConflict, ServerRoutinePathSkippedAsUnusableLocally,
};

#[derive(Subcommand)]
pub enum RoutinesCommands {
    /// Pull routine changes from the server into `.scratch/routines/`, file by file.
    Pull {
        /// Workspace directory (default: auto-detected from the current directory).
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        /// Replace local edits to routines the server knows about with the server's copy
        /// (restoring locally deleted ones too) instead of refusing the pull on a conflict.
        /// Local-only new routine files are never touched.
        #[arg(long)]
        discard_local: bool,
    },
    /// Push local routine file changes (create / edit / delete) to the server.
    Push {
        /// Workspace directory (default: auto-detected from the current directory).
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
    /// Show local routine edits not yet pushed and server changes not yet pulled. Read-only.
    Status {
        /// Workspace directory (default: auto-detected from the current directory).
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
}

pub async fn run(cmd: RoutinesCommands, server_url: &str, json: bool) -> anyhow::Result<()> {
    match cmd {
        RoutinesCommands::Pull {
            workspace,
            discard_local,
        } => run_pull(&workspace, server_url, discard_local, json).await,
        RoutinesCommands::Status { workspace } => run_status(&workspace, server_url, json).await,
        RoutinesCommands::Push { workspace } => run_push(&workspace, server_url, json).await,
    }
}

// ── Result structs (the `--json` contracts) ──────────────────────────────────────────────────

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutinesPullResult {
    /// "up_to_date" | "updated"
    status: String,
    /// Server changes since the last pull/push (the incoming change set), by kind.
    routines_added: Vec<String>,
    routines_modified: Vec<String>,
    routines_deleted: Vec<String>,
    /// Local edits replaced by the server's copy because of `--discard-local`.
    discarded_local_edits: Vec<String>,
    /// Routine files on the server that this workspace now tracks.
    routine_count: usize,
    /// Unpushed edits an older scratchmd left in `.scratch/workspace/routines/` (ignored).
    legacy_config_worktree_routine_edits: Vec<String>,
}

impl RoutinesPullResult {
    pub(crate) fn routine_count(&self) -> usize {
        self.routine_count
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutineFileChange {
    /// "added" | "modified" | "deleted"
    status: RoutineFileChangeKind,
    path: String,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesStatusResult {
    /// Local edits not yet pushed (files on disk vs the manifest).
    local_changes: Vec<RoutineFileChange>,
    /// Server changes not yet pulled (server versions vs the manifest).
    remote_changes: Vec<RoutineFileChange>,
    /// No local edits, no server changes, and no ignored legacy edits.
    clean: bool,
    /// The server has routine changes not yet pulled.
    behind: bool,
    /// Unpushed edits an older scratchmd left in `.scratch/workspace/routines/` (ignored).
    legacy_config_worktree_routine_edits: Vec<String>,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesPushResult {
    /// "pushed" | "no_changes"
    status: String,
    upserts: Vec<String>,
    deletes: Vec<String>,
    /// The server version of each upserted file after the push.
    versions: BTreeMap<String, i64>,
    /// Number of routines the server reconciled after the push.
    routine_count: usize,
}

/// Printed on stdout in `--json` mode when a pull is refused, before the command exits 1.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesPullRefusedBecauseOfConflicts {
    /// Always "conflicts".
    status: &'static str,
    conflicts: Vec<RoutinePullConflictForJson>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinePullConflictForJson {
    path: String,
    local_change: RoutineFileChangeKind,
    server_change: RoutineFileChangeKind,
}

/// Printed on stdout in `--json` mode when a push is refused as stale, before exiting 1.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesPushRefusedAsStale<'a> {
    /// Always "blocked_stale".
    status: &'static str,
    stale_files: &'a [PushRoutineStaleFile],
}

// ── Shared context resolution ────────────────────────────────────────────────────────────────

/// The workspace paths + API client every routines command needs, resolved from the marker.
struct RoutinesCommandContext {
    workspace_dir: PathBuf,
    workbook_id: String,
    /// `<workspace>/.scratch/routines/` — the local copy of the routine files.
    local_routine_files_directory: PathBuf,
    /// `<workspace>/.scratch/routines-state.json` — the manifest.
    routines_state_manifest_file_path: PathBuf,
    api_client: ApiClient,
}

/// Resolve the routines context from `workspace_arg`, walking up to the nearest workspace marker.
/// Errors if not inside a Scratch workspace, the marker is unreadable, or the user is not
/// authenticated. Needs no connection and no config repo — routines are REST-backed.
fn resolve_routines_command_context(
    workspace_arg: &Path,
    server_url: &str,
) -> anyhow::Result<RoutinesCommandContext> {
    // Canonicalize so `find_nearest_workspace` can walk parent directories even for a relative "." arg.
    let start = dunce::canonicalize(workspace_arg).unwrap_or_else(|_| workspace_arg.to_path_buf());
    let workspace_dir = markers::find_nearest_workspace(&start).ok_or_else(|| {
        anyhow::anyhow!("Not inside a Scratch workspace. Run `scratchmd workspaces init` first, or pass --workspace.")
    })?;

    let marker_path = markers::marker_path(&workspace_dir);
    let marker = match markers::read(&marker_path)? {
        markers::Marker::Workspace(marker) => marker,
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    };

    let resolved_server_url = if marker.workbook.server_url.is_empty() {
        server_url.to_string()
    } else {
        marker.workbook.server_url.clone()
    };
    let api_client = ApiClient::from_credentials(&resolved_server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    Ok(RoutinesCommandContext {
        local_routine_files_directory: layout.local_routine_files_directory_path(),
        routines_state_manifest_file_path: layout.routines_state_manifest_file_path(),
        workspace_dir,
        workbook_id: marker.workbook.id,
        api_client,
    })
}

fn explain_routine_files_listing_error(error: ApiError, workbook_id: &str) -> anyhow::Error {
    match error {
        ApiError::NotFound(_) => anyhow::anyhow!(
            "Couldn't list routine files for workbook {workbook_id}: the server returned 404. The workbook may have been deleted, or this Scratch server is too old for this version of scratchmd."
        ),
        other => anyhow::anyhow!("Couldn't list routine files for workbook {workbook_id}: {other}"),
    }
}

// ── Warnings (stderr, so `--json` stdout stays one document) ─────────────────────────────────

fn warn_about_entries_ignored_in_routines_directory(scan: &LocalRoutineDirectoryScan) {
    for (file_name, reason) in &scan.entries_ignored_in_routines_directory {
        eprintln!("Note: ignoring .scratch/routines/{file_name}: {reason}.");
    }
}

fn warn_about_server_routine_paths_skipped(
    server_routine_paths_skipped: &[ServerRoutinePathSkippedAsUnusableLocally],
) {
    for skipped in server_routine_paths_skipped {
        eprintln!(
            "Warning: skipping server routine {}: {}. Rename it in Scratch to work with it here.",
            skipped.server_relative_path, skipped.reason
        );
    }
}

fn warn_manifest_belongs_to_different_workbook(
    ctx: &RoutinesCommandContext,
    workbook_id_recorded_in_manifest: &str,
) {
    eprintln!(
        "Warning: {} belongs to workbook {workbook_id_recorded_in_manifest}, not this workspace's workbook {}; ignoring it (the next pull rewrites it).",
        ctx.routines_state_manifest_file_path.display(),
        ctx.workbook_id
    );
}

fn legacy_config_worktree_routines_directory(ctx: &RoutinesCommandContext) -> PathBuf {
    WorkspaceLayout::for_cli(&ctx.workspace_dir)
        .workbook_materialization_path()
        .join("routines")
}

fn warn_about_legacy_config_worktree_routine_edits(
    ctx: &RoutinesCommandContext,
    legacy_routine_edits: &[String],
) {
    if legacy_routine_edits.is_empty() {
        return;
    }
    eprintln!(
        "Warning: {} has routine edits made by an older scratchmd that were never pushed ({}). Routines now live in {}; edits in the old location are ignored. Copy them into the new location and run `scratchmd routines push`.",
        legacy_config_worktree_routines_directory(ctx).display(),
        legacy_routine_edits.join(", "),
        ctx.local_routine_files_directory.display()
    );
}

// ── pull ─────────────────────────────────────────────────────────────────────────────────────

enum RoutinesPullOutcome {
    Applied(RoutinesPullResult),
    RefusedBecauseOfConflicts(Vec<RoutinePullConflict>),
}

async fn run_pull(
    workspace_arg: &Path,
    server_url: &str,
    discard_local: bool,
    json: bool,
) -> anyhow::Result<()> {
    let ctx = resolve_routines_command_context(workspace_arg, server_url)?;
    // Hold the workspace lock across fetch → apply → manifest, matching `files download`.
    let _workspace_lock = crate::config::workspace_lock::acquire(&ctx.workspace_dir)?;
    match pull_routines_holding_workspace_lock(&ctx, discard_local).await? {
        RoutinesPullOutcome::Applied(pull_result) => {
            emit_pull(&pull_result, json);
            Ok(())
        }
        RoutinesPullOutcome::RefusedBecauseOfConflicts(conflicts) => {
            if json {
                print_json(&RoutinesPullRefusedBecauseOfConflicts {
                    status: "conflicts",
                    conflicts: conflicts
                        .iter()
                        .map(|conflict| RoutinePullConflictForJson {
                            path: conflict.server_relative_path.clone(),
                            local_change: conflict.local_change,
                            server_change: conflict.server_change,
                        })
                        .collect(),
                });
            }
            anyhow::bail!("{}", format_routine_pull_conflicts_message(&conflicts))
        }
    }
}

/// The initial pull `workspaces init` runs so a fresh workspace starts with `.scratch/routines/`
/// and its manifest. Prints nothing to stdout — init owns its `--json` document — and leaves it
/// to the caller to surface an error.
pub(crate) async fn pull_routines_into_newly_initialized_workspace(
    workspace_dir: &Path,
    server_url: &str,
) -> anyhow::Result<RoutinesPullResult> {
    let ctx = resolve_routines_command_context(workspace_dir, server_url)?;
    let _workspace_lock = crate::config::workspace_lock::acquire(&ctx.workspace_dir)?;
    match pull_routines_holding_workspace_lock(&ctx, false).await? {
        RoutinesPullOutcome::Applied(pull_result) => Ok(pull_result),
        RoutinesPullOutcome::RefusedBecauseOfConflicts(conflicts) => {
            anyhow::bail!("{}", format_routine_pull_conflicts_message(&conflicts))
        }
    }
}

/// Fetch every routine file with its content and merge it into `.scratch/routines/` file by file
/// (see `plan_three_way_routine_pull_by_content_hash`). Nothing is written when any file
/// conflicts (without `--discard-local`); otherwise files are applied first and the manifest is
/// written last. Callers must hold the workspace lock.
async fn pull_routines_holding_workspace_lock(
    ctx: &RoutinesCommandContext,
    discard_local: bool,
) -> anyhow::Result<RoutinesPullOutcome> {
    let manifest_on_disk = read_routines_state_manifest_for_workbook(
        &ctx.routines_state_manifest_file_path,
        &ctx.workbook_id,
    )?;
    let scan = scan_local_routine_files_directory(&ctx.local_routine_files_directory)?;
    warn_about_entries_ignored_in_routines_directory(&scan);
    let legacy_routine_edits = detect_uncommitted_routine_edits_in_legacy_config_worktree(
        &ctx.workspace_dir,
        &ctx.workbook_id,
    );

    let manifest_files_to_merge_against: RoutineFileStateAtLastSyncByServerPath =
        match manifest_on_disk {
            RoutinesStateManifestOnDisk::NeverPulled => {
                // First REST-backed pull in a workspace an older scratchmd left unpushed routine
                // edits in: don't let them slip by unnoticed.
                if !legacy_routine_edits.is_empty() && !discard_local {
                    anyhow::bail!(
                        "Found routine edits made by an older scratchmd that were never pushed, in {}: {}. Routines now live in {} and are no longer read from the old location. Re-run with --discard-local to pull anyway (the old files are left untouched), then copy your edits into the new location and run `scratchmd routines push`.",
                        legacy_config_worktree_routines_directory(ctx).display(),
                        legacy_routine_edits.join(", "),
                        ctx.local_routine_files_directory.display()
                    );
                }
                Default::default()
            }
            RoutinesStateManifestOnDisk::BelongsToDifferentWorkbook {
                workbook_id_recorded_in_manifest,
            } => {
                warn_manifest_belongs_to_different_workbook(ctx, &workbook_id_recorded_in_manifest);
                Default::default()
            }
            // A missing routines directory means "not materialized", not "delete everything":
            // merge against an empty base so every server file is restored.
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(_)
                if !scan.routines_directory_exists =>
            {
                Default::default()
            }
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(manifest) => {
                manifest.routine_file_state_at_last_sync_by_server_path
            }
        };
    warn_about_legacy_config_worktree_routine_edits(ctx, &legacy_routine_edits);

    // Created up front so routine files can be dropped in even if the fetch below fails.
    std::fs::create_dir_all(&ctx.local_routine_files_directory).with_context(|| {
        format!(
            "failed to create {}",
            ctx.local_routine_files_directory.display()
        )
    })?;

    let routine_files_listing = ctx
        .api_client
        .list_routine_files(&ctx.workbook_id, false)
        .await
        .map_err(|error| explain_routine_files_listing_error(error, &ctx.workbook_id))?;
    let indexed_server_routine_files =
        index_server_routine_files_skipping_paths_unusable_locally(routine_files_listing.files);
    warn_about_server_routine_paths_skipped(
        &indexed_server_routine_files.server_routine_paths_skipped_as_unusable_locally,
    );
    let skipped_server_routine_paths = indexed_server_routine_files.skipped_server_routine_paths();
    let server_routine_files_with_content = require_content_for_every_server_routine_file(
        indexed_server_routine_files.server_routine_files_by_path,
    )?;

    let plan = plan_three_way_routine_pull_by_content_hash(
        &manifest_files_to_merge_against,
        &scan.local_routine_files_by_server_path,
        &server_routine_files_with_content,
        &skipped_server_routine_paths,
        discard_local,
    );
    if !plan.conflicts_between_local_and_server_changes.is_empty() {
        return Ok(RoutinesPullOutcome::RefusedBecauseOfConflicts(
            plan.conflicts_between_local_and_server_changes,
        ));
    }

    apply_routine_pull_plan_then_write_manifest_last(
        &ctx.local_routine_files_directory,
        &ctx.routines_state_manifest_file_path,
        &ctx.workbook_id,
        &plan,
    )?;

    let anything_changed = !plan.server_paths_added_since_last_sync.is_empty()
        || !plan.server_paths_modified_since_last_sync.is_empty()
        || !plan.server_paths_deleted_since_last_sync.is_empty()
        || !plan.local_edits_discarded.is_empty();
    Ok(RoutinesPullOutcome::Applied(RoutinesPullResult {
        status: if anything_changed {
            "updated"
        } else {
            "up_to_date"
        }
        .to_string(),
        routines_added: plan.server_paths_added_since_last_sync,
        routines_modified: plan.server_paths_modified_since_last_sync,
        routines_deleted: plan.server_paths_deleted_since_last_sync,
        discarded_local_edits: plan.local_edits_discarded,
        routine_count: server_routine_files_with_content.len(),
        legacy_config_worktree_routine_edits: legacy_routine_edits,
    }))
}

fn emit_pull(result: &RoutinesPullResult, json: bool) {
    if json {
        print_json(result);
        return;
    }
    if result.status == "up_to_date" {
        println!(
            "Routines are up to date ({} routine file(s)).",
            result.routine_count
        );
        return;
    }
    let server_change_count = result.routines_added.len()
        + result.routines_modified.len()
        + result.routines_deleted.len();
    println!(
        "Pulled {server_change_count} server routine change(s): +{} ~{} -{}",
        result.routines_added.len(),
        result.routines_modified.len(),
        result.routines_deleted.len(),
    );
    for path in &result.routines_added {
        println!("  added    {path}");
    }
    for path in &result.routines_modified {
        println!("  modified {path}");
    }
    for path in &result.routines_deleted {
        println!("  deleted  {path}");
    }
    if !result.discarded_local_edits.is_empty() {
        println!("Discarded local edits (replaced by the server's copy):");
        for path in &result.discarded_local_edits {
            println!("  {path}");
        }
    }
}

// ── status ───────────────────────────────────────────────────────────────────────────────────

async fn run_status(workspace_arg: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let ctx = resolve_routines_command_context(workspace_arg, server_url)?;
    // Read-only: no workspace lock (atomic writes mean a concurrent pull can't show half a file).
    let status_result = collect_routines_status(&ctx).await?;
    emit_status(&status_result, json);
    Ok(())
}

async fn collect_routines_status(
    ctx: &RoutinesCommandContext,
) -> anyhow::Result<RoutinesStatusResult> {
    let manifest_on_disk = read_routines_state_manifest_for_workbook(
        &ctx.routines_state_manifest_file_path,
        &ctx.workbook_id,
    )?;
    let scan = scan_local_routine_files_directory(&ctx.local_routine_files_directory)?;
    warn_about_entries_ignored_in_routines_directory(&scan);
    let legacy_routine_edits = detect_uncommitted_routine_edits_in_legacy_config_worktree(
        &ctx.workspace_dir,
        &ctx.workbook_id,
    );

    let manifest_files_to_compare_against: RoutineFileStateAtLastSyncByServerPath =
        match manifest_on_disk {
            RoutinesStateManifestOnDisk::NeverPulled => Default::default(),
            RoutinesStateManifestOnDisk::BelongsToDifferentWorkbook {
                workbook_id_recorded_in_manifest,
            } => {
                warn_manifest_belongs_to_different_workbook(ctx, &workbook_id_recorded_in_manifest);
                Default::default()
            }
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(_)
                if !scan.routines_directory_exists =>
            {
                eprintln!(
                    "Note: {} is missing; run `scratchmd routines pull` to restore it.",
                    ctx.local_routine_files_directory.display()
                );
                Default::default()
            }
            RoutinesStateManifestOnDisk::BelongsToThisWorkbook(manifest) => {
                manifest.routine_file_state_at_last_sync_by_server_path
            }
        };
    warn_about_legacy_config_worktree_routine_edits(ctx, &legacy_routine_edits);

    let routine_files_listing = ctx
        .api_client
        .list_routine_files(&ctx.workbook_id, true)
        .await
        .map_err(|error| explain_routine_files_listing_error(error, &ctx.workbook_id))?;
    let indexed_server_routine_files =
        index_server_routine_files_skipping_paths_unusable_locally(routine_files_listing.files);
    warn_about_server_routine_paths_skipped(
        &indexed_server_routine_files.server_routine_paths_skipped_as_unusable_locally,
    );

    let into_routine_file_changes = |changes: Vec<(String, RoutineFileChangeKind)>| {
        changes
            .into_iter()
            .map(|(path, status)| RoutineFileChange { status, path })
            .collect::<Vec<_>>()
    };
    let local_changes = into_routine_file_changes(classify_local_routine_changes_against_manifest(
        &manifest_files_to_compare_against,
        &scan.local_routine_files_by_server_path,
    ));
    let remote_changes =
        into_routine_file_changes(classify_server_routine_changes_against_manifest_by_version(
            &manifest_files_to_compare_against,
            &indexed_server_routine_files.server_routine_files_by_path,
            &indexed_server_routine_files.skipped_server_routine_paths(),
        ));

    Ok(RoutinesStatusResult {
        clean: local_changes.is_empty()
            && remote_changes.is_empty()
            && legacy_routine_edits.is_empty(),
        behind: !remote_changes.is_empty(),
        local_changes,
        remote_changes,
        legacy_config_worktree_routine_edits: legacy_routine_edits,
    })
}

fn emit_status(result: &RoutinesStatusResult, json: bool) {
    if json {
        print_json(result);
        return;
    }
    if result.clean {
        println!("Routines are in sync with the server.");
        return;
    }
    if !result.local_changes.is_empty() {
        println!("Local routine edits (not yet pushed — run `scratchmd routines push`):");
        for change in &result.local_changes {
            println!("  {:<8} {}", change.status.as_str(), change.path);
        }
    }
    if !result.remote_changes.is_empty() {
        println!("Server routine changes (not yet pulled — run `scratchmd routines pull`):");
        for change in &result.remote_changes {
            println!("  {:<8} {}", change.status.as_str(), change.path);
        }
    }
    if !result.legacy_config_worktree_routine_edits.is_empty() {
        println!("Ignored edits in the old location .scratch/workspace/routines/ (copy them into .scratch/routines/):");
        for path in &result.legacy_config_worktree_routine_edits {
            println!("  {path}");
        }
    }
}

// ── push ─────────────────────────────────────────────────────────────────────────────────────

enum RoutinesPushOutcome {
    Completed(RoutinesPushResult),
    RefusedAsStale(PushRoutineFilesBlockedStale),
}

async fn run_push(workspace_arg: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let ctx = resolve_routines_command_context(workspace_arg, server_url)?;
    // The manifest must not change between building the change set and recording the result.
    let _workspace_lock = crate::config::workspace_lock::acquire(&ctx.workspace_dir)?;
    match push_routines_holding_workspace_lock(&ctx).await? {
        RoutinesPushOutcome::Completed(push_result) => {
            emit_push(&push_result, json);
            Ok(())
        }
        RoutinesPushOutcome::RefusedAsStale(blocked_stale) => {
            if json {
                print_json(&RoutinesPushRefusedAsStale {
                    status: "blocked_stale",
                    stale_files: &blocked_stale.stale_files,
                });
            }
            if blocked_stale.stale_files.is_empty() && !blocked_stale.message.is_empty() {
                anyhow::bail!("{}", blocked_stale.message);
            }
            anyhow::bail!(
                "{}",
                format_blocked_stale_routine_push_message(&blocked_stale.stale_files)
            )
        }
    }
}

/// Push local routine changes (vs the manifest), each guarded by its `baseVersion`, then record
/// the pushed files' new versions in the manifest. A stale push is refused by the server as a
/// whole, with nothing written. Callers must hold the workspace lock.
async fn push_routines_holding_workspace_lock(
    ctx: &RoutinesCommandContext,
) -> anyhow::Result<RoutinesPushOutcome> {
    let manifest_on_disk = read_routines_state_manifest_for_workbook(
        &ctx.routines_state_manifest_file_path,
        &ctx.workbook_id,
    )?;
    let legacy_routine_edits = detect_uncommitted_routine_edits_in_legacy_config_worktree(
        &ctx.workspace_dir,
        &ctx.workbook_id,
    );

    let manifest_files_at_last_sync: RoutineFileStateAtLastSyncByServerPath = match manifest_on_disk
    {
        RoutinesStateManifestOnDisk::BelongsToDifferentWorkbook {
            workbook_id_recorded_in_manifest,
        } => anyhow::bail!(
            "{} belongs to workbook {workbook_id_recorded_in_manifest}, not this workspace's workbook {}, so nothing was pushed. Run `scratchmd routines pull` to rebuild it, then push.",
            ctx.routines_state_manifest_file_path.display(),
            ctx.workbook_id
        ),
        RoutinesStateManifestOnDisk::NeverPulled => {
            // Otherwise this would report `no_changes` while the user's edits sit in the old location.
            if !legacy_routine_edits.is_empty() {
                anyhow::bail!(
                    "Found routine edits made by an older scratchmd that were never pushed, in {}: {}. Nothing was pushed: routines now live in {}. Run `scratchmd routines pull --discard-local` (the old files are left untouched), copy your edits into the new location, then push.",
                    legacy_config_worktree_routines_directory(ctx).display(),
                    legacy_routine_edits.join(", "),
                    ctx.local_routine_files_directory.display()
                );
            }
            Default::default()
        }
        RoutinesStateManifestOnDisk::BelongsToThisWorkbook(manifest) => {
            manifest.routine_file_state_at_last_sync_by_server_path
        }
    };
    warn_about_legacy_config_worktree_routine_edits(ctx, &legacy_routine_edits);

    let scan = scan_local_routine_files_directory(&ctx.local_routine_files_directory)?;
    warn_about_entries_ignored_in_routines_directory(&scan);

    // A missing directory means the routines aren't on disk — never "delete them all".
    if !scan.routines_directory_exists && !manifest_files_at_last_sync.is_empty() {
        anyhow::bail!(
            "{} is missing, so nothing was pushed (pushing would delete all {} routine(s) on the server). Run `scratchmd routines pull` to restore it. To delete routines, remove their files individually and push.",
            ctx.local_routine_files_directory.display(),
            manifest_files_at_last_sync.len()
        );
    }
    // A tracked routine that's now a directory / broken symlink would otherwise read as deleted.
    let tracked_routines_that_are_not_regular_files: Vec<String> = scan
        .entries_ignored_in_routines_directory
        .iter()
        .map(|(file_name, _)| server_routine_path_for_file_name(file_name))
        .filter(|server_relative_path| {
            manifest_files_at_last_sync.contains_key(server_relative_path)
        })
        .collect();
    if !tracked_routines_that_are_not_regular_files.is_empty() {
        anyhow::bail!(
            "These routines exist in .scratch/routines/ but aren't readable regular files, so nothing was pushed: {}. Restore them as regular files (or remove them to delete the routines), then push again.",
            tracked_routines_that_are_not_regular_files.join(", ")
        );
    }

    let change_set = build_routine_push_change_set_from_local_changes(
        &manifest_files_at_last_sync,
        &scan.local_routine_files_by_server_path,
    )?;
    if change_set.is_empty() {
        return Ok(RoutinesPushOutcome::Completed(RoutinesPushResult {
            status: "no_changes".to_string(),
            ..Default::default()
        }));
    }

    match ctx
        .api_client
        .push_routine_files(&ctx.workbook_id, &change_set.to_push_request())
        .await
    {
        Ok(PushRoutineFilesOutcome::Pushed(push_response)) => {
            let merge = merge_successful_routine_push_into_manifest_files(
                &manifest_files_at_last_sync,
                &change_set,
                &push_response.files,
            );
            for missing_path in &merge.pushed_upsert_paths_missing_from_server_response {
                eprintln!(
                    "Warning: the server's push response didn't list {missing_path}; run `scratchmd routines pull` to record its new version."
                );
            }
            if let Err(manifest_write_error) = write_routines_state_manifest_atomically(
                &ctx.routines_state_manifest_file_path,
                &RoutinesStateManifest {
                    workbook_id: ctx.workbook_id.clone(),
                    routine_file_state_at_last_sync_by_server_path: merge
                        .manifest_files_after_push,
                },
            ) {
                anyhow::bail!(
                    "The push was applied on the server, but recording it locally failed ({manifest_write_error:#}). Run `scratchmd routines pull` to resync before editing further."
                );
            }
            Ok(RoutinesPushOutcome::Completed(RoutinesPushResult {
                status: "pushed".to_string(),
                upserts: change_set
                    .upserts
                    .iter()
                    .map(|upsert| upsert.path.clone())
                    .collect(),
                deletes: change_set
                    .deletes
                    .iter()
                    .map(|delete| delete.path.clone())
                    .collect(),
                versions: merge.server_version_by_pushed_upsert_path,
                routine_count: push_response.routines.len(),
            }))
        }
        Ok(PushRoutineFilesOutcome::BlockedStale(blocked_stale)) => {
            Ok(RoutinesPushOutcome::RefusedAsStale(blocked_stale))
        }
        // The server reloads routines after committing the push, so even a 500 can follow a
        // successful write (and a lost response isn't retried for a POST).
        Err(push_error) => anyhow::bail!(
            "Pushing routines failed: {push_error}\nThe server may still have applied the push — run `scratchmd routines pull` before retrying."
        ),
    }
}

fn emit_push(result: &RoutinesPushResult, json: bool) {
    if json {
        print_json(result);
        return;
    }
    if result.status == "no_changes" {
        println!("No local routine changes to push.");
        return;
    }
    println!(
        "Pushed routines: {} upsert(s), {} delete(s).",
        result.upserts.len(),
        result.deletes.len(),
    );
    for path in &result.upserts {
        match result.versions.get(path) {
            Some(version) => println!("  upsert {path} (now version {version})"),
            None => println!("  upsert {path}"),
        }
    }
    for path in &result.deletes {
        println!("  delete {path}");
    }
}

fn print_json<T: serde::Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(err) => eprintln!("failed to serialize JSON output: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_object_keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    // These lock down the `--json` contracts scratch-cli-tests (and any future desktop consumer)
    // rely on: field names, and that the pre-DEV-12617 git heads / `no_repo` are gone.

    #[test]
    fn pull_result_json_uses_the_documented_contract() {
        let pull_json = serde_json::to_value(RoutinesPullResult {
            status: "updated".to_string(),
            routines_added: vec!["routines/a.yaml".to_string()],
            routine_count: 1,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            json_object_keys(&pull_json),
            vec![
                "discardedLocalEdits",
                "legacyConfigWorktreeRoutineEdits",
                "routineCount",
                "routinesAdded",
                "routinesDeleted",
                "routinesModified",
                "status"
            ]
        );
        assert_eq!(
            pull_json["routinesAdded"],
            serde_json::json!(["routines/a.yaml"])
        );
    }

    #[test]
    fn status_result_json_uses_the_documented_contract() {
        let status_json = serde_json::to_value(RoutinesStatusResult {
            local_changes: vec![RoutineFileChange {
                status: RoutineFileChangeKind::Added,
                path: "routines/a.yaml".to_string(),
            }],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            json_object_keys(&status_json),
            vec![
                "behind",
                "clean",
                "legacyConfigWorktreeRoutineEdits",
                "localChanges",
                "remoteChanges"
            ]
        );
        assert_eq!(
            status_json["localChanges"],
            serde_json::json!([{ "status": "added", "path": "routines/a.yaml" }])
        );
    }

    #[test]
    fn push_result_json_uses_the_documented_contract() {
        let push_json = serde_json::to_value(RoutinesPushResult {
            status: "pushed".to_string(),
            upserts: vec!["routines/a.yaml".to_string()],
            versions: BTreeMap::from([("routines/a.yaml".to_string(), 3)]),
            routine_count: 1,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            json_object_keys(&push_json),
            vec!["deletes", "routineCount", "status", "upserts", "versions"]
        );
        assert_eq!(
            push_json["versions"],
            serde_json::json!({ "routines/a.yaml": 3 })
        );
    }

    #[test]
    fn refusal_json_documents_name_the_conflicting_and_stale_files() {
        let conflicts_json = serde_json::to_value(RoutinesPullRefusedBecauseOfConflicts {
            status: "conflicts",
            conflicts: vec![RoutinePullConflictForJson {
                path: "routines/a.yaml".to_string(),
                local_change: RoutineFileChangeKind::Modified,
                server_change: RoutineFileChangeKind::Deleted,
            }],
        })
        .unwrap();
        assert_eq!(
            conflicts_json,
            serde_json::json!({
                "status": "conflicts",
                "conflicts": [{ "path": "routines/a.yaml", "localChange": "modified", "serverChange": "deleted" }]
            })
        );

        let stale_files = vec![PushRoutineStaleFile {
            path: "routines/a.yaml".to_string(),
            base_version: None,
            current_version: Some(2),
        }];
        let stale_json = serde_json::to_value(RoutinesPushRefusedAsStale {
            status: "blocked_stale",
            stale_files: &stale_files,
        })
        .unwrap();
        assert_eq!(
            stale_json,
            serde_json::json!({
                "status": "blocked_stale",
                "staleFiles": [{ "path": "routines/a.yaml", "baseVersion": null, "currentVersion": 2 }]
            })
        );
    }
}
