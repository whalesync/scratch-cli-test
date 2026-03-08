use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

/// Show workspace status — configuration, connection info, and workbook state.
pub async fn run(api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);

    println!("Scratch Workspace Status");
    println!("========================");
    println!("  Workspace root: {}", root.display());
    println!("  Workbook ID:    {}", config.workbook_id);
    println!("  Org ID:         {}", config.org_id);
    println!("  API URL:        {api_url}");

    // Load schemas
    let schemas = workspace::load_schemas(&root);
    println!("  Schemas:        {}", schemas.len());
    for name in schemas.keys() {
        println!("    - {name}");
    }

    // Check API connectivity
    eprintln!("\nChecking API connectivity...");
    let client = ApiClient::new(&api_url);
    match client.get_status(&config.workbook_id).await {
        Ok(result) => {
            println!("  {}Connected.{}", color::green(), color::reset());

            // Print any useful status fields from the response
            if let Some(name) = result.get("name").and_then(|v| v.as_str()) {
                println!("  Workbook name:  {name}");
            }
            if let Some(connections) = result.get("connections").and_then(|v| v.as_array()) {
                println!("  Connections:    {}", connections.len());
                for conn in connections {
                    let conn_name = conn
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unnamed");
                    let conn_id = conn
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?");
                    println!("    - {conn_name} ({conn_id})");
                }
            }
            if let Some(dirty) = result.get("hasDirty").and_then(|v| v.as_bool()) {
                if dirty {
                    println!("  {}Workbook has uncommitted changes.{}", color::yellow(), color::reset());
                } else {
                    println!("  {}Workbook is clean.{}", color::green(), color::reset());
                }
            }
        }
        Err(e) => {
            eprintln!("  {}Failed to connect: {e}{}", color::red(), color::reset());
            eprintln!("  (Is the API server running at {api_url}?)");
        }
    }

    Ok(())
}
