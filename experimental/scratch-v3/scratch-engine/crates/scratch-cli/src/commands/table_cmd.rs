use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

fn load_config(api_url_override: Option<&str>) -> Result<(WorkspaceConfig, String), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    Ok((config, api_url))
}

/// List linked tables (data folders).
pub async fn list(api_url_override: Option<&str>) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);

    let result = client.list_folders(&config.workbook_id).await?;
    let folders = result
        .get("folders")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if folders.is_empty() {
        println!("No linked tables found.");
        return Ok(());
    }

    println!("{:<20} {:<30} {}", "ID", "PATH", "SERVICE");
    for f in &folders {
        let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let path = f.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let svc = f.get("connectorService").and_then(|v| v.as_str()).unwrap_or("");
        println!("{:<20} {:<30} {}", id, path, svc);
    }

    Ok(())
}

/// Link a table from a connection.
pub async fn add(
    conn_id: &str,
    table_name: &str,
    api_url_override: Option<&str>,
) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);

    // Discover tables to find the matching one by name
    let discover_result = client
        .discover_tables(&config.workbook_id, conn_id)
        .await?;
    let tables = discover_result
        .get("tables")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let matching = tables.iter().find(|t| {
        t.get("name")
            .and_then(|v| v.as_str())
            .map(|n| n.eq_ignore_ascii_case(table_name) || n.ends_with(&format!(" / {table_name}")))
            .unwrap_or(false)
    });

    let table = match matching {
        Some(t) => t.clone(),
        None => {
            // Fall back to using the name directly as the remote ID
            serde_json::json!({"remoteId": [table_name], "name": table_name})
        }
    };

    let result = client
        .link_tables(
            &config.workbook_id,
            conn_id,
            &[table],
        )
        .await?;

    let folders = result
        .get("folders")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if let Some(folder) = folders.first() {
        let id = folder.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let path = folder.get("path").and_then(|v| v.as_str()).unwrap_or("");
        println!("{}Table linked.{}", color::green(), color::reset());
        println!("  Folder ID: {id}");
        println!("  Path:      {path}");
    } else {
        println!("{}Table linked.{}", color::green(), color::reset());
    }

    Ok(())
}

/// Unlink a table (remove data folder).
pub async fn remove(folder_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);
    client
        .unlink_folder(&config.workbook_id, folder_id)
        .await?;
    println!(
        "{}Folder {folder_id} removed.{}",
        color::green(),
        color::reset()
    );
    Ok(())
}
