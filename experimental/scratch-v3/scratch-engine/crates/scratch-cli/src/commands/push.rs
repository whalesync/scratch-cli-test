use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;
use serde_json::Value;
use std::path::Path;

/// Push local changes to the Scratch server's git layer.
///
/// Reads JSON files from the workspace, sends them to the server,
/// where they become "dirty" changes visible in the review UI.
pub async fn run(connection: Option<&str>, api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    if let Some(conn) = connection {
        eprintln!("Pushing changes for connection {conn}...");
    } else {
        eprintln!("Pushing local changes to workbook {}...", config.workbook_id);
    }

    // Collect all JSON files from workspace (excluding .scratch/)
    let files = collect_workspace_files(&root)?;

    if files.is_empty() {
        eprintln!(
            "{}No files found in workspace to push.{}",
            color::yellow(),
            color::reset()
        );
        return Ok(());
    }

    eprintln!("  Found {} file{}", files.len(), if files.len() == 1 { "" } else { "s" });

    let result = client
        .push_files(&config.workbook_id, &files)
        .await?;

    let written = result
        .get("written")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let errors = result
        .get("errors")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    println!("  Written: {written}");
    if errors > 0 {
        println!("  Errors: {errors}");
        if let Some(errs) = result.get("errors").and_then(|v| v.as_array()) {
            for e in errs {
                if let Some(msg) = e.as_str() {
                    eprintln!("    {}{}{}",  color::red(), msg, color::reset());
                }
            }
        }
    }

    eprintln!(
        "{}Push completed — {written} file{} sent to server.{}",
        color::green(),
        if written == 1 { "" } else { "s" },
        color::reset()
    );

    Ok(())
}

/// Walk the workspace directory and collect all JSON files as {path, content} values.
/// Skips .scratch/ directory and hidden files.
fn collect_workspace_files(root: &Path) -> Result<Vec<Value>, String> {
    let mut files = Vec::new();
    walk_dir(root, root, &mut files)?;
    Ok(files)
}

fn walk_dir(dir: &Path, root: &Path, files: &mut Vec<Value>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {}: {e}", dir.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();

        // Skip hidden dirs and .scratch
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            walk_dir(&path, root, files)?;
        } else if name.ends_with(".json") {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

            // Build path with leading slash, relative to workspace root
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let normalized = format!("/{rel}");

            files.push(serde_json::json!({
                "path": normalized,
                "content": content,
            }));
        }
    }

    Ok(())
}
