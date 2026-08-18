use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::process::Stdio;

use crate::service::envelope::{envelope, envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::gc_marker::GcMarkerGuard;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::*;

pub async fn init_repo(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    tracing::info!("[API] Initializing repo: {}", id);
    // Repo-lifecycle mutation: serialized against every main/dirty writer of
    // the same id (and against delete/copy/strip-prefix), guards held inside
    // the task like every other write.
    let result = state
        .repo_locks
        .run_write_main_and_dirty(&id, {
            let repos_dir = state.repos_dir.clone();
            let id = id.clone();
            move || {
                GitRepo::init(&repos_dir, &id)?;
                Ok::<_, AppError>(json!({ "success": true }))
            }
        })
        .await;

    envelope_result(&state, &id, result)
}

pub async fn delete_repo(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Waits for any in-flight main/dirty write on this repo to finish before
    // removing the directory underneath it; later writers get "not found".
    let result = state
        .repo_locks
        .run_write_main_and_dirty(&id, {
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

    envelope_result(&state, &id, result)
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
    let result = state
        .repo_locks
        .run_write(&id, DIRTY_BRANCH, {
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

    envelope_result(&state, &id, result)
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

/// Env var overriding the `--prune=<expiry>` passed to `git gc` (and to the
/// hygiene gc inside `/repair`). Any value git accepts: `1.hour.ago`,
/// `2.weeks.ago`, `now`, …
pub const GC_PRUNE_EXPIRY_ENV_VAR: &str = "SCRATCH_GIT_GC_PRUNE_EXPIRY";

/// Default prune grace. **Never `now`.** git prunes unreachable objects by
/// mtime, so a grace period is the one protection that holds even when every
/// lock in this process is wrong (orphaned writer, orphaned gc, the blue/green
/// deploy window where two containers share the disk, SIGKILL): an object a
/// concurrent write is still building is younger than the grace and survives.
/// One hour is ~12× the 300 s proxy timeout that orphans requests.
/// (DEV-11266: `--prune=now` deleted objects an in-flight write still needed.)
pub const DEFAULT_GC_PRUNE_EXPIRY: &str = "1.hour.ago";

/// The `--prune=<expiry>` value to use for `git gc`, from the env or the default.
///
/// `now` (and `all`, git's alias for it) is refused and replaced by the
/// default with an error log: a zero grace is precisely what let DEV-11266
/// happen, and no operational need justifies it — use `1.minute.ago` if you
/// really want an aggressive sweep.
pub fn gc_prune_expiry() -> String {
    let configured = std::env::var(GC_PRUNE_EXPIRY_ENV_VAR)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match configured {
        Some(value) if value.eq_ignore_ascii_case("now") || value.eq_ignore_ascii_case("all") => {
            tracing::error!(
                "{}={} refused: a zero prune grace deletes objects a concurrent write is still building (DEV-11266); using {}",
                GC_PRUNE_EXPIRY_ENV_VAR,
                value,
                DEFAULT_GC_PRUNE_EXPIRY
            );
            DEFAULT_GC_PRUNE_EXPIRY.to_string()
        }
        Some(value) => value,
        None => DEFAULT_GC_PRUNE_EXPIRY.to_string(),
    }
}

/// Why a `git gc` run did not succeed. Distinguishes "git never ran" from
/// "git ran and exited non-zero" so callers (e.g. `/repair`'s `gcRan`) can
/// report truthfully.
#[derive(Debug)]
pub enum GcRunError {
    /// The `git` process could not be spawned at all (missing dir, no binary…).
    Spawn(String),
    /// `git gc` ran and exited non-zero; `stderr` is what git said.
    NonZeroExit {
        gc_args: Vec<String>,
        exit_code: Option<i32>,
        stderr: String,
        duration_ms: u128,
    },
}

impl std::fmt::Display for GcRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GcRunError::Spawn(msg) => write!(f, "Failed to run git gc: {}", msg),
            GcRunError::NonZeroExit {
                gc_args,
                exit_code,
                stderr,
                duration_ms,
            } => write!(
                f,
                "git {} failed (exit {}) after {} ms: {}",
                gc_args.join(" "),
                exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                duration_ms,
                if stderr.is_empty() {
                    "(no stderr)"
                } else {
                    stderr.as_str()
                }
            ),
        }
    }
}

impl From<GcRunError> for AppError {
    fn from(error: GcRunError) -> Self {
        AppError::internal(error.to_string())
    }
}

/// Result of one `git gc` run that exited 0.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcRunOutcome {
    pub success: bool,
    pub stats_before: String,
    pub stats_after: String,
    /// The exact `git gc …` arguments that ran, so callers/logs can see the
    /// prune expiry that was in force.
    pub gc_args: Vec<String>,
    /// git's stderr (progress/warnings) even on success — empty when quiet.
    pub stderr: String,
    pub duration_ms: u128,
}

fn count_objects_stats(repo_path: &std::path::Path) -> String {
    crate::shared::git_exec::git_command()
        .args(["count-objects", "-v"])
        .current_dir(repo_path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|e| format!("Failed to get stats: {}", e))
}

/// Run `git gc --prune=<prune_expiry> [--aggressive]` in `repo_path`, blocking.
///
/// A non-zero exit is an error, never a silent `success: true`: the classic
/// case is `gc.pid` contention (`fatal: gc is already running on machine …`,
/// exit 128) — before DEV-11316 that was reported as success, hiding that the
/// repo had not been collected at all. The error message carries git's stderr.
pub fn run_git_gc(
    repo_path: &std::path::Path,
    aggressive: bool,
    prune_expiry: &str,
) -> Result<GcRunOutcome, GcRunError> {
    let stats_before = count_objects_stats(repo_path);

    let prune_arg = format!("--prune={}", prune_expiry);
    let mut gc_args: Vec<String> = vec!["gc".to_string(), prune_arg];
    if aggressive {
        gc_args.push("--aggressive".to_string());
    }

    let started = std::time::Instant::now();
    let output = crate::shared::git_exec::git_command()
        .args(&gc_args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| GcRunError::Spawn(e.to_string()))?;
    let duration_ms = started.elapsed().as_millis();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(GcRunError::NonZeroExit {
            gc_args,
            exit_code: output.status.code(),
            stderr,
            duration_ms,
        });
    }

    let stats_after = count_objects_stats(repo_path);

    Ok(GcRunOutcome {
        success: true,
        stats_before,
        stats_after,
        gc_args,
        stderr,
        duration_ms,
    })
}

/// `POST /api/repo/manage/{id}/gc` — run `git gc` on the repo.
///
/// The `gcInProgress` marker is an RAII guard that lives **inside** the
/// blocking task, so it is cleared when `git gc` actually ends — even when the
/// client (nginx, 300 s) has long since dropped the request — and on panic.
/// (Before DEV-11316 a dropped request leaked the marker until the next
/// deploy and every later `/gc` and `/repair` on that repo 409'd.)
///
/// Note the request can still be abandoned by the client while `git gc` runs
/// on: that is fine for correctness now (the marker and the prune grace are
/// owned by the work, not the request), and DEV-11316 MR 2 detaches the run
/// from the request entirely (`waitSeconds` + `state: running`).
pub async fn gc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<GcBody>,
) -> Response {
    let Some(gc_marker) = GcMarkerGuard::try_acquire(&state.gc_state, &id) else {
        return envelope_error(
            &state,
            Some(&id),
            AppError::conflict("GC already in progress"),
        );
    };

    let aggressive = body.aggressive.unwrap_or(false);
    let prune_expiry = gc_prune_expiry();
    tracing::info!(
        "[GC] start repo={} aggressive={} prune={} startedAt={}",
        id,
        aggressive,
        prune_expiry,
        gc_marker.started_at_millis()
    );

    let join_result = tokio::task::spawn_blocking({
        let repo_path = state.repo_path(&id);
        let id = id.clone();
        move || {
            // Held until `git gc` returns (or this closure panics), regardless
            // of what happens to the HTTP request that started it.
            let _gc_marker_held_for_the_whole_gc = gc_marker;
            let outcome = run_git_gc(&repo_path, aggressive, &prune_expiry);
            match &outcome {
                Ok(o) => tracing::info!(
                    "[GC] end repo={} state=completed ms={} args={:?}",
                    id,
                    o.duration_ms,
                    o.gc_args
                ),
                Err(e) => tracing::error!("[GC] end repo={} state=failed error={}", id, e),
            }
            outcome.map_err(AppError::from)
        }
    })
    .await;
    let result = match join_result {
        Ok(outcome) => outcome,
        Err(join_error) => Err(AppError::internal(join_error.to_string())),
    };

    envelope_result(&state, &id, result)
}

