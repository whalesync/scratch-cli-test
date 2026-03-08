use crate::api_client::ApiClient;
use crate::color;

/// Create a new workspace.
pub async fn create(name: &str, api_url: &str) -> Result<(), String> {
    let client = ApiClient::new(api_url);
    let result = client.create_workspace(name).await?;

    let id = result.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    println!("{}Workspace created.{}", color::green(), color::reset());
    println!("  ID:   {id}");
    println!("  Name: {name}");

    Ok(())
}

/// List all workspaces.
pub async fn list(api_url: &str) -> Result<(), String> {
    let client = ApiClient::new(api_url);
    let result = client.list_workspaces().await?;

    let workspaces = result
        .get("workspaces")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if workspaces.is_empty() {
        println!("No workspaces found.");
        return Ok(());
    }

    println!("{:<20} {}", "ID", "NAME");
    for ws in &workspaces {
        let id = ws.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = ws.get("name").and_then(|v| v.as_str()).unwrap_or("");
        println!("{:<20} {}", id, name);
    }

    Ok(())
}

/// Delete a workspace.
pub async fn delete(workspace_id: &str, api_url: &str) -> Result<(), String> {
    let client = ApiClient::new(api_url);
    client.delete_workspace(workspace_id).await?;
    println!(
        "{}Workspace {workspace_id} deleted.{}",
        color::green(),
        color::reset()
    );
    Ok(())
}
