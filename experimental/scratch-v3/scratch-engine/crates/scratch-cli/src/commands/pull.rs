use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

/// Pull changes from remote for the current workspace.
///
/// 1. Triggers a server-side pull job (external service -> server git)
/// 2. Polls until the job completes
/// 3. Downloads all files from server git to local disk
pub async fn run(connection: Option<&str>, api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    eprintln!("Pulling changes for workbook {}...", config.workbook_id);
    if let Some(conn) = connection {
        eprintln!("  Connection: {conn}");
    }

    let result = client.pull(&config.workbook_id, connection).await?;

    // Poll for job completion
    if let Some(job_id) = result.get("jobId").and_then(|v| v.as_str()) {
        eprintln!("  Job started: {job_id}");
        eprintln!("  Polling for completion...");
        let final_result = client.poll_job(job_id).await?;
        let status = final_result
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if status == "failed" || status == "error" {
            let message = final_result
                .get("error")
                .or_else(|| final_result.get("failedReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("Pull failed: {message}"));
        }
    }

    // Download files from server to local disk
    eprintln!("  Downloading files to workspace...");
    let download = client.download_files(&config.workbook_id).await?;
    let files = download
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut written = 0;
    for file in &files {
        let path = file.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let content = file.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            continue;
        }

        // path starts with / — strip it and resolve against workspace root
        let rel = path.trim_start_matches('/');
        let dest = root.join(rel);

        // Create parent directories
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory for {rel}: {e}"))?;
        }

        std::fs::write(&dest, content)
            .map_err(|e| format!("Failed to write {rel}: {e}"))?;
        written += 1;
    }

    println!("  Files: {written}");
    eprintln!(
        "{}Pull completed — {written} file{} written to workspace.{}",
        color::green(),
        if written == 1 { "" } else { "s" },
        color::reset()
    );

    Ok(())
}
