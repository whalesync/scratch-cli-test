use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

/// Show diff of dirty files by querying the API for git status.
pub async fn run(api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    eprintln!("Fetching diff for workbook {}...", config.workbook_id);

    let result = client.get_changes(&config.workbook_id).await?;

    let changes = result
        .get("changes")
        .and_then(|v| v.as_array());

    match changes {
        Some(files) if !files.is_empty() => {
            println!("\nDirty files ({}):", files.len());
            for file in files {
                let path = file
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let status = file
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("modified");

                let (clr, symbol) = match status {
                    "added" => (color::green(), "+"),
                    "deleted" => (color::red(), "-"),
                    _ => (color::yellow(), "~"),
                };
                println!("  {clr}{symbol} {path}{}", color::reset());
            }
        }
        _ => {
            println!("{}No dirty files.{}", color::green(), color::reset());
        }
    }

    Ok(())
}
