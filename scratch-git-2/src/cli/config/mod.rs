pub mod credentials;
pub mod markers;
pub mod project_config;
pub mod workspace_lock;
pub mod workspaces;

/// Resolve workspace ID from an explicit flag value or the nearest .scratchmd marker.
pub fn resolve_workspace_id(explicit: Option<&str>) -> anyhow::Result<String> {
    if let Some(id) = explicit {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let cwd = std::env::current_dir()?;
    match markers::find_nearest(&cwd) {
        Some((marker, _)) => match marker.workbook_id() {
            Some(id) => Ok(id.to_string()),
            None => anyhow::bail!(
                "Not inside a workspace directory. Use --workspace flag or run from a workspace directory"
            ),
        },
        None => anyhow::bail!(
            "Not inside a workspace directory. Use --workspace flag or run from a workspace directory"
        ),
    }
}

/// Resolve data folder ID from an explicit arg or the nearest .scratchmd marker with a dataFolder key.
pub fn resolve_data_folder_id(explicit: Option<&str>) -> anyhow::Result<String> {
    if let Some(id) = explicit {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let cwd = std::env::current_dir()?;
    match markers::find_nearest(&cwd) {
        Some((markers::Marker::DataFolder(m), _)) => Ok(m.data_folder.id),
        Some(_) => anyhow::bail!(
            "Not inside a linked table directory. Pass a folder ID or run from a data folder directory"
        ),
        None => anyhow::bail!(
            "Not inside a linked table directory. Pass a folder ID or run from a data folder directory"
        ),
    }
}

/// Find the local directory for a workspace by walking up from cwd looking for a .scratchmd
/// workspace marker, then consulting the global registry, then scanning current
/// dir children for a matching workbook ID.
pub fn find_workspace_dir(workbook_id: &str) -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().ok()?;

    // Check if cwd or parents have the marker
    if let Some((markers::Marker::Workspace(m), dir)) = markers::find_nearest(&cwd) {
        if m.workbook.id == workbook_id {
            return Some(dir);
        }
    }

    // Check the global registry at ~/.scratchmd/workspaces.yaml
    if let Some(dir) = workspaces::get(workbook_id) {
        return Some(dir);
    }

    // Scan children of cwd
    let entries = std::fs::read_dir(&cwd).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let marker_path = markers::marker_path(&entry.path());
        let content = std::fs::read_to_string(&marker_path).ok()?;
        let value: serde_yaml::Value = serde_yaml::from_str(&content).ok()?;
        if let Some(wb) = value.get("workbook") {
            if wb.get("id").and_then(|v| v.as_str()) == Some(workbook_id) {
                // Make sure it's a workspace marker (has serverUrl), not a connector marker
                if value.get("connector").is_none() {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}
