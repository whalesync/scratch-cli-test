use std::path::{Path, PathBuf};
use std::{fs, io};

use serde::{Deserialize, Serialize};

// ── Workspace marker ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceMarker {
    pub version: String,
    pub workbook: WorkbookRef,
    #[serde(default)]
    pub connections: Vec<ConnectionEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkbookRef {
    pub id: String,
    pub name: String,
    #[serde(rename = "orgId", default)]
    pub org_id: String,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "initializedAt")]
    pub initialized_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionEntry {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub service: String,
    #[serde(rename = "repoPath", default)]
    pub repo_path: String,
    #[serde(rename = "dirName", default)]
    pub dir_name: String,
}

// ── Connector marker ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectorMarker {
    pub version: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub detached: bool,
    pub workbook: ConnectorWorkbookRef,
    pub connector: ConnectorRef,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectorWorkbookRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectorRef {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub service: String,
    #[serde(rename = "repoPath", skip_serializing_if = "String::is_empty", default)]
    pub repo_path: String,
}

// ── Data-folder marker ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct DataFolderMarker {
    pub version: String,
    #[serde(rename = "dataFolder")]
    pub data_folder: DataFolderRef,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DataFolderRef {
    pub id: String,
    pub name: String,
}

// ── Unified marker type ─────────────────────────────────────────────────────

#[derive(Debug)]
pub enum Marker {
    Workspace(WorkspaceMarker),
    Connector(ConnectorMarker),
    DataFolder(DataFolderMarker),
}

impl Marker {
    pub fn workbook_id(&self) -> Option<&str> {
        match self {
            Marker::Workspace(m) => Some(&m.workbook.id),
            Marker::Connector(m) => Some(&m.workbook.id),
            Marker::DataFolder(_) => None,
        }
    }

    #[allow(dead_code)]
    pub fn server_url(&self) -> Option<&str> {
        match self {
            Marker::Workspace(m) => Some(&m.workbook.server_url),
            _ => None,
        }
    }
}

// ── Read ────────────────────────────────────────────────────────────────────

/// Parse a .scratchmd file and return the appropriate marker type.
pub fn read(path: &Path) -> anyhow::Result<Marker> {
    let content = fs::read_to_string(path)?;
    // Detect type by presence of keys
    let value: serde_yaml::Value = serde_yaml::from_str(&content)?;
    if value.get("dataFolder").is_some() {
        let m: DataFolderMarker = serde_yaml::from_str(&content)?;
        return Ok(Marker::DataFolder(m));
    }
    if value.get("connector").is_some() {
        let m: ConnectorMarker = serde_yaml::from_str(&content)?;
        return Ok(Marker::Connector(m));
    }
    let m: WorkspaceMarker = serde_yaml::from_str(&content)?;
    Ok(Marker::Workspace(m))
}

pub fn marker_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(".scratch").join(".scratchmd")
}

fn find_marker_in(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join(".scratchmd");
    if direct.exists() {
        return Some(direct);
    }

    let nested = marker_path(dir);
    if nested.exists() {
        return Some(nested);
    }

    None
}

/// Walk up from `start` to find the nearest .scratchmd file.
/// Returns (marker, directory containing the marker).
pub fn find_nearest(start: &Path) -> Option<(Marker, PathBuf)> {
    let mut dir = start.to_path_buf();
    loop {
        if let Some(candidate) = find_marker_in(&dir) {
            if let Ok(m) = read(&candidate) {
                return Some((m, dir));
            }
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return None,
        }
    }
}

/// Walk up from `start` to find the nearest workspace (not connector) .scratchmd.
/// Returns the workspace root directory.
pub fn find_nearest_workspace(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if let Some(candidate) = find_marker_in(&dir) {
            if let Ok(Marker::Workspace(_)) = read(&candidate) {
                // Canonical marker path is `<workspace>/.scratch/.scratchmd`. `find_marker_in` also
                // matches that file as `<workspace>/.scratch` + `.scratchmd` (the "direct" branch).
                // In that case `dir` is the `.scratch` folder — the workspace root is its parent.
                if dir.file_name().is_some_and(|n| n == ".scratch") {
                    return dir.parent().map(|p| p.to_path_buf());
                }
                return Some(dir);
            }
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return None,
        }
    }
}

// ── Write ───────────────────────────────────────────────────────────────────

pub fn write_workspace(
    dir: &Path,
    workbook_id: &str,
    workbook_name: &str,
    org_id: &str,
    server_url: &str,
    connections: &[ConnectionEntry],
) -> io::Result<()> {
    fs::create_dir_all(dir.join(".scratch"))?;
    let marker = WorkspaceMarker {
        version: "3".to_string(),
        workbook: WorkbookRef {
            id: workbook_id.to_string(),
            name: workbook_name.to_string(),
            org_id: org_id.to_string(),
            server_url: server_url.to_string(),
            initialized_at: chrono::Utc::now().to_rfc3339(),
        },
        connections: connections.to_vec(),
    };
    let content =
        serde_yaml::to_string(&marker).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    fs::write(marker_path(dir), content)
}

/// Rewrite the connections list in an existing workspace marker, preserving all other fields.
pub fn rewrite_connections(dir: &Path, connections: &[ConnectionEntry]) -> io::Result<()> {
    let path = marker_path(dir);
    let content = fs::read_to_string(&path)?;
    let mut marker: WorkspaceMarker = serde_yaml::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    marker.connections = connections.to_vec();
    let new_content =
        serde_yaml::to_string(&marker).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    fs::write(&path, new_content)
}

/// Sanitize a string for use as a filesystem directory name.
/// Mirrors Go CLI's sanitizeFilename: replaces / \ : * ? " < > | with -.
pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .collect()
}

/// Build the connector directory name from the connector account's display name.
#[allow(dead_code)]
pub fn connector_dir_name(display_name: &str) -> String {
    sanitize_filename(display_name)
}

/// Legacy "<Service> - <DisplayName>" pattern. Used to keep older workspaces
/// internally consistent when adding new connections; not used for fresh inits.
pub fn connector_dir_name_legacy(service: &str, display_name: &str) -> String {
    sanitize_filename(&format!("{} - {}", service, display_name))
}

/// Detects whether an existing workspace was initialized with the legacy
/// "<Service> - <DisplayName>" connector folder pattern. New connections added
/// to such a workspace should keep using the legacy pattern so the layout on
/// disk stays consistent.
pub fn workspace_uses_legacy_naming(connections: &[ConnectionEntry]) -> bool {
    connections.iter().any(|c| {
        let legacy = connector_dir_name_legacy(&c.service, &c.display_name);
        let current = connector_dir_name(&c.display_name);
        c.dir_name == legacy && legacy != current
    })
}

#[cfg(test)]
#[path = "tests/markers.rs"]
mod tests;
