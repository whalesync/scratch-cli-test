//! `scratchmd plan-publish` — build a local publish plan by diffing dirty vs master.
//!
//! This is a thin CLI wrapper around [`crate::shared::plan_publish::build_publish_plan`].
//! See that module for the core logic, types, and file layout documentation.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::plan_publish::{self, PlanResult};

// ---------------------------------------------------------------------------
// Entry point: build plan for all connectors in a workspace
// ---------------------------------------------------------------------------

pub fn run(workspace_start: &Path, filter: Option<&str>) -> anyhow::Result<()> {
    let workspace = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace)?;
    let layout = WorkspaceLayout::for_cli(&workspace);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace.display()
        );
    }

    let timestamp = plan_publish::now_compact();
    let mut any_changes = false;

    for connection in &workspace_marker.connections {
        let conn_name = connection.dir_name.clone();

        // If a filter is set, determine if it applies to this connection and strip the
        // connection prefix so the shared function receives a connection-relative path.
        let conn_filter: Option<&str> = match filter {
            Some(f) => match f.strip_prefix(&format!("{}/", conn_name)) {
                Some(rest) => Some(rest),
                None => continue, // filter doesn't match this connection, skip it
            },
            None => None,
        };
        let dirty_dir = layout.dirty_checkout_path(&conn_name);
        let master_dir = layout.master_worktree_path(&conn_name);
        let scratch_dir = layout.connection_scratch_path(&conn_name);
        let db_path = layout.index_db_path(&connection.repo_path);
        let bare_repo = layout.bare_repo_path(&connection.repo_path);

        if !dirty_dir.exists() && !bare_repo.exists() {
            eprintln!(
                "  {conn_name}: dirty checkout not found at {}, skipping",
                dirty_dir.display()
            );
            continue;
        }
        if !master_dir.exists() {
            eprintln!(
                "  {conn_name}: master worktree not found at {}, skipping",
                master_dir.display()
            );
            eprintln!("    Run 'scratchmd workspaces init' to set up the master worktree.");
            continue;
        }

        let reviewed_dirty_dir = layout.reviewed_dirty_checkout_path(&conn_name);
        let dirty_source = reviewed_dirty_dir.as_path();

        match plan_publish::build_publish_plan_with_scratch_dir(
            &conn_name,
            &connection.id,
            dirty_source,
            &master_dir,
            &db_path,
            &scratch_dir,
            &timestamp,
            conn_filter,
        ) {
            Ok(Some(result)) => {
                print_report(&conn_name, &result);
                let _ = io::stdout().flush();
                any_changes = true;
            }
            Ok(None) => {
                println!("  {conn_name}: nothing to publish");
                let _ = io::stdout().flush();
            }
            Err(e) => {
                eprintln!("  {conn_name}: planning error: {e}");
            }
        }
    }

    if !any_changes {
        println!("\nNothing to publish — all connections are in sync.");
        let _ = io::stdout().flush();
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// publish-from-git: trigger server-side publish for all connectors with a plan
// ---------------------------------------------------------------------------

pub async fn run_publish_from_git(
    workspace_start: &Path,
    client: &crate::api::ApiClient,
) -> anyhow::Result<()> {
    let workspace = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace)?;
    let layout = WorkspaceLayout::for_cli(&workspace);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!("No connections found. Run 'scratchmd workspaces init' first.");
    }

    let mut any_triggered = false;

    for connection in &workspace_marker.connections {
        let conn_name = connection.dir_name.clone();
        let manifest_dir = layout
            .connection_scratch_path(&conn_name)
            .join(".publish-plans");
        let plan_dir = match std::fs::read_dir(&manifest_dir)
            .ok()
            .and_then(|mut d| d.next())
        {
            Some(Ok(e)) if e.path().is_dir() => e.path(),
            _ => {
                eprintln!(
                    "  {conn_name}: no publish plan found — run 'scratchmd plan-publish' first"
                );
                continue;
            }
        };

        let plan_timestamp = plan_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let plan_path = format!(".scratch/.publish-plans/{}", plan_timestamp);

        match client
            .publish_from_git(&workspace_marker.workbook.id, &connection.id, &plan_path)
            .await
        {
            Ok(resp) => {
                let job_id = resp
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unknown)");
                println!("  {conn_name}: publish job queued (jobId: {job_id})");
                let _ = io::stdout().flush();
                any_triggered = true;
            }
            Err(e) => {
                eprintln!("  {conn_name}: failed to trigger publish: {e}");
            }
        }
    }

    if !any_triggered {
        println!("No publish jobs triggered.");
        let _ = io::stdout().flush();
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// CLI output
// ---------------------------------------------------------------------------

fn print_report(conn_name: &str, result: &PlanResult) {
    println!("  {conn_name}");
    for fr in &result.folder_reports {
        let label = if fr.folder.is_empty() {
            "(root)".to_string()
        } else {
            fr.folder.clone()
        };

        let mut raw_parts = vec![];
        if fr.raw_modified > 0 {
            raw_parts.push(format!("{} modified", fr.raw_modified));
        }
        if fr.raw_added > 0 {
            raw_parts.push(format!("{} added", fr.raw_added));
        }
        if fr.raw_deleted > 0 {
            raw_parts.push(format!("{} deleted", fr.raw_deleted));
        }
        if fr.raw_ref_clear > 0 {
            raw_parts.push(format!("{} ref-clear", fr.raw_ref_clear));
        }

        let mut plan_parts = vec![];
        if fr.plan_edit > 0 {
            plan_parts.push(format!("{} edit", fr.plan_edit));
        }
        if fr.plan_create > 0 {
            plan_parts.push(format!("{} create", fr.plan_create));
        }
        if fr.plan_delete > 0 {
            plan_parts.push(format!("{} delete", fr.plan_delete));
        }
        if fr.plan_backfill > 0 {
            plan_parts.push(format!("{} backfill", fr.plan_backfill));
        }
        if fr.plan_rename > 0 {
            plan_parts.push(format!("{} rename", fr.plan_rename));
        }

        let raw_str = if raw_parts.is_empty() {
            "no changes".to_string()
        } else {
            raw_parts.join(", ")
        };
        let plan_str = if plan_parts.is_empty() {
            "no ops".to_string()
        } else {
            plan_parts.join(", ")
        };

        println!("    {label}  ({raw_str})  →  ({plan_str})");
    }
}

// ---------------------------------------------------------------------------
// Workspace / connector discovery (CLI-specific, uses .scratchmd markers)
// ---------------------------------------------------------------------------

fn resolve_workspace(start: &Path) -> anyhow::Result<PathBuf> {
    let abs = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    Ok(markers::find_nearest_workspace(&abs).unwrap_or(abs))
}

fn read_workspace_marker(workspace: &Path) -> anyhow::Result<markers::WorkspaceMarker> {
    let marker_path = markers::marker_path(workspace);
    match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(marker)) => Ok(marker),
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
#[path = "tests/plan_publish.rs"]
mod tests;
