use std::collections::HashMap;

use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

use scratch_core::types::{FileChange, FileChangeStatus};
use scratch_publish::plan_builder::build_publish_plan;

/// Publish changes.
///
/// - `--dry-run`: loads local files and builds the publish plan in-memory, printing a summary.
/// - Otherwise: calls the API to run the publish operation remotely.
pub async fn run(dry_run: bool, api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;

    if dry_run {
        run_local(&root)?;
    } else {
        let api_url = config.effective_api_url(api_url_override);
        let client = ApiClient::new(&api_url);
        run_remote(&client, &config).await?;
    }

    Ok(())
}

/// Build a publish plan locally from workspace files.
fn run_local(workspace_root: &std::path::Path) -> Result<(), String> {
    eprintln!("{}[DRY RUN]{} Building publish plan...", color::yellow(), color::reset());

    // Load schemas
    let schemas = workspace::load_schemas(workspace_root);

    // Try to load the file index from `.scratch/file-index.json`
    let file_index = load_json_string_map(workspace_root, ".scratch/file-index.json");
    let folder_lookup = load_json_string_map(workspace_root, ".scratch/folder-lookup.json");

    // Try to load changes from `.scratch/changes.json`
    let changes_path = workspace_root.join(".scratch/changes.json");
    let changes: Vec<FileChange> = if changes_path.exists() {
        let content = std::fs::read_to_string(&changes_path)
            .map_err(|e| format!("Failed to read changes file: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse changes file: {e}"))?
    } else {
        // No pre-built changes file; scan for JSON files and treat them all as modified
        eprintln!("  No .scratch/changes.json found. Scanning workspace for JSON files...");
        scan_workspace_changes(workspace_root)
    };

    if changes.is_empty() {
        eprintln!("{}[DRY RUN]{} No changes detected.", color::yellow(), color::reset());
        return Ok(());
    }

    // Load file contents for dirty and main branches
    let mut file_contents: HashMap<String, serde_json::Value> = HashMap::new();
    for change in &changes {
        if change.status == FileChangeStatus::Deleted {
            continue;
        }
        let full_path = workspace_root.join(&change.path);
        if let Ok(content) = std::fs::read_to_string(&full_path) {
            if let Ok(value) = serde_json::from_str(&content) {
                file_contents.insert(change.path.clone(), value);
            }
        }
    }

    // For dry run, main contents are empty (we treat everything as new)
    let main_contents: HashMap<String, serde_json::Value> = HashMap::new();

    let plan = build_publish_plan(
        &changes,
        &file_contents,
        &main_contents,
        &schemas,
        &file_index,
        &folder_lookup,
    );

    if plan.operations.is_empty() {
        eprintln!("{}[DRY RUN]{} Publish plan is empty — no operations to perform.", color::yellow(), color::reset());
        return Ok(());
    }

    println!("\n  Publish plan ({} operations):", plan.operations.len());

    for op in &plan.operations {
        let phase_label = format!("{:?}", op.phase);
        let clr = match op.phase {
            scratch_core::types::PublishPhase::Create => color::green(),
            scratch_core::types::PublishPhase::Edit => color::yellow(),
            scratch_core::types::PublishPhase::Delete => color::red(),
            scratch_core::types::PublishPhase::Backfill => color::cyan(),
            scratch_core::types::PublishPhase::RenameFiles => color::magenta(),
        };
        println!("    {clr}{phase_label}{}  {}", color::reset(), op.path);

        if let Some(ref changed) = op.changed_fields {
            if let Some(obj) = changed.as_object() {
                if !obj.is_empty() {
                    let keys: Vec<&String> = obj.keys().collect();
                    println!("      Changed fields: {}", keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "));
                }
            }
        }
    }

    eprintln!("\n{}[DRY RUN]{} No changes were published.", color::yellow(), color::reset());
    Ok(())
}

/// Run publish remotely via the API.
async fn run_remote(client: &ApiClient, config: &WorkspaceConfig) -> Result<(), String> {
    eprintln!("Publishing changes for workbook {}...", config.workbook_id);

    let result = client.run_publish(&config.workbook_id).await?;

    if let Some(job_id) = result.get("jobId").and_then(|v| v.as_str()) {
        eprintln!("  Job started: {job_id}");
        eprintln!("  Polling for completion...");
        let final_result = client.poll_job(job_id).await?;
        print_publish_result(&final_result);
    } else {
        print_publish_result(&result);
    }

    Ok(())
}

fn print_publish_result(result: &serde_json::Value) {
    let status = result
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("completed");

    match status {
        "failed" | "error" => {
            let message = result
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            eprintln!("{}Publish failed: {message}{}", color::red(), color::reset());
        }
        _ => {
            eprintln!("{}Publish completed.{}", color::green(), color::reset());
        }
    }
}

/// Load a JSON file as a `HashMap<String, String>`, returning an empty map on failure.
fn load_json_string_map(
    workspace_root: &std::path::Path,
    relative_path: &str,
) -> HashMap<String, String> {
    let path = workspace_root.join(relative_path);
    if !path.exists() {
        return HashMap::new();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&content).unwrap_or_default()
}

/// Scan the workspace for JSON files and return them as Added changes.
/// This is a fallback when no `.scratch/changes.json` is present.
fn scan_workspace_changes(workspace_root: &std::path::Path) -> Vec<FileChange> {
    let mut changes = Vec::new();

    fn walk_dir(
        dir: &std::path::Path,
        root: &std::path::Path,
        changes: &mut Vec<FileChange>,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Skip .scratch directory
            if path.file_name().and_then(|n| n.to_str()) == Some(".scratch") {
                continue;
            }
            if path.is_dir() {
                walk_dir(&path, root, changes);
            } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                changes.push(FileChange {
                    path: rel,
                    status: FileChangeStatus::Added,
                });
            }
        }
    }

    walk_dir(workspace_root, workspace_root, &mut changes);
    changes
}
