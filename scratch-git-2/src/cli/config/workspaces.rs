use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::markers;

#[derive(Debug, Default, Serialize, Deserialize)]
struct WorkspacesFile {
    pub version: String,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub id: String,
    pub path: String,
}

fn registry_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".scratchmd")
        .join("workspaces.yaml")
}

fn read_file_at(path: &Path) -> WorkspacesFile {
    if !path.exists() {
        return WorkspacesFile {
            version: "1".to_string(),
            workspaces: vec![],
        };
    }

    let content = fs::read_to_string(path).unwrap_or_default();
    serde_yaml::from_str(&content).unwrap_or_else(|_| WorkspacesFile {
        version: "1".to_string(),
        workspaces: vec![],
    })
}

fn write_file_at(path: &Path, file: &WorkspacesFile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_yaml::to_string(file)?;
    fs::write(path, content)?;
    Ok(())
}

pub fn get(workbook_id: &str) -> Option<PathBuf> {
    let path = registry_path();
    get_from(&path, workbook_id)
}

fn get_from(registry: &Path, workbook_id: &str) -> Option<PathBuf> {
    let file = read_file_at(registry);
    let candidate = file
        .workspaces
        .into_iter()
        .find(|workspace| workspace.id == workbook_id)
        .map(|workspace| PathBuf::from(workspace.path))?;

    if candidate.exists() && markers::marker_path(&candidate).exists() {
        Some(candidate)
    } else {
        None
    }
}

pub fn upsert(workbook_id: &str, workspace_path: &Path) -> anyhow::Result<()> {
    let path = registry_path();
    upsert_at(&path, workbook_id, workspace_path)
}

pub fn remove(workbook_id: &str) -> anyhow::Result<Option<PathBuf>> {
    let path = registry_path();
    remove_at(&path, workbook_id)
}

fn upsert_at(registry: &Path, workbook_id: &str, workspace_path: &Path) -> anyhow::Result<()> {
    // dunce::canonicalize avoids the Windows `\\?\` verbatim prefix so the
    // registered path stays usable by Git-for-Windows on later commands.
    let canonical =
        dunce::canonicalize(workspace_path).unwrap_or_else(|_| workspace_path.to_path_buf());

    let mut file = read_file_at(registry);
    file.version = "1".to_string();

    if let Some(existing) = file
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workbook_id)
    {
        existing.path = canonical.display().to_string();
    } else {
        file.workspaces.push(WorkspaceEntry {
            id: workbook_id.to_string(),
            path: canonical.display().to_string(),
        });
    }

    file.workspaces.sort_by(|a, b| a.id.cmp(&b.id));
    write_file_at(registry, &file)
}

fn remove_at(registry: &Path, workbook_id: &str) -> anyhow::Result<Option<PathBuf>> {
    let mut file = read_file_at(registry);
    let removed = file
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workbook_id)
        .map(|workspace| PathBuf::from(&workspace.path));

    file.workspaces
        .retain(|workspace| workspace.id != workbook_id);
    file.version = "1".to_string();
    file.workspaces.sort_by(|a, b| a.id.cmp(&b.id));
    write_file_at(registry, &file)?;

    Ok(removed)
}

#[cfg(test)]
#[path = "tests/workspaces.rs"]
mod tests;
