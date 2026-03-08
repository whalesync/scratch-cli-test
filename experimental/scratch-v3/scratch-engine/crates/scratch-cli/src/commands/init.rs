use crate::color;
use crate::config::WorkspaceConfig;

/// Initialize a new Scratch workspace in the current directory.
///
/// Creates the `.scratch/` directory structure with `config.json` and `schemas/` subdirectory.
pub async fn run(workbook_id: &str, api_url_override: Option<&str>) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|e| format!("Failed to get current directory: {e}"))?;

    let scratch_dir = cwd.join(".scratch");
    if scratch_dir.exists() {
        return Err("Workspace already initialized (.scratch/ directory exists)".to_string());
    }

    // Create directory structure
    let schemas_dir = scratch_dir.join("schemas");
    std::fs::create_dir_all(&schemas_dir)
        .map_err(|e| format!("Failed to create .scratch/schemas/ directory: {e}"))?;

    // Resolve config values
    let api_url = api_url_override
        .map(|s| s.to_string())
        .or_else(|| std::env::var("SCRATCH_API_URL").ok())
        .unwrap_or_else(|| "http://localhost:8000".to_string());

    let org_id = std::env::var("SCRATCH_ORG_ID").unwrap_or_default();

    let config = WorkspaceConfig {
        api_url,
        workbook_id: workbook_id.to_string(),
        org_id,
        auth_token: std::env::var("SCRATCH_AUTH_TOKEN").ok(),
    };
    config.save(&cwd)?;

    println!("{}Workspace initialized.{}", color::green(), color::reset());
    println!("  Workbook ID: {workbook_id}");
    println!("  Config:      .scratch/config.json");
    println!("  Schemas:     .scratch/schemas/");

    Ok(())
}
