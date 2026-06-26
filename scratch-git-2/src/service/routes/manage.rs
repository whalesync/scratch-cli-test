use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::service::envelope::{envelope, envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::*;

pub async fn init_repo(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    tracing::info!("[API] Initializing repo: {}", id);
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            GitRepo::init(&repos_dir, &id)?;
            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn delete_repo(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        move || {
            let repo_path = state.repo_path(&id);
            if repo_path.exists() {
                std::fs::remove_dir_all(&repo_path)
                    .map_err(|e| AppError::internal(format!("Failed to delete repo: {}", e)))?;
            }
            // Best-effort cleanup of index DB
            let index_path = state.index_db_path(&id);
            let _ = std::fs::remove_file(&index_path);
            // Best-effort cleanup of empty parent dirs up to repos_dir
            let mut dir = repo_path.parent();
            while let Some(parent) = dir {
                if parent == state.repos_dir {
                    break;
                }
                if std::fs::read_dir(parent)
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false)
                {
                    let _ = std::fs::remove_dir(parent);
                    dir = parent.parent();
                } else {
                    break;
                }
            }
            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn exists(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let repo_path = state.repo_path(&id);
    let exists = repo_path.exists();
    let has_head = exists && repo_path.join("HEAD").exists();

    envelope(
        &state,
        Some(&id),
        json!({
            "repoId": id,
            "repoPath": repo_path.to_string_lossy(),
            "exists": exists,
            "hasHead": has_head,
        }),
    )
}

#[derive(Deserialize, Default)]
pub struct BranchHeadQuery {
    pub branch: Option<String>,
}

/// `GET /api/repo/manage/{id}/branch-head?branch=main` — returns
/// `{ sha: <40-char-hex> | null }` for the named branch (defaults to `main`).
/// Returns `sha: null` when the branch doesn't exist (fresh repo, never
/// published) rather than 404, so callers can treat "unknown" and "missing"
/// identically. Used by the server's `/upload-patch/commit` to detect
/// staleness against the client's `baseHead`.
pub async fn branch_head(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<BranchHeadQuery>,
) -> Response {
    let branch = query.branch.unwrap_or_else(|| "main".to_string());
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        let branch = branch.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let sha = match git_repo.resolve_ref(&branch) {
                Ok(oid) => Some(oid.to_string()),
                Err(_) => None,
            };
            Ok::<_, AppError>(json!({ "sha": sha, "branch": branch }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct ResetBody {
    pub path: Option<String>,
}

pub async fn reset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ResetBody>,
) -> Response {
    let _guard = state.write_locks.acquire(&id, DIRTY_BRANCH).await;

    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;

            if let Some(path) = body.path {
                // Discard specific changes
                let dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
                if main_oid != dirty_oid {
                    let changes = git_repo.compare_commits(main_oid, dirty_oid)?;

                    let normalized_target = path.strip_prefix('/').unwrap_or(&path);
                    let changes_to_discard: Vec<_> = changes
                        .iter()
                        .filter(|c| {
                            c.path == normalized_target
                                || c.path.starts_with(&format!("{}/", normalized_target))
                        })
                        .collect();

                    let mut revert_changes = Vec::new();
                    for change in changes_to_discard {
                        if change.status == "added" {
                            revert_changes.push(FileChange {
                                path: change.path.clone(),
                                content: None,
                                oid: None,
                                change_type: ChangeType::Delete,
                            });
                        } else {
                            let main_content =
                                git_repo.get_file_content(MAIN_BRANCH, &change.path)?;
                            if let Some(content) = main_content {
                                revert_changes.push(FileChange {
                                    path: change.path.clone(),
                                    content: Some(content),
                                    oid: None,
                                    change_type: ChangeType::Modify,
                                });
                            }
                        }
                    }

                    if !revert_changes.is_empty() {
                        git_repo
                            .commit_changes_to_ref(
                                DIRTY_BRANCH,
                                &revert_changes,
                                &format!("Discard changes to {}", normalized_target),
                            )?
                            .0;
                    }
                }
            } else {
                // Reset dirty to main
                git_repo.force_ref(DIRTY_BRANCH, main_oid)?;
            }

            // If dirty now visibly matches main, advance merge_base so the
            // review list (compare merge_base ↔ dirty) reflects reality.
            // Without this, ghost files persist whenever main has drifted
            // ahead of merge_base — see `resolve_merge_base_or_main`.
            let new_dirty_oid = git_repo.resolve_ref(DIRTY_BRANCH)?;
            if git_repo
                .compare_commits(main_oid, new_dirty_oid)?
                .is_empty()
            {
                git_repo.write_tag("merge_base", main_oid)?;
            }

            Ok::<_, AppError>(json!({ "success": true }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

pub async fn count_objects(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        move || {
            let repo_path = state.repo_path(&id);
            let output = crate::shared::git_exec::git_command()
                .args(["count-objects", "-v"])
                .current_dir(&repo_path)
                .output()
                .map_err(|e| {
                    AppError::internal(format!("Failed to run git count-objects: {}", e))
                })?;
            let stats = String::from_utf8_lossy(&output.stdout).to_string();
            let gc_in_progress = state.gc_state.get(&id).map(|v| *v);
            Ok::<_, AppError>(
                json!({ "stats": stats, "gcInProgress": gc_in_progress, "engine": "gitoxide" }),
            )
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct GcBody {
    pub aggressive: Option<bool>,
}

pub async fn gc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<GcBody>,
) -> Response {
    // Check if GC is already in progress
    if state.gc_state.contains_key(&id) {
        return envelope_error(
            &state,
            Some(&id),
            AppError::conflict("GC already in progress"),
        );
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    state.gc_state.insert(id.clone(), now);

    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        let aggressive = body.aggressive.unwrap_or(false);
        move || {
            let repo_path = state.repo_path(&id);

            let get_stats = || -> String {
                crate::shared::git_exec::git_command()
                    .args(["count-objects", "-v"])
                    .current_dir(&repo_path)
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                    .unwrap_or_else(|e| format!("Failed to get stats: {}", e))
            };

            let stats_before = get_stats();

            let gc_args = if aggressive {
                vec!["gc", "--prune=now", "--aggressive"]
            } else {
                vec!["gc", "--prune=now"]
            };

            crate::shared::git_exec::git_command()
                .args(&gc_args)
                .current_dir(&repo_path)
                .output()
                .map_err(|e| AppError::internal(format!("Failed to run git gc: {}", e)))?;

            let stats_after = get_stats();

            Ok::<_, AppError>(json!({
                "success": true,
                "statsBefore": stats_before,
                "statsAfter": stats_after,
            }))
        }
    })
    .await;

    state.gc_state.remove(&id);

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

#[derive(Deserialize)]
pub struct CopyBody {
    pub from: String,
    pub to: String,
}

pub async fn copy_repo(State(state): State<AppState>, Json(body): Json<CopyBody>) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        move || {
            // Sanitize paths: strip leading slashes, reject path traversal
            let from_id = body.from.trim_start_matches('/');
            let to_id = body.to.trim_start_matches('/');
            if from_id.is_empty() || to_id.is_empty() {
                return Err(AppError::bad_request("from and to must be non-empty"));
            }
            if from_id.contains("..") || to_id.contains("..") {
                return Err(AppError::bad_request("Path traversal (..) is not allowed"));
            }

            let from_path = state.repo_path(from_id);
            let to_path = state.repo_path(to_id);

            if !from_path.exists() {
                return Err(AppError::not_found(format!(
                    "Source repo not found: {}",
                    body.from
                )));
            }
            if to_path.exists() {
                return Err(AppError::conflict(format!(
                    "Destination repo already exists: {}",
                    body.to
                )));
            }

            // Create parent directories for the destination
            if let Some(parent) = to_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::internal(format!("Failed to create destination dirs: {}", e))
                })?;
            }

            // Recursive copy
            copy_dir_recursive(&from_path, &to_path)?;

            Ok::<_, AppError>(json!({
                "success": true,
                "from": body.from,
                "to": body.to,
            }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, "copy", inner),
        Err(e) => envelope_error(&state, None, AppError::internal(e.to_string())),
    }
}

pub async fn strip_prefix(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;
            let result = git_repo.strip_top_level_prefix()?;
            Ok::<_, AppError>(result)
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

// ── Repo health: fsck + repair ──

/// Per-ref walkability snapshot. `walkable` is the clonability signal: a
/// `git clone --bare` mirrors every ref, so a single unwalkable ref (one that
/// reaches a missing/corrupt object) makes the whole clone abort with
/// "bad tree object … bad pack header".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefStatus {
    /// Full ref name, e.g. `refs/heads/dirty`.
    pub ref_name: String,
    /// Short name, e.g. `dirty`.
    pub short_name: String,
    pub sha: Option<String>,
    pub walkable: bool,
    /// First line of `git rev-list` stderr when not walkable.
    pub error: Option<String>,
}

/// Structured `git fsck` report for one bare repo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsckReport {
    /// `git fsck` reported no missing/unreadable/broken objects.
    pub fsck_clean: bool,
    /// Every ref walks cleanly ⇒ `git clone --bare` will succeed.
    pub refs_all_walkable: bool,
    pub main_walkable: bool,
    pub dirty_walkable: bool,
    /// Full names of refs that fail to walk.
    pub corrupt_refs: Vec<String>,
    /// Object ids `git fsck` reports as missing.
    pub missing_objects: Vec<String>,
    /// Object ids `git fsck` reports as unreadable.
    pub unreadable_objects: Vec<String>,
    pub refs: Vec<RefStatus>,
    /// Raw fsck output, truncated for transport.
    pub raw_fsck: String,
}

const FSCK_RAW_MAX_BYTES: usize = 16 * 1024;

fn short_ref_name(full: &str) -> String {
    full.strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/tags/"))
        .unwrap_or(full)
        .to_string()
}

/// First whitespace-delimited 40-char hex token in a line (an object id).
fn first_object_id(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|t| t.len() == 40 && t.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|s| s.to_string())
}

/// Walk every object reachable from `ref_name` (`git rev-list --objects`),
/// discarding stdout. Returns `(walkable, first_stderr_line_if_failed)`.
fn ref_is_walkable(repo_path: &std::path::Path, ref_name: &str) -> (bool, Option<String>) {
    let spawned = crate::shared::git_exec::git_command()
        .args(["rev-list", "--objects", ref_name])
        .current_dir(repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    match spawned.and_then(|child| child.wait_with_output()) {
        Ok(out) if out.status.success() => (true, None),
        Ok(out) => {
            let first_err = String::from_utf8_lossy(&out.stderr)
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string());
            (false, first_err)
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

/// List every ref as `(full_name, sha)` via `git for-each-ref`.
fn list_refs(repo_path: &std::path::Path) -> Vec<(String, Option<String>)> {
    let Ok(output) = crate::shared::git_exec::git_command()
        .args(["for-each-ref", "--format=%(refname) %(objectname)"])
        .current_dir(repo_path)
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, ' ');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let sha = parts
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some((name.to_string(), sha))
        })
        .collect()
}

/// Run `git fsck` (read-only) and assemble a structured [`FsckReport`].
fn run_fsck(repo_path: &std::path::Path) -> Result<FsckReport, AppError> {
    // Per-ref walkability — the clonability signal.
    let mut refs = Vec::new();
    let mut corrupt_refs = Vec::new();
    let mut main_walkable = false;
    let mut dirty_walkable = false;
    for (full_name, sha) in list_refs(repo_path) {
        let (walkable, error) = ref_is_walkable(repo_path, &full_name);
        if full_name == "refs/heads/main" {
            main_walkable = walkable;
        } else if full_name == "refs/heads/dirty" {
            dirty_walkable = walkable;
        }
        if !walkable {
            corrupt_refs.push(full_name.clone());
        }
        refs.push(RefStatus {
            short_name: short_ref_name(&full_name),
            ref_name: full_name,
            sha,
            walkable,
            error,
        });
    }
    let refs_all_walkable = corrupt_refs.is_empty();

    // Object-level detail from `git fsck`. We read its output regardless of exit
    // status (it exits non-zero on corruption, which is exactly the case we
    // care about).
    let fsck_out = crate::shared::git_exec::git_command()
        .args(["fsck", "--full", "--no-dangling", "--no-progress"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| AppError::internal(format!("Failed to run git fsck: {}", e)))?;
    let mut raw = String::from_utf8_lossy(&fsck_out.stdout).into_owned();
    raw.push_str(&String::from_utf8_lossy(&fsck_out.stderr));

    let mut missing_objects = Vec::new();
    let mut unreadable_objects = Vec::new();
    let mut fsck_clean = true;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        let is_problem = lower.starts_with("missing ")
            || lower.contains("broken link")
            || lower.contains("could not read")
            || lower.contains("failed to parse")
            || lower.contains("corrupt")
            || lower.starts_with("error:")
            || lower.starts_with("fatal:");
        if !is_problem {
            continue;
        }
        fsck_clean = false;
        if lower.starts_with("missing ") {
            if let Some(oid) = first_object_id(trimmed) {
                missing_objects.push(oid);
            }
        } else if lower.contains("could not read") || lower.contains("failed to parse") {
            if let Some(oid) = first_object_id(trimmed) {
                unreadable_objects.push(oid);
            }
        }
    }
    missing_objects.sort();
    missing_objects.dedup();
    unreadable_objects.sort();
    unreadable_objects.dedup();

    if raw.len() > FSCK_RAW_MAX_BYTES {
        // Keep the head — the first errors are the informative ones.
        let mut cut = FSCK_RAW_MAX_BYTES;
        while !raw.is_char_boundary(cut) {
            cut -= 1;
        }
        raw.truncate(cut);
        raw.push_str("\n… (truncated)");
    }

    Ok(FsckReport {
        fsck_clean,
        refs_all_walkable,
        main_walkable,
        dirty_walkable,
        corrupt_refs,
        missing_objects,
        unreadable_objects,
        refs,
        raw_fsck: raw,
    })
}

/// `GET /api/repo/manage/{id}/fsck` — read-only health report.
pub async fn fsck(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        move || {
            let repo_path = state.repo_path(&id);
            if !repo_path.exists() {
                return Err(AppError::not_found(format!("Repository not found: {}", id)));
            }
            run_fsck(&repo_path)
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

const REPAIR_STATUS_REPAIRED: &str = "repaired";
const REPAIR_STATUS_ALREADY_CLEAN: &str = "already_clean";
const REPAIR_STATUS_REFUSED_MAIN_CORRUPT: &str = "refused_main_corrupt";

/// Outcome of a [`repair_repo`] run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    /// `repaired` | `already_clean` | `refused_main_corrupt`.
    pub status: String,
    pub before: FsckReport,
    pub after: Option<FsckReport>,
    /// Human-readable list of the surgery performed, in order.
    pub actions: Vec<String>,
    pub dirty_reset_from: Option<String>,
    pub dirty_reset_to: Option<String>,
    pub deleted_refs: Vec<String>,
    pub gc_ran: bool,
    pub gc_output: Option<String>,
}

/// Best-effort removal of a stale commit-graph, which can otherwise wedge
/// `git gc` when it references an object that no longer parses. Returns whether
/// anything was removed.
fn remove_commit_graph(repo_path: &std::path::Path) -> bool {
    let mut removed = false;
    let file = repo_path.join("objects/info/commit-graph");
    if file.exists() && std::fs::remove_file(&file).is_ok() {
        removed = true;
    }
    let dir = repo_path.join("objects/info/commit-graphs");
    if dir.exists() && std::fs::remove_dir_all(&dir).is_ok() {
        removed = true;
    }
    removed
}

/// Delete a ref unconditionally (`git update-ref -d`). Used to drop ephemeral
/// publish-plan tags that still reach corrupt objects after the dirty reset.
fn delete_ref(repo_path: &std::path::Path, full_ref: &str) -> Result<(), AppError> {
    let output = crate::shared::git_exec::git_command()
        .args(["update-ref", "-d", full_ref])
        .current_dir(repo_path)
        .output()
        .map_err(|e| AppError::internal(format!("Failed to delete ref {}: {}", full_ref, e)))?;
    if !output.status.success() {
        return Err(AppError::internal(format!(
            "Failed to delete ref {}: {}",
            full_ref,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

/// Repair a connection repo whose corruption is confined to non-`main` refs:
/// reset a corrupt `dirty` to `main`, drop any other corrupt (publish-plan)
/// ref, remove a stale commit-graph, and `gc --prune=now`. Refuses when `main`
/// itself is corrupt — that needs manual object recovery, not a reset.
///
/// Non-destructive to published data: `main` is never rewritten. The only loss
/// is the unpublished `dirty` edits, which are unrecoverable once their objects
/// are gone anyway. Clonability is restored by the ref surgery alone (clone
/// packs only objects reachable from refs); the `gc` is hygiene and non-fatal.
fn repair_repo(repos_dir: &std::path::Path, repo_id: &str) -> Result<RepairResult, AppError> {
    let repo_path = repos_dir.join(format!("{}.git", repo_id));
    if !repo_path.exists() {
        return Err(AppError::not_found(format!(
            "Repository not found: {}",
            repo_id
        )));
    }

    let before = run_fsck(&repo_path)?;

    // Nothing to do.
    if before.fsck_clean && before.refs_all_walkable {
        return Ok(RepairResult {
            status: REPAIR_STATUS_ALREADY_CLEAN.to_string(),
            before,
            after: None,
            actions: vec!["repo is already healthy; no changes made".to_string()],
            dirty_reset_from: None,
            dirty_reset_to: None,
            deleted_refs: Vec::new(),
            gc_ran: false,
            gc_output: None,
        });
    }

    // Gate: never auto-reset when the published branch itself is corrupt.
    if !before.main_walkable {
        return Ok(RepairResult {
            status: REPAIR_STATUS_REFUSED_MAIN_CORRUPT.to_string(),
            before,
            after: None,
            actions: vec![
                "refused: refs/heads/main is missing or corrupt — published data is affected, \
                 so this needs manual object recovery rather than a dirty reset"
                    .to_string(),
            ],
            dirty_reset_from: None,
            dirty_reset_to: None,
            deleted_refs: Vec::new(),
            gc_ran: false,
            gc_output: None,
        });
    }

    let git_repo = GitRepo::open(repos_dir, repo_id)?;
    let main_oid = git_repo.resolve_ref(MAIN_BRANCH)?;

    let mut actions = Vec::new();
    let mut dirty_reset_from = None;
    let mut dirty_reset_to = None;

    // Reset a corrupt dirty branch to main, and re-point merge_base so the
    // review baseline matches (mirrors `reset`'s merge_base handling).
    if !before.dirty_walkable {
        dirty_reset_from = before
            .refs
            .iter()
            .find(|r| r.ref_name == "refs/heads/dirty")
            .and_then(|r| r.sha.clone());
        git_repo.force_ref(DIRTY_BRANCH, main_oid)?;
        git_repo.write_tag("merge_base", main_oid)?;
        dirty_reset_to = Some(main_oid.to_string());
        actions.push(format!("reset dirty → main ({})", main_oid));
        actions.push("re-pointed merge_base → main".to_string());
    }

    // Drop or re-point any remaining corrupt ref. main/dirty are handled above;
    // merge_base is re-pointed (main is healthy); everything else is an
    // ephemeral publish-plan tag that is safe to delete.
    let mut deleted_refs = Vec::new();
    for r in &before.refs {
        if r.walkable {
            continue;
        }
        match r.ref_name.as_str() {
            "refs/heads/main" | "refs/heads/dirty" => continue,
            "refs/tags/merge_base" => {
                if dirty_reset_to.is_none() {
                    git_repo.write_tag("merge_base", main_oid)?;
                    actions.push("re-pointed corrupt merge_base → main".to_string());
                }
            }
            other => {
                delete_ref(&repo_path, other)?;
                deleted_refs.push(other.to_string());
                actions.push(format!("deleted corrupt ref {}", other));
            }
        }
    }

    if remove_commit_graph(&repo_path) {
        actions.push("removed stale commit-graph".to_string());
    }

    // gc is hygiene only — clonability is already restored above. Non-fatal.
    let gc = crate::shared::git_exec::git_command()
        .args(["gc", "--prune=now"])
        .current_dir(&repo_path)
        .output();
    let (gc_ran, gc_output) = match gc {
        Ok(out) => {
            let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
            combined.push_str(&String::from_utf8_lossy(&out.stderr));
            actions.push(if out.status.success() {
                "gc --prune=now".to_string()
            } else {
                "gc --prune=now (non-zero exit, non-fatal)".to_string()
            });
            (true, Some(combined.trim().to_string()))
        }
        Err(e) => {
            actions.push(format!("gc skipped: {}", e));
            (false, None)
        }
    };

    let after = run_fsck(&repo_path)?;

    Ok(RepairResult {
        status: REPAIR_STATUS_REPAIRED.to_string(),
        before,
        after: Some(after),
        actions,
        dirty_reset_from,
        dirty_reset_to,
        deleted_refs,
        gc_ran,
        gc_output,
    })
}

/// `POST /api/repo/manage/{id}/repair` — gated repair of a corrupt repo.
pub async fn repair(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Serialize against reset/publish on the dirty branch.
    let _guard = state.write_locks.acquire(&id, DIRTY_BRANCH).await;

    // Block (and be blocked by) a concurrent gc on this repo.
    if state.gc_state.contains_key(&id) {
        return envelope_error(
            &state,
            Some(&id),
            AppError::conflict("GC already in progress"),
        );
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    state.gc_state.insert(id.clone(), now);

    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || repair_repo(&repos_dir, &id)
    })
    .await;

    state.gc_state.remove(&id);

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst)
        .map_err(|e| AppError::internal(format!("Failed to create dir {:?}: {}", dst, e)))?;

    for entry in std::fs::read_dir(src)
        .map_err(|e| AppError::internal(format!("Failed to read dir {:?}: {}", src, e)))?
    {
        let entry =
            entry.map_err(|e| AppError::internal(format!("Failed to read entry: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                AppError::internal(format!(
                    "Failed to copy {:?} -> {:?}: {}",
                    src_path, dst_path, e
                ))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Process-unique repo id (no time/rng dependency).
    fn unique_repo_id(tag: &str) -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        format!(
            "org_t/wkb_t/coa_{}_{}",
            tag,
            N.fetch_add(1, Ordering::SeqCst)
        )
    }

    fn object_path(repo_path: &std::path::Path, oid: &str) -> std::path::PathBuf {
        repo_path.join("objects").join(&oid[0..2]).join(&oid[2..])
    }

    #[test]
    fn fsck_reports_healthy_repo_as_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("healthy");
        GitRepo::init(repos_dir, &id).unwrap();
        let repo_path = repos_dir.join(format!("{}.git", id));

        let report = run_fsck(&repo_path).unwrap();
        assert!(report.fsck_clean, "raw fsck: {}", report.raw_fsck);
        assert!(report.refs_all_walkable);
        assert!(report.main_walkable);
        assert!(report.dirty_walkable);
        assert!(report.corrupt_refs.is_empty());
        assert!(report.missing_objects.is_empty());
    }

    #[test]
    fn repair_already_clean_makes_no_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("clean");
        GitRepo::init(repos_dir, &id).unwrap();

        let result = repair_repo(repos_dir, &id).unwrap();
        assert_eq!(result.status, REPAIR_STATUS_ALREADY_CLEAN);
        assert!(result.after.is_none());
        assert!(result.dirty_reset_to.is_none());
        assert!(result.deleted_refs.is_empty());
    }

    #[test]
    fn repair_resets_corrupt_dirty_to_main() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("dirty");
        let git_repo = GitRepo::init(repos_dir, &id).unwrap();
        let repo_path = repos_dir.join(format!("{}.git", id));

        let main_oid = git_repo.resolve_ref(MAIN_BRANCH).unwrap();

        // Advance dirty past main with a real edit, then delete the new dirty
        // tip commit object to simulate the prod corruption (dirty reaches a
        // missing object; main stays clean).
        let changes = vec![FileChange {
            path: "Collection/item.json".to_string(),
            content: Some("{\"k\":1}".to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }];
        git_repo
            .commit_changes_to_ref(DIRTY_BRANCH, &changes, "edit on dirty")
            .unwrap();
        let dirty_tip = git_repo.resolve_ref(DIRTY_BRANCH).unwrap().to_string();
        assert_ne!(dirty_tip, main_oid.to_string());
        std::fs::remove_file(object_path(&repo_path, &dirty_tip)).unwrap();

        // Pre-condition: dirty unwalkable, main fine.
        let before = run_fsck(&repo_path).unwrap();
        assert!(!before.dirty_walkable, "raw: {}", before.raw_fsck);
        assert!(before.main_walkable);
        assert!(!before.refs_all_walkable);

        // Repair.
        let result = repair_repo(repos_dir, &id).unwrap();
        assert_eq!(
            result.status, REPAIR_STATUS_REPAIRED,
            "actions: {:?}",
            result.actions
        );
        assert_eq!(
            result.dirty_reset_to.as_deref(),
            Some(main_oid.to_string().as_str())
        );
        let after = result.after.expect("after report");
        assert!(after.refs_all_walkable, "after raw: {}", after.raw_fsck);
        assert!(after.fsck_clean, "after raw: {}", after.raw_fsck);

        // dirty now points at main, and a fresh clone-equivalent walk succeeds.
        let reopened = GitRepo::open(repos_dir, &id).unwrap();
        assert_eq!(reopened.resolve_ref(DIRTY_BRANCH).unwrap(), main_oid);
    }

    #[test]
    fn repair_refuses_when_main_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("maincorrupt");
        let git_repo = GitRepo::init(repos_dir, &id).unwrap();
        let repo_path = repos_dir.join(format!("{}.git", id));

        // main + dirty both point at the initial commit; deleting it corrupts
        // main, which must make repair refuse rather than reset.
        let main_oid = git_repo.resolve_ref(MAIN_BRANCH).unwrap().to_string();
        std::fs::remove_file(object_path(&repo_path, &main_oid)).unwrap();

        let result = repair_repo(repos_dir, &id).unwrap();
        assert_eq!(result.status, REPAIR_STATUS_REFUSED_MAIN_CORRUPT);
        assert!(result.after.is_none());
        assert!(result.dirty_reset_to.is_none());
        assert!(!result.before.main_walkable);
    }
}
