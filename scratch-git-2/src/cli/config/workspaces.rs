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
    let canonical = workspace_path
        .canonicalize()
        .unwrap_or_else(|_| workspace_path.to_path_buf());

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
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn upsert_overwrites_existing_workspace_path() {
        let tmp = TempDir::new().unwrap();
        let registry = tmp.path().join("workspaces.yaml");
        let path_one = tmp.path().join("one");
        let path_two = tmp.path().join("two");
        std::fs::create_dir_all(&path_one).unwrap();
        std::fs::create_dir_all(&path_two).unwrap();
        std::fs::create_dir_all(path_one.join(".scratch")).unwrap();
        std::fs::create_dir_all(path_two.join(".scratch")).unwrap();
        std::fs::write(path_one.join(".scratch/.scratchmd"), "").unwrap();
        std::fs::write(path_two.join(".scratch/.scratchmd"), "").unwrap();

        upsert_at(&registry, "wkb_1", &path_one).unwrap();
        upsert_at(&registry, "wkb_1", &path_two).unwrap();

        assert_eq!(
            get_from(&registry, "wkb_1"),
            Some(path_two.canonicalize().unwrap())
        );
    }

    #[test]
    fn get_ignores_missing_or_stale_workspace_paths() {
        let tmp = TempDir::new().unwrap();
        let registry = tmp.path().join("workspaces.yaml");
        let stale_path = tmp.path().join("missing");

        let file = WorkspacesFile {
            version: "1".to_string(),
            workspaces: vec![WorkspaceEntry {
                id: "wkb_1".to_string(),
                path: stale_path.display().to_string(),
            }],
        };
        write_file_at(&registry, &file).unwrap();

        assert_eq!(get_from(&registry, "wkb_1"), None);
    }

    #[test]
    fn remove_deletes_registry_entry_and_returns_path() {
        let tmp = TempDir::new().unwrap();
        let registry = tmp.path().join("workspaces.yaml");
        let path_one = tmp.path().join("one");
        let path_two = tmp.path().join("two");

        let file = WorkspacesFile {
            version: "1".to_string(),
            workspaces: vec![
                WorkspaceEntry {
                    id: "wkb_1".to_string(),
                    path: path_one.display().to_string(),
                },
                WorkspaceEntry {
                    id: "wkb_2".to_string(),
                    path: path_two.display().to_string(),
                },
            ],
        };
        write_file_at(&registry, &file).unwrap();

        let removed = remove_at(&registry, "wkb_1").unwrap();

        assert_eq!(removed, Some(path_one));
        assert_eq!(get_from(&registry, "wkb_1"), None);
        assert_eq!(get_from(&registry, "wkb_2"), None);

        let updated = read_file_at(&registry);
        assert_eq!(updated.workspaces.len(), 1);
        assert_eq!(updated.workspaces[0].id, "wkb_2");
    }
}
