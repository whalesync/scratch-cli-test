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

/// Add a new connection.
pub async fn add(
    service: &str,
    params: &[(String, String)],
    api_url_override: Option<&str>,
) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);

    let mut credentials = serde_json::Map::new();
    for (k, v) in params {
        credentials.insert(k.clone(), serde_json::Value::String(v.clone()));
    }

    let result = client
        .create_connection(
            &config.workbook_id,
            service,
            &serde_json::Value::Object(credentials),
            None,
        )
        .await?;

    let id = result.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    println!("{}Connection created.{}", color::green(), color::reset());
    println!("  ID:      {id}");
    println!("  Service: {service}");

    Ok(())
}

/// List connections.
pub async fn list(api_url_override: Option<&str>) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);

    let result = client.list_connections(&config.workbook_id).await?;
    let connections = result
        .get("connections")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if connections.is_empty() {
        println!("No connections found.");
        return Ok(());
    }

    println!("{:<20} {:<15} {}", "ID", "SERVICE", "NAME");
    for c in &connections {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let svc = c.get("service").and_then(|v| v.as_str()).unwrap_or("");
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        println!("{:<20} {:<15} {}", id, svc, name);
    }

    Ok(())
}

/// Remove a connection.
pub async fn remove(conn_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);
    client
        .delete_connection(&config.workbook_id, conn_id)
        .await?;
    println!(
        "{}Connection {conn_id} removed.{}",
        color::green(),
        color::reset()
    );
    Ok(())
}

/// Test a connection.
pub async fn test(conn_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);
    client
        .test_connection(&config.workbook_id, conn_id)
        .await?;
    println!(
        "{}Connection OK.{}",
        color::green(),
        color::reset()
    );
    Ok(())
}

/// Discover remote tables for a connection.
pub async fn tables(conn_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let (config, api_url) = load_config(api_url_override)?;
    let client = ApiClient::new(&api_url);

    let result = client
        .discover_tables(&config.workbook_id, conn_id)
        .await?;
    let tables = result
        .get("tables")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if tables.is_empty() {
        println!("No tables found.");
        return Ok(());
    }

    println!("{:<40} {}", "NAME", "REMOTE ID");
    for t in &tables {
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let remote_id = t.get("remoteId").unwrap_or(&serde_json::Value::Null);
        println!("{:<40} {}", name, remote_id);
    }

    Ok(())
}
