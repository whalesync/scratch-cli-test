use crate::api_client::ApiClient;
use crate::color;
use crate::config::WorkspaceConfig;
use crate::workspace;

use scratch_core::types::{SyncMapping, SyncPhase};
use scratch_sync::context::SyncContext;
use scratch_sync::engine::sync_table_mapping;
use scratch_transform::TransformerRegistry;

/// Run a sync mapping.
///
/// - `--dry-run`: reads records locally, runs the sync engine in-memory, and prints the plan.
/// - `--preview`: shows the transformed records that would be written.
/// - Neither: calls the API to run the sync remotely.
pub async fn run(
    mapping_id: &str,
    dry_run: bool,
    preview: bool,
    api_url_override: Option<&str>,
) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;

    if dry_run || preview {
        run_local(&root, mapping_id, preview)?;
    } else {
        let api_url = config.effective_api_url(api_url_override);
        let client = ApiClient::new(&api_url);
        run_remote(&client, &config, mapping_id).await?;
    }

    Ok(())
}

/// Run sync locally using the engine crate (for dry-run / preview).
fn run_local(
    workspace_root: &std::path::Path,
    mapping_id: &str,
    show_preview: bool,
) -> Result<(), String> {
    eprintln!("{}[DRY RUN]{} Running sync mapping: {mapping_id}", color::yellow(), color::reset());

    // Try to load the mapping config from `.scratch/mappings/{mapping_id}.json`
    let mapping_path = workspace_root
        .join(".scratch/mappings")
        .join(format!("{mapping_id}.json"));

    if !mapping_path.exists() {
        return Err(format!(
            "Mapping config not found: {}",
            mapping_path.display()
        ));
    }

    let mapping_content = std::fs::read_to_string(&mapping_path)
        .map_err(|e| format!("Failed to read mapping config: {e}"))?;
    let mapping: SyncMapping = serde_json::from_str(&mapping_content)
        .map_err(|e| format!("Failed to parse mapping config: {e}"))?;

    let registry = TransformerRegistry::new();
    let schemas = workspace::load_schemas(workspace_root);

    for (i, table_mapping) in mapping.table_mappings.iter().enumerate() {
        println!(
            "\n  Table mapping {}: {} -> {}",
            i + 1,
            table_mapping.source_data_folder_id,
            table_mapping.destination_data_folder_id
        );

        // Load source and destination records
        let src_folder =
            workspace::resolve_folder(workspace_root, &table_mapping.source_data_folder_id);
        let dst_folder =
            workspace::resolve_folder(workspace_root, &table_mapping.destination_data_folder_id);

        let source_records = workspace::load_records(&src_folder, workspace_root);
        let dest_records = workspace::load_records(&dst_folder, workspace_root);

        println!("    Source records: {}", source_records.len());
        println!("    Dest records:   {}", dest_records.len());

        // Look up schemas by folder path
        let src_schema = schemas.get(&table_mapping.source_data_folder_id);
        let dst_schema = schemas.get(&table_mapping.destination_data_folder_id);

        let mut ctx = SyncContext::default();
        let output = sync_table_mapping(
            table_mapping,
            &source_records,
            &dest_records,
            src_schema,
            dst_schema,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        println!("    Created: {}", output.result.created);
        println!("    Updated: {}", output.result.updated);

        if !output.result.errors.is_empty() {
            println!(
                "    {}Errors: {}{}",
                color::red(),
                output.result.errors.len(),
                color::reset()
            );
            for err in &output.result.errors {
                println!("      - [{}] {}", err.source_id, err.error);
            }
        }

        if !output.result.warnings.is_empty() {
            println!(
                "    {}Warnings: {}{}",
                color::yellow(),
                output.result.warnings.len(),
                color::reset()
            );
            for warn in &output.result.warnings {
                println!("      - [{}] {}", warn.source_id, warn.warning);
            }
        }

        if show_preview && !output.files_to_write.is_empty() {
            println!("\n    Transformed records:");
            for fw in &output.files_to_write {
                println!("    --- {} ---", fw.path);
                // Print content indented
                for line in fw.content.lines() {
                    println!("    {line}");
                }
            }
        }

        if !show_preview && !output.files_to_write.is_empty() {
            println!("\n    Files that would be written:");
            for fw in &output.files_to_write {
                let label = if output.result.created_paths.contains(&fw.path) {
                    format!("{}+{}", color::green(), color::reset())
                } else {
                    format!("{}~{}", color::yellow(), color::reset())
                };
                println!("      {label} {}", fw.path);
            }
        }
    }

    eprintln!("\n{}[DRY RUN]{} No changes were written.", color::yellow(), color::reset());
    Ok(())
}

/// Run sync remotely via the API.
async fn run_remote(
    client: &ApiClient,
    config: &WorkspaceConfig,
    mapping_id: &str,
) -> Result<(), String> {
    eprintln!("Running sync mapping: {mapping_id}");

    let result = client.run_sync(&config.workbook_id, mapping_id).await?;

    if let Some(job_id) = result.get("jobId").and_then(|v| v.as_str()) {
        eprintln!("  Job started: {job_id}");
        eprintln!("  Polling for completion...");
        let final_result = client.poll_job(job_id).await?;
        print_sync_result(&final_result);
    } else {
        print_sync_result(&result);
    }

    Ok(())
}

/// Create a new sync via the API.
pub async fn create(
    name: &str,
    config_path: &str,
    api_url_override: Option<&str>,
) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    let content = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read config file: {e}"))?;
    let mut payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config JSON: {e}"))?;

    // Ensure displayName is set
    if payload.get("displayName").is_none() {
        payload["displayName"] = serde_json::Value::String(name.to_string());
    }

    let result = client.create_sync(&config.workbook_id, &payload).await?;
    let id = result.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    println!("{}Sync created.{}", color::green(), color::reset());
    println!("  ID:   {id}");
    println!("  Name: {name}");

    Ok(())
}

