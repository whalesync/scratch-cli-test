//! `scratchmd routines` — pull / push / status for routine YAML files in the workbook config repo.
//!
//! Routines are git-authoritative YAML files at `routines/*.yaml` in the workbook **config repo**
//! (`{workbookId}.git`), which the CLI materializes into `<workspace>/.scratch/workspace/` at
//! `workspaces init`. These commands keep that local copy in sync with the server:
//!
//! - `pull`   — fetch the config repo and re-materialize the worktree (read/share direction).
//! - `push`   — send local routine edits (create/update/delete) to the server, which commits and
//!   reloads them. Server-mediated (the config-git proxy is fetch-only).
//! - `status` — report local uncommitted edits and server drift, read-only.
//!
//! The work is factored into result-returning functions (`pull_routines`, `collect_routines_status`,
//! `push_routines`) with structured `--json` output, so the Scratch Desktop app can reuse them by
//! shelling out to this binary (`runScratchmd(['routines', ...], cwd)`) exactly as it already runs
//! `files download` / `syncs run-local` — no separate native code required.

use std::path::{Path, PathBuf};

use anyhow::Context;
use clap::Subcommand;

use crate::api::{ApiClient, RoutineUpsert, RoutinesPushOutcome, RoutinesPushRequest};
use crate::config::markers;
use crate::git_ops::{self, rev_parse_optional_to_string};
use crate::shared::layout::WorkspaceLayout;

/// Repo-relative prefix (with trailing slash) for routine files. Used both as a `git` pathspec and
/// to filter diff output down to routine files.
const ROUTINES_DIR_PREFIX: &str = "routines/";
const MAIN_REF: &str = "refs/heads/main";
const ORIGIN_MAIN_REF: &str = "refs/remotes/origin/main";

#[derive(Subcommand)]
pub enum RoutinesCommands {
    /// Pull the latest routine files from the server into the local workspace.
    Pull {
        /// Workspace directory (default: auto-detected from the current directory).
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        /// Overwrite local uncommitted routine edits instead of refusing the pull.
        #[arg(long)]
        discard_local: bool,
    },
    /// Push local routine file changes (create / update / delete) to the server.
    Push {
        /// Workspace directory (default: auto-detected from the current directory).
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
    /// Show local routine edits and server drift. Read-only.
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
        } => run_pull(&workspace, server_url, discard_local, json),
        RoutinesCommands::Status { workspace } => run_status(&workspace, server_url, json),
        RoutinesCommands::Push { workspace } => run_push(&workspace, server_url, json).await,
    }
}

