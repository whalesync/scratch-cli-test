use std::path::{Path, PathBuf};
use std::{fs, io};

use serde::{Deserialize, Serialize};

// ── Workspace marker ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceMarker {
    pub version: String,
    pub workbook: WorkbookRef,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkbookRef {
    pub id: String,
    pub name: String,
    #[serde(rename = "serverUrl")]
    pub server_url: String,
    #[serde(rename = "initializedAt")]
    pub initialized_at: String,
}

// ── Connector marker ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectorMarker {
    pub version: String,
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

/// Walk up from `start` to find the nearest .scratchmd file.
/// Returns (marker, directory containing the marker).
pub fn find_nearest(start: &Path) -> Option<(Marker, PathBuf)> {
    let mut dir = start.to_path_buf();
    loop {
        let candidate = dir.join(".scratchmd");
        if candidate.exists() {
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
        let candidate = dir.join(".scratchmd");
        if candidate.exists() {
            if let Ok(Marker::Workspace(_)) = read(&candidate) {
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
    server_url: &str,
) -> io::Result<()> {
    let marker = WorkspaceMarker {
        version: "2".to_string(),
        workbook: WorkbookRef {
            id: workbook_id.to_string(),
            name: workbook_name.to_string(),
            server_url: server_url.to_string(),
            initialized_at: chrono::Utc::now().to_rfc3339(),
        },
    };
    let content = serde_yaml::to_string(&marker)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    fs::write(dir.join(".scratchmd"), content)
}

pub fn write_connector(
    dir: &Path,
    workbook_id: &str,
    workbook_name: &str,
    connector_id: &str,
    display_name: &str,
    service: &str,
    repo_path: &str,
) -> io::Result<()> {
    let marker = ConnectorMarker {
        version: "2".to_string(),
        workbook: ConnectorWorkbookRef {
            id: workbook_id.to_string(),
            name: workbook_name.to_string(),
        },
        connector: ConnectorRef {
            id: connector_id.to_string(),
            display_name: display_name.to_string(),
            service: service.to_string(),
            repo_path: repo_path.to_string(),
        },
    };
    let content = serde_yaml::to_string(&marker)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    fs::write(dir.join(".scratchmd"), content)
}

pub fn write_data_folder(dir: &Path, id: &str, name: &str) -> io::Result<()> {
    let marker = DataFolderMarker {
        version: "1".to_string(),
        data_folder: DataFolderRef {
            id: id.to_string(),
            name: name.to_string(),
        },
    };
    let content = serde_yaml::to_string(&marker)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    fs::write(dir.join(".scratchmd"), content)
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

/// Build the connector directory name from service + display name.
/// Format: "<Service> - <DisplayName>" with special chars replaced.
#[allow(dead_code)]
pub fn connector_dir_name(service: &str, display_name: &str) -> String {
    sanitize_filename(&format!("{} - {}", service, display_name))
}