#[derive(Deserialize)]
pub struct CopyBody {
    pub from: String,
    pub to: String,
}

pub async fn copy_repo(State(state): State<AppState>, Json(body): Json<CopyBody>) -> Response {
    // Sanitize paths: strip leading slashes, reject path traversal
    let from_id = body.from.trim_start_matches('/').to_string();
    let to_id = body.to.trim_start_matches('/').to_string();
    if from_id.is_empty() || to_id.is_empty() {
        return envelope_error(
            &state,
            None,
            AppError::bad_request("from and to must be non-empty"),
        );
    }
    if from_id.contains("..") || to_id.contains("..") {
        return envelope_error(
            &state,
            None,
            AppError::bad_request("Path traversal (..) is not allowed"),
        );
    }

    // Hold the SOURCE repo's main+dirty locks for the whole copy so the
    // destination is a consistent snapshot, not a half-written one.
    let result = state
        .repo_locks
        .run_write_main_and_dirty(&from_id, {
            let state = state.clone();
            let from_id = from_id.clone();
            let to_id = to_id.clone();
            move || {
                let from_path = state.repo_path(&from_id);
                let to_path = state.repo_path(&to_id);

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

    envelope_result(&state, "copy", result)
}

pub async fn strip_prefix(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Rewrites main, dirty and merge_base together → both branch locks.
    let result = state
        .repo_locks
        .run_write_main_and_dirty(&id, {
            let repos_dir = state.repos_dir.clone();
            let id = id.clone();
            move || {
                let git_repo = GitRepo::open(&repos_dir, &id)?;
                let result = git_repo.strip_top_level_prefix()?;
                Ok::<_, AppError>(result)
            }
        })
        .await;

    envelope_result(&state, &id, result)
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
/// ref, remove a stale commit-graph, and `git gc` (with the same prune grace as
/// `/gc` — see `DEFAULT_GC_PRUNE_EXPIRY`). Refuses when `main` itself is
/// corrupt — that needs manual object recovery, not a reset.
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

    // gc is hygiene only — clonability is already restored above. Non-fatal,
    // but a failure is recorded in `actions`/`gc_output`, never hidden.
    let (gc_ran, gc_output) = match run_git_gc(&repo_path, false, &gc_prune_expiry()) {
        Ok(outcome) => {
            actions.push(format!("git {}", outcome.gc_args.join(" ")));
            (true, Some(outcome.stderr))
        }
        Err(spawn_error @ GcRunError::Spawn(_)) => {
            actions.push(format!("gc skipped: {}", spawn_error));
            (false, None)
        }
        Err(exit_error @ GcRunError::NonZeroExit { .. }) => {
            actions.push(format!(
                "gc failed (non-zero exit, non-fatal): {}",
                exit_error
            ));
            (true, Some(exit_error.to_string()))
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
///
/// Serialized against every `main`/`dirty` writer (it rewrites `dirty` and
/// runs a pruning `git gc`) and against a concurrent `/gc` via the RAII
/// `gcInProgress` marker. Both the branch guards and the marker are moved
/// into the blocking task so they outlive a dropped request.
pub async fn repair(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Block (and be blocked by) a concurrent gc on this repo.
    let Some(gc_marker) = GcMarkerGuard::try_acquire(&state.gc_state, &id) else {
        return envelope_error(
            &state,
            Some(&id),
            AppError::conflict("GC already in progress"),
        );
    };

    let result = state
        .repo_locks
        .run_write_main_and_dirty(&id, {
            let repos_dir = state.repos_dir.clone();
            let id = id.clone();
            move || {
                let _gc_marker_held_for_the_whole_repair = gc_marker;
                repair_repo(&repos_dir, &id)
            }
        })
        .await;

    envelope_result(&state, &id, result)
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

    /// Write a loose blob that no ref reaches (what a gix write looks like
    /// mid-build: objects land in the ODB long before the ref moves).
    fn write_unreachable_loose_blob(repo_path: &std::path::Path, content: &str) -> String {
        use std::io::Write;
        let mut child = crate::shared::git_exec::git_command()
            .args(["hash-object", "-w", "--stdin"])
            .current_dir(repo_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(content.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn object_exists(repo_path: &std::path::Path, oid: &str) -> bool {
        crate::shared::git_exec::git_command()
            .args(["cat-file", "-e", oid])
            .current_dir(repo_path)
            .status()
            .unwrap()
            .success()
    }

    /// DEV-11266 regression pin: an unreachable object younger than the prune
    /// grace survives `git gc --prune=<grace>` (so an in-flight write's objects
    /// are safe even if every lock is wrong), but `--prune=now` — what the
    /// service used to pass — deletes it immediately.
    #[test]
    fn gc_with_prune_grace_keeps_young_unreachable_objects_but_prune_now_deletes_them() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("prunegrace");
        GitRepo::init(repos_dir, &id).unwrap();
        let repo_path = repos_dir.join(format!("{}.git", id));

        let unreachable_oid = write_unreachable_loose_blob(&repo_path, "in-flight write payload");
        assert!(object_exists(&repo_path, &unreachable_oid));

        // With the default grace the object is untouched: git prunes by mtime
        // and this one is seconds old. Normal AND aggressive mode.
        let outcome = run_git_gc(&repo_path, false, DEFAULT_GC_PRUNE_EXPIRY).unwrap();
        assert!(outcome.success);
        assert_eq!(
            outcome.gc_args,
            vec![
                "gc".to_string(),
                format!("--prune={}", DEFAULT_GC_PRUNE_EXPIRY)
            ]
        );
        assert!(
            object_exists(&repo_path, &unreachable_oid),
            "gc --prune={} deleted a seconds-old unreachable object",
            DEFAULT_GC_PRUNE_EXPIRY
        );
        run_git_gc(&repo_path, true, DEFAULT_GC_PRUNE_EXPIRY).unwrap();
        assert!(
            object_exists(&repo_path, &unreachable_oid),
            "gc --aggressive --prune={} deleted a seconds-old unreachable object",
            DEFAULT_GC_PRUNE_EXPIRY
        );

        // Now "finish the write": make a commit on main that references the
        // blob, exactly as an in-flight write would once the GC is gone. The
        // ref must resolve and fsck must be clean.
        let git_repo = GitRepo::open(repos_dir, &id).unwrap();
        let changes = vec![FileChange {
            path: "Folder/in-flight.json".to_string(),
            content: Some("in-flight write payload".to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }];
        git_repo
            .commit_changes_to_ref(MAIN_BRANCH, &changes, "finish the write")
            .unwrap();
        assert_eq!(
            git_repo
                .get_file_content(MAIN_BRANCH, "Folder/in-flight.json")
                .unwrap()
                .as_deref(),
            Some("in-flight write payload")
        );
        let report = run_fsck(&repo_path).unwrap();
        assert!(report.fsck_clean, "raw: {}", report.raw_fsck);
        assert!(report.main_walkable);

        // `--prune=now` (the pre-DEV-11316 behaviour) deletes a young
        // unreachable object — the corruption mechanism, pinned so nobody
        // reintroduces it. Fresh unreachable object since the first is now
        // reachable.
        let another_unreachable = write_unreachable_loose_blob(&repo_path, "second in-flight");
        run_git_gc(&repo_path, false, "now").unwrap();
        assert!(
            !object_exists(&repo_path, &another_unreachable),
            "expected --prune=now to delete the unreachable object (test premise)"
        );
    }

    #[test]
    fn gc_succeeds_on_unborn_bare_repo() {
        // A genuinely empty bare repo (no commits, no refs) — not GitRepo::init,
        // which creates the initial commit.
        let tmp = tempfile::tempdir().unwrap();
        let repo_path = tmp.path().join("unborn.git");
        let status = crate::shared::git_exec::git_command()
            .args(["init", "--bare", "-q"])
            .arg(&repo_path)
            .status()
            .unwrap();
        assert!(status.success());
        let outcome = run_git_gc(&repo_path, false, DEFAULT_GC_PRUNE_EXPIRY).unwrap();
        assert!(outcome.success);
        assert!(
            outcome.stats_after.contains("count: 0"),
            "{}",
            outcome.stats_after
        );
    }

    /// The silent-failure bug: `git gc` refuses to run when another gc holds
    /// `gc.pid` (exit 128, "gc is already running…"). Before DEV-11316 that was
    /// reported as `success: true`; now it is an error carrying git's stderr.
    #[test]
    fn gc_non_zero_exit_is_an_error_with_stderr() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("gcpid");
        GitRepo::init(repos_dir, &id).unwrap();
        let repo_path = repos_dir.join(format!("{}.git", id));

        // A fresh gc.pid naming another host makes git refuse regardless of
        // whether that pid is alive here (it can't check a remote pid).
        std::fs::write(
            repo_path.join("gc.pid"),
            format!("{} scratch-git-test-other-host\n", std::process::id()),
        )
        .unwrap();

        let err = run_git_gc(&repo_path, false, DEFAULT_GC_PRUNE_EXPIRY)
            .expect_err("gc.pid contention must surface as an error");
        assert!(
            matches!(
                err,
                GcRunError::NonZeroExit {
                    exit_code: Some(128),
                    ..
                }
            ),
            "got {:?}",
            err
        );
        let message = err.to_string();
        assert!(
            message.contains("exit 128"),
            "expected exit code in the error, got: {}",
            message
        );
        assert!(
            message.contains("already running"),
            "expected git's stderr in the error, got: {}",
            message
        );
    }

    #[test]
    fn gc_prune_expiry_env_override_and_default() {
        // Serialised on the env var; the test process is the only writer.
        std::env::remove_var(GC_PRUNE_EXPIRY_ENV_VAR);
        assert_eq!(gc_prune_expiry(), DEFAULT_GC_PRUNE_EXPIRY);
        std::env::set_var(GC_PRUNE_EXPIRY_ENV_VAR, "  2.days.ago ");
        assert_eq!(gc_prune_expiry(), "2.days.ago");
        std::env::set_var(GC_PRUNE_EXPIRY_ENV_VAR, "   ");
        assert_eq!(gc_prune_expiry(), DEFAULT_GC_PRUNE_EXPIRY);
        // A zero grace is refused: it is the DEV-11266 mechanism.
        for forbidden in ["now", "NOW", " all "] {
            std::env::set_var(GC_PRUNE_EXPIRY_ENV_VAR, forbidden);
            assert_eq!(
                gc_prune_expiry(),
                DEFAULT_GC_PRUNE_EXPIRY,
                "{forbidden:?} must fall back to the default"
            );
        }
        std::env::remove_var(GC_PRUNE_EXPIRY_ENV_VAR);
    }

    #[test]
    fn gc_aggressive_passes_flag_and_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path();
        let id = unique_repo_id("aggressive");
        GitRepo::init(repos_dir, &id).unwrap();
        let repo_path = repos_dir.join(format!("{}.git", id));

        let outcome = run_git_gc(&repo_path, true, DEFAULT_GC_PRUNE_EXPIRY).unwrap();
        assert_eq!(
            outcome.gc_args,
            vec![
                "gc".to_string(),
                format!("--prune={}", DEFAULT_GC_PRUNE_EXPIRY),
                "--aggressive".to_string()
            ]
        );
        assert!(outcome.stats_after.contains("count:"));
    }

    #[test]
    fn gc_on_missing_repo_dir_is_an_error_not_a_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist.git");
        let err = run_git_gc(&missing, false, DEFAULT_GC_PRUNE_EXPIRY)
            .expect_err("gc in a missing dir must fail");
        // Spawn failure (git never ran) — `/repair` reports this as gcRan=false.
        assert!(matches!(err, GcRunError::Spawn(_)), "got {:?}", err);
        assert!(matches!(AppError::from(err), AppError::Internal(_)));
    }

    fn make_state(repos_dir: &std::path::Path) -> AppState {
        AppState {
            repos_dir: repos_dir.to_path_buf(),
            index_dir: repos_dir.to_path_buf(),
            staging_dir: repos_dir.to_path_buf(),
            build_version: "test".to_string(),
            gc_state: std::sync::Arc::new(dashmap::DashMap::new()),
            repo_locks: std::sync::Arc::new(crate::service::git::lock::RepoLocks::new()),
        }
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Handler-level: `/gc` succeeds, keeps the response fields the NestJS
    /// `GitGcResponse` type reads (`success`, `statsBefore`, `statsAfter`),
    /// and the marker is gone once the handler returns.
    #[tokio::test]
    async fn gc_handler_succeeds_and_clears_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let id = unique_repo_id("gchandler");
        GitRepo::init(tmp.path(), &id).unwrap();
        let state = make_state(tmp.path());

        let response = gc(
            State(state.clone()),
            Path(id.clone()),
            Json(GcBody { aggressive: None }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["data"]["success"], true);
        assert!(body["data"]["statsBefore"].is_string());
        assert!(body["data"]["statsAfter"].is_string());
        assert_eq!(
            body["data"]["gcArgs"][1],
            format!("--prune={}", DEFAULT_GC_PRUNE_EXPIRY)
        );
        // Envelope status is computed after the marker guard dropped.
        assert!(body["status"]["gcInProgress"].is_null());
        assert!(!state.gc_state.contains_key(&id));
    }

    /// Handler-level: a held marker → 409 envelope carrying `gcInProgress`,
    /// and the existing marker is NOT disturbed by the refused call.
    #[tokio::test]
    async fn gc_handler_returns_409_while_marker_is_held_and_leaves_it_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let id = unique_repo_id("gc409");
        GitRepo::init(tmp.path(), &id).unwrap();
        let state = make_state(tmp.path());

        let held = GcMarkerGuard::try_acquire(&state.gc_state, &id).unwrap();
        let response = gc(
            State(state.clone()),
            Path(id.clone()),
            Json(GcBody { aggressive: None }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        let body = response_json(response).await;
        assert_eq!(body["data"]["error"], "GC already in progress");
        assert_eq!(body["status"]["gcInProgress"], held.started_at_millis());
        assert!(
            state.gc_state.contains_key(&id),
            "refused call must not clear the marker"
        );

        // Also blocks repair.
        let response = repair(State(state.clone()), Path(id.clone())).await;
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);

        drop(held);
        let response = gc(
            State(state.clone()),
            Path(id.clone()),
            Json(GcBody { aggressive: None }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    /// Handler-level: `gc.pid` contention → 500 whose `data.error` carries
    /// git's stderr, and no marker leak afterwards.
    #[tokio::test]
    async fn gc_handler_nonzero_exit_returns_500_with_stderr_and_clears_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let id = unique_repo_id("gchandlerpid");
        GitRepo::init(tmp.path(), &id).unwrap();
        let repo_path = tmp.path().join(format!("{}.git", id));
        std::fs::write(
            repo_path.join("gc.pid"),
            format!("{} scratch-git-test-other-host\n", std::process::id()),
        )
        .unwrap();
        let state = make_state(tmp.path());

        let response = gc(
            State(state.clone()),
            Path(id.clone()),
            Json(GcBody { aggressive: None }),
        )
        .await;
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let body = response_json(response).await;
        let error = body["data"]["error"].as_str().unwrap();
        assert!(error.contains("exit 128"), "{}", error);
        assert!(error.contains("already running"), "{}", error);
        assert!(body["status"]["gcInProgress"].is_null());
        assert!(!state.gc_state.contains_key(&id));
    }

    /// Handler-level: `/repair` aborted (client gone) while still WAITING for
    /// the branch locks must not leak the marker — the guard is captured by
    /// the not-yet-spawned closure and drops with the future.
    #[tokio::test]
    async fn repair_aborted_while_waiting_for_lock_clears_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let id = unique_repo_id("repairabort");
        GitRepo::init(tmp.path(), &id).unwrap();
        let state = make_state(tmp.path());

        let dirty_holder = state
            .repo_locks
            .acquire_branch_write_guard(&id, DIRTY_BRANCH)
            .await;
        let repair_future = tokio::spawn({
            let state = state.clone();
            let id = id.clone();
            async move { repair(State(state), Path(id)).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(state.gc_state.contains_key(&id), "marker set while waiting");
        repair_future.abort();
        let _ = repair_future.await;
        assert!(
            !state.gc_state.contains_key(&id),
            "marker leaked by a repair aborted while waiting for the lock"
        );
        drop(dirty_holder);
        // And a gc can run right away.
        let response = gc(
            State(state.clone()),
            Path(id.clone()),
            Json(GcBody { aggressive: None }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    /// Lifecycle route: `/delete` waits for an in-flight dirty write instead
    /// of removing the directory underneath it.
    #[tokio::test]
    async fn delete_repo_waits_for_in_flight_write() {
        let tmp = tempfile::tempdir().unwrap();
        let id = unique_repo_id("deletewaits");
        GitRepo::init(tmp.path(), &id).unwrap();
        let state = make_state(tmp.path());
        let repo_path = state.repo_path(&id);

        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let writer = tokio::spawn({
            let locks = state.repo_locks.clone();
            let id = id.clone();
            async move {
                locks
                    .run_write(&id, DIRTY_BRANCH, move || {
                        started_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(10))
                            .unwrap();
                        Ok::<_, AppError>(())
                    })
                    .await
            }
        });
        tokio::task::spawn_blocking(move || {
            started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
        })
        .await
        .unwrap();

        let delete_future = tokio::spawn({
            let state = state.clone();
            let id = id.clone();
            async move { delete_repo(State(state), Path(id)).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !delete_future.is_finished(),
            "delete ran under an in-flight write"
        );
        assert!(repo_path.exists());

        release_tx.send(()).unwrap();
        writer.await.unwrap().unwrap();
        let response = delete_future.await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert!(!repo_path.exists());
    }

    #[tokio::test]
    async fn copy_repo_copies_and_validates_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let from = unique_repo_id("copyfrom");
        GitRepo::init(tmp.path(), &from).unwrap();
        let state = make_state(tmp.path());
        let to = format!("{}-copy", from);

        let response = copy_repo(
            State(state.clone()),
            Json(CopyBody {
                from: format!("/{}", from),
                to: to.clone(),
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert!(GitRepo::open(tmp.path(), &to).is_ok());

        // Second copy to the same destination → 409; traversal → 400; missing → 404.
        let response = copy_repo(
            State(state.clone()),
            Json(CopyBody {
                from: from.clone(),
                to: to.clone(),
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        let response = copy_repo(
            State(state.clone()),
            Json(CopyBody {
                from: "../x".to_string(),
                to: "y".to_string(),
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let response = copy_repo(
            State(state.clone()),
            Json(CopyBody {
                from: "does/not/exist".to_string(),
                to: "z".to_string(),
            }),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    /// Handler-level: `/gc` on a missing repo → error envelope, marker cleared.
    #[tokio::test]
    async fn gc_handler_on_missing_repo_errors_and_clears_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let state = make_state(tmp.path());
        let id = unique_repo_id("gcmissing");

        let response = gc(
            State(state.clone()),
            Path(id.clone()),
            Json(GcBody { aggressive: None }),
        )
        .await;
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(!state.gc_state.contains_key(&id));
    }

    /// Handler-level: `/repair` clears the marker afterwards and blocks `/gc`
    /// while it runs; a repair while a dirty write is in flight waits for it.
    #[tokio::test]
    async fn repair_handler_clears_marker_and_waits_for_in_flight_dirty_write() {
        let tmp = tempfile::tempdir().unwrap();
        let id = unique_repo_id("repairhandler");
        GitRepo::init(tmp.path(), &id).unwrap();
        let state = make_state(tmp.path());

        // Hold the dirty lock like an in-flight write would.
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let writer = tokio::spawn({
            let locks = state.repo_locks.clone();
            let id = id.clone();
            async move {
                locks
                    .run_write(&id, DIRTY_BRANCH, move || {
                        started_tx.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(10))
                            .unwrap();
                        Ok::<_, AppError>(())
                    })
                    .await
            }
        });
        tokio::task::spawn_blocking(move || {
            started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
        })
        .await
        .unwrap();

        // Repair must wait for the writer (marker is already set while waiting).
        let repair_future = tokio::spawn({
            let state = state.clone();
            let id = id.clone();
            async move { repair(State(state), Path(id)).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !repair_future.is_finished(),
            "repair ran while a dirty write held the lock"
        );
        assert!(
            state.gc_state.contains_key(&id),
            "marker set while repair waits for the lock"
        );

        release_tx.send(()).unwrap();
        writer.await.unwrap().unwrap();
        let response = repair_future.await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["data"]["status"], REPAIR_STATUS_ALREADY_CLEAN);
        assert!(!state.gc_state.contains_key(&id));
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