// ── Result structs (the `--json` contracts; mirrored by desktop TypeScript types) ─────────────

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesPullResult {
    /// "up_to_date" | "updated" | "no_repo"
    status: String,
    routines_added: Vec<String>,
    routines_modified: Vec<String>,
    routines_deleted: Vec<String>,
    old_head: Option<String>,
    new_head: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutineFileChange {
    /// "added" | "modified" | "deleted"
    status: String,
    path: String,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesStatusResult {
    /// Local uncommitted routine edits (worktree vs HEAD).
    local_changes: Vec<RoutineFileChange>,
    /// Server drift: routine files that differ between local `main` and `origin/main`.
    remote_changes: Vec<RoutineFileChange>,
    local_head: Option<String>,
    remote_head: Option<String>,
    /// No local edits and no server drift.
    clean: bool,
    /// The server has routine changes not yet pulled.
    behind: bool,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutinesPushResult {
    /// "pushed" | "no_changes"
    status: String,
    upserts: Vec<String>,
    deletes: Vec<String>,
    head: Option<String>,
    /// Number of routines the server reconciled after the push.
    routine_count: usize,
}

// ── Shared context resolution ──────────────────────────────────────────────────────────────────

/// The workspace paths + auth needed by every routines command. Resolved from the workspace marker.
struct RoutinesContext {
    workspace_dir: PathBuf,
    /// `<workspace>/.repos/<workbookId>.git` — the config repo, cloned bare at `workspaces init`.
    bare_repo: PathBuf,
    /// `<workspace>/.scratch/workspace/` — the materialized config worktree holding `routines/`.
    worktree: PathBuf,
    workbook_id: String,
    server_url: String,
    token: String,
}

/// Resolves the routines context from `workspace_arg`, walking up to the nearest workspace marker.
/// Errors if not inside a Scratch workspace, the marker is unreadable, or the user is not
/// authenticated. Does NOT require the config repo to exist on disk — each command decides how to
/// handle a not-yet-materialized workspace.
fn resolve_routines_context(
    workspace_arg: &Path,
    server_url: &str,
) -> anyhow::Result<RoutinesContext> {
    // Canonicalize so `find_nearest_workspace` can walk parent directories even for a relative "." arg.
    let start =
        std::fs::canonicalize(workspace_arg).unwrap_or_else(|_| workspace_arg.to_path_buf());
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

    let workbook_id = marker.workbook.id.clone();
    let resolved_server_url = if marker.workbook.server_url.is_empty() {
        server_url.to_string()
    } else {
        marker.workbook.server_url.clone()
    };
    let token = get_token(&resolved_server_url)?;

    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let bare_repo = layout.bare_repo_path(&workbook_id);
    let worktree = layout.workbook_materialization_path();

    Ok(RoutinesContext {
        workspace_dir,
        bare_repo,
        worktree,
        workbook_id,
        server_url: resolved_server_url,
        token,
    })
}

fn get_token(server_url: &str) -> anyhow::Result<String> {
    let creds = crate::config::credentials::get(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;
    if creds.api_token.is_empty() {
        anyhow::bail!("Not authenticated. Run `scratchmd auth login` first.");
    }
    Ok(creds.api_token)
}

// ── pull ─────────────────────────────────────────────────────────────────────────────────────

fn run_pull(
    workspace_arg: &Path,
    server_url: &str,
    discard_local: bool,
    json: bool,
) -> anyhow::Result<()> {
    let ctx = resolve_routines_context(workspace_arg, server_url)?;

    if !ctx.bare_repo.exists() {
        let result = RoutinesPullResult {
            status: "no_repo".to_string(),
            ..Default::default()
        };
        emit_pull(&result, json);
        return Ok(());
    }

    // Hold the workspace lock for fetch → materialize → ref bump, matching `files download`.
    let _lock = crate::config::workspace_lock::acquire(&ctx.workspace_dir)?;
    let result = pull_routines(&ctx, discard_local)?;
    emit_pull(&result, json);
    Ok(())
}

/// Fetches the config repo and, when `origin/main` is ahead, re-materializes the worktree to it.
/// Crash-safe: the worktree is materialized BEFORE the local `main` ref is advanced, so a crash
/// mid-materialize leaves `main` at the old head and the next pull re-converges.
fn pull_routines(ctx: &RoutinesContext, discard_local: bool) -> anyhow::Result<RoutinesPullResult> {
    let mut result = RoutinesPullResult::default();

    git_ops::fetch_origin(&ctx.bare_repo, &ctx.token)?;

    let old_head = rev_parse_optional_to_string(&ctx.bare_repo, MAIN_REF)?;
    let new_head = rev_parse_optional_to_string(&ctx.bare_repo, ORIGIN_MAIN_REF)?;
    result.old_head = old_head.clone();
    result.new_head = new_head.clone();

    let Some(new_head) = new_head else {
        // No `origin/main` to track — nothing to pull.
        result.status = "up_to_date".to_string();
        return Ok(result);
    };
    if old_head.as_deref() == Some(new_head.as_str()) {
        result.status = "up_to_date".to_string();
        return Ok(result);
    }

    // Refuse to clobber local routine edits unless --discard-local (re-materialize wipes the worktree).
    let local_changes = git_ops::worktree_status_porcelain(&ctx.worktree, ROUTINES_DIR_PREFIX)?;
    if !local_changes.is_empty() && !discard_local {
        let dirty_paths = local_changes
            .iter()
            .map(|(_, path)| path.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        anyhow::bail!(
            "Local routine edits would be overwritten by pull: {dirty_paths}. \
             Push them first (`scratchmd routines push`) or re-run with --discard-local."
        );
    }

    // Report the incoming change set (local `main` → `origin/main`), scoped to routines/.
    if let Some(old_head) = old_head.as_deref() {
        for (status, path) in git_ops::diff_name_status(&ctx.bare_repo, old_head, &new_head)? {
            if !path.starts_with(ROUTINES_DIR_PREFIX) {
                continue;
            }
            match status.as_str() {
                "added" => result.routines_added.push(path),
                "deleted" => result.routines_deleted.push(path),
                _ => result.routines_modified.push(path),
            }
        }
    }

    // Materialize to the new head (detached), THEN advance `main` — crash-safe ordering.
    git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree, &new_head)?;
    git_ops::update_ref(&ctx.bare_repo, MAIN_REF, &new_head)?;

    result.status = "updated".to_string();
    Ok(result)
}

fn emit_pull(result: &RoutinesPullResult, json: bool) {
    if json {
        print_json(result);
        return;
    }
    match result.status.as_str() {
        "no_repo" => println!(
            "No workbook config repo found locally. Run `scratchmd workspaces init` first."
        ),
        "up_to_date" => println!("Routines are up to date."),
        _ => {
            let changed = result.routines_added.len()
                + result.routines_modified.len()
                + result.routines_deleted.len();
            println!(
                "Pulled {changed} routine change(s): +{} ~{} -{}",
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
        }
    }
}

// ── status ───────────────────────────────────────────────────────────────────────────────────

fn run_status(workspace_arg: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let ctx = resolve_routines_context(workspace_arg, server_url)?;
    if !ctx.bare_repo.exists() {
        anyhow::bail!(
            "No workbook config repo found locally. Run `scratchmd workspaces init` first."
        );
    }
    // Read-only: no workspace lock (a concurrent fetch only updates remote-tracking refs).
    let result = collect_routines_status(&ctx)?;
    emit_status(&result, json);
    Ok(())
}

fn collect_routines_status(ctx: &RoutinesContext) -> anyhow::Result<RoutinesStatusResult> {
    let mut result = RoutinesStatusResult::default();

    git_ops::fetch_origin(&ctx.bare_repo, &ctx.token)?;

    let local_head = rev_parse_optional_to_string(&ctx.bare_repo, MAIN_REF)?;
    let remote_head = rev_parse_optional_to_string(&ctx.bare_repo, ORIGIN_MAIN_REF)?;
    result.local_head = local_head.clone();
    result.remote_head = remote_head.clone();

    for (status, path) in git_ops::worktree_status_porcelain(&ctx.worktree, ROUTINES_DIR_PREFIX)? {
        result
            .local_changes
            .push(RoutineFileChange { status, path });
    }

    if let (Some(local), Some(remote)) = (local_head.as_deref(), remote_head.as_deref()) {
        if local != remote {
            for (status, path) in git_ops::diff_name_status(&ctx.bare_repo, local, remote)? {
                if path.starts_with(ROUTINES_DIR_PREFIX) {
                    result
                        .remote_changes
                        .push(RoutineFileChange { status, path });
                }
            }
        }
    }

    result.clean = result.local_changes.is_empty() && result.remote_changes.is_empty();
    result.behind = !result.remote_changes.is_empty();
    Ok(result)
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
        println!("Local routine edits (not yet pushed):");
        for change in &result.local_changes {
            println!("  {:<8} {}", change.status, change.path);
        }
    }
    if !result.remote_changes.is_empty() {
        println!("Server routine changes (not yet pulled — run `scratchmd routines pull`):");
        for change in &result.remote_changes {
            println!("  {:<8} {}", change.status, change.path);
        }
    }
}

// ── push ─────────────────────────────────────────────────────────────────────────────────────

async fn run_push(workspace_arg: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let ctx = resolve_routines_context(workspace_arg, server_url)?;
    if !ctx.bare_repo.exists() {
        anyhow::bail!(
            "No workbook config repo found locally. Run `scratchmd workspaces init` first."
        );
    }
    let _lock = crate::config::workspace_lock::acquire(&ctx.workspace_dir)?;
    let result = push_routines(&ctx).await?;
    emit_push(&result, json);
    Ok(())
}

/// Diffs the local routine worktree, validates each upsert, and pushes the change set to the
/// server. On success, converges the local repo to the server's new head; on a stale-base
/// conflict, bails with an actionable "pull first" message.
async fn push_routines(ctx: &RoutinesContext) -> anyhow::Result<RoutinesPushResult> {
    let mut result = RoutinesPushResult::default();

    git_ops::fetch_origin(&ctx.bare_repo, &ctx.token)?;

    // Build the change set from the worktree (vs HEAD), scoped to routines/.
    let mut upserts = Vec::new();
    let mut deletes = Vec::new();
    for (status, path) in git_ops::worktree_status_porcelain(&ctx.worktree, ROUTINES_DIR_PREFIX)? {
        if status == "deleted" {
            deletes.push(path);
        } else {
            let content = std::fs::read_to_string(ctx.worktree.join(&path))
                .with_context(|| format!("failed to read routine file {path}"))?;
            // Light structural check for fast local feedback; the server is authoritative.
            validate_routine_yaml(&path, &content)?;
            upserts.push(RoutineUpsert { path, content });
        }
    }

    if upserts.is_empty() && deletes.is_empty() {
        result.status = "no_changes".to_string();
        return Ok(result);
    }

    result.upserts = upserts.iter().map(|upsert| upsert.path.clone()).collect();
    result.deletes = deletes.clone();

    let base_head = rev_parse_optional_to_string(&ctx.bare_repo, MAIN_REF)?;
    let client = ApiClient::from_credentials(&ctx.server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;
    let request = RoutinesPushRequest {
        upserts,
        deletes,
        base_head,
    };

    match client.routines_push(&ctx.workbook_id, &request).await? {
        RoutinesPushOutcome::Pushed(response) => {
            // Converge the local repo to the server's new head so the worktree is clean afterward.
            if !response.head.is_empty() {
                git_ops::fetch_origin(&ctx.bare_repo, &ctx.token)?;
                git_ops::setup_sparse_worktree(&ctx.bare_repo, &ctx.worktree, &response.head)?;
                git_ops::update_ref(&ctx.bare_repo, MAIN_REF, &response.head)?;
                result.head = Some(response.head);
            }
            result.routine_count = response.routines.len();
            result.status = "pushed".to_string();
            Ok(result)
        }
        RoutinesPushOutcome::BlockedStale(stale) => {
            let message = if stale.message.is_empty() {
                format!(
                    "Server routines have advanced (current {}). Run `scratchmd routines pull`, then retry the push.",
                    stale.current_remote_head
                )
            } else {
                stale.message
            };
            anyhow::bail!("{message}")
        }
    }
}

fn emit_push(result: &RoutinesPushResult, json: bool) {
    if json {
        print_json(result);
        return;
    }
    match result.status.as_str() {
        "no_changes" => println!("No local routine changes to push."),
        _ => {
            println!(
                "Pushed routines: {} upsert(s), {} delete(s).",
                result.upserts.len(),
                result.deletes.len(),
            );
            for path in &result.upserts {
                println!("  upsert {path}");
            }
            for path in &result.deletes {
                println!("  delete {path}");
            }
        }
    }
}

// ── validation ───────────────────────────────────────────────────────────────────────────────

/// Light, CLI-side structural validation for fast feedback before a push. The server's
/// RoutineParserService / reference validator remain authoritative (they alone can resolve a
/// workbook's folders/connections), so this only catches the obvious local mistakes.
fn validate_routine_yaml(path: &str, content: &str) -> anyhow::Result<()> {
    if !path.ends_with(".yaml") && !path.ends_with(".yml") {
        anyhow::bail!("{path}: routine files must end with .yaml or .yml");
    }
    let value: serde_yaml::Value =
        serde_yaml::from_str(content).with_context(|| format!("{path}: invalid YAML"))?;
    let mapping = value
        .as_mapping()
        .ok_or_else(|| anyhow::anyhow!("{path}: a routine must be a YAML mapping"))?;

    let has_name = mapping
        .get("name")
        .and_then(|name| name.as_str())
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        anyhow::bail!("{path}: a routine must have a non-empty `name`");
    }

    let has_steps = mapping
        .get("steps")
        .and_then(|steps| steps.as_sequence())
        .map(|steps| !steps.is_empty())
        .unwrap_or(false);
    if !has_steps {
        anyhow::bail!("{path}: a routine must have at least one entry under `steps`");
    }

    Ok(())
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

    #[test]
    fn validate_routine_yaml_accepts_minimal_routine() {
        let yaml = "name: Daily\nsteps:\n  - action: pull\n";
        assert!(validate_routine_yaml("routines/daily.yaml", yaml).is_ok());
    }

    #[test]
    fn validate_routine_yaml_rejects_non_yaml_extension() {
        let err =
            validate_routine_yaml("routines/daily.txt", "name: x\nsteps:\n  - action: pull\n")
                .unwrap_err();
        assert!(err.to_string().contains(".yaml or .yml"));
    }

    #[test]
    fn validate_routine_yaml_rejects_missing_name() {
        let err =
            validate_routine_yaml("routines/daily.yaml", "steps:\n  - action: pull\n").unwrap_err();
        assert!(err.to_string().contains("non-empty `name`"));
    }

    #[test]
    fn validate_routine_yaml_rejects_empty_steps() {
        let err =
            validate_routine_yaml("routines/daily.yaml", "name: Daily\nsteps: []\n").unwrap_err();
        assert!(err.to_string().contains("at least one entry under `steps`"));
    }

    #[test]
    fn validate_routine_yaml_rejects_malformed_yaml() {
        let err = validate_routine_yaml("routines/daily.yaml", "name: : :\n\t- bad").unwrap_err();
        assert!(err.to_string().contains("invalid YAML"));
    }
}