/// List all syncs.
pub async fn list(api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    let result = client.list_syncs(&config.workbook_id).await?;
    let syncs = result
        .get("syncs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if syncs.is_empty() {
        println!("No syncs found.");
        return Ok(());
    }

    println!("{:<20} {}", "ID", "NAME");
    for s in &syncs {
        let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("");
        println!("{:<20} {}", id, name);
    }

    Ok(())
}

/// Show a sync's details.
pub async fn show(sync_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    let result = client.get_sync(&config.workbook_id, sync_id).await?;
    let formatted = serde_json::to_string_pretty(&result)
        .map_err(|e| format!("Failed to format JSON: {e}"))?;
    println!("{formatted}");

    Ok(())
}

/// Delete a sync.
pub async fn delete(sync_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    client.delete_sync(&config.workbook_id, sync_id).await?;
    println!(
        "{}Sync {sync_id} deleted.{}",
        color::green(),
        color::reset()
    );
    Ok(())
}

/// Run all syncs.
pub async fn run_all(api_url_override: Option<&str>) -> Result<(), String> {
    let root = workspace::find_workspace_root()
        .ok_or("Not inside a Scratch workspace (no .scratch/ directory found)")?;
    let config = WorkspaceConfig::load(&root)?;
    let api_url = config.effective_api_url(api_url_override);
    let client = ApiClient::new(&api_url);

    let result = client.list_syncs(&config.workbook_id).await?;
    let syncs = result
        .get("syncs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if syncs.is_empty() {
        println!("No syncs to run.");
        return Ok(());
    }

    for s in &syncs {
        let sync_id = match s.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };
        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or(sync_id);
        eprintln!("Running sync: {name} ({sync_id})");
        let result = client.run_sync(&config.workbook_id, sync_id).await?;
        print_sync_result(&result);
    }

    Ok(())
}

fn print_sync_result(result: &serde_json::Value) {
    if let Some(created) = result.get("created").and_then(|v| v.as_u64()) {
        println!("  Created: {created}");
    }
    if let Some(updated) = result.get("updated").and_then(|v| v.as_u64()) {
        println!("  Updated: {updated}");
    }

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
            eprintln!("{}Sync failed: {message}{}", color::red(), color::reset());
        }
        _ => {
            eprintln!("{}Sync completed.{}", color::green(), color::reset());
        }
    }
}
