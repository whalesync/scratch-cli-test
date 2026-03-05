use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::api::Client;
use crate::cli::Cli;
use crate::credentials;

/// Build an authenticated API client from CLI context.
pub fn get_authenticated_client(cli: &Cli) -> Result<Client> {
    let server_url = get_server_url(cli);

    if !credentials::is_logged_in(&server_url) {
        bail!("not logged in. Run 'scratchmd auth login' first");
    }

    let creds = credentials::load_credentials(&server_url)?;
    Client::new(&server_url, Some(&creds.api_token), cli.verbose)
}

/// Resolve the scratch server URL from config + CLI flags.
pub fn get_server_url(cli: &Cli) -> String {
    let config = crate::config::load_config(
        &std::env::current_dir().unwrap_or_default(),
        cli.scratch_url.as_deref(),
    );
    if let Ok(cfg) = config {
        return cfg.scratch_server_url().to_string();
    }
    crate::config::DEFAULT_SCRATCH_SERVER_URL.to_string()
}

// --- Marker types ---

#[derive(Deserialize)]
pub struct WorkbookMarker {
    pub workbook: WorkbookMarkerConfig,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct WorkbookMarkerConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize)]
pub struct ConnectorMarker {
    pub workbook: ConnectorWorkbookRef,
}

#[derive(Deserialize)]
pub struct ConnectorWorkbookRef {
    pub id: String,
}

#[derive(Deserialize)]
pub struct DataFolderMarker {
    #[serde(rename = "dataFolder")]
    pub data_folder: DataFolderMarkerConfig,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct DataFolderMarkerConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// Walk upward from `start_dir` looking for a `.scratchmd` marker with a `workbook` key.
pub fn find_workbook_marker_upward(start_dir: &Path) -> Option<WorkbookMarker> {
    let mut dir = start_dir.to_path_buf();
    loop {
        let marker_path = dir.join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            if let Ok(marker) = serde_yaml::from_str::<WorkbookMarker>(&data) {
                if !marker.workbook.id.is_empty() {
                    return Some(marker);
                }
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Walk upward looking for a connector marker.
pub fn find_connector_marker_upward(start_dir: &Path) -> Option<ConnectorMarker> {
    let mut dir = start_dir.to_path_buf();
    loop {
        let marker_path = dir.join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            if let Ok(marker) = serde_yaml::from_str::<ConnectorMarker>(&data) {
                if !marker.workbook.id.is_empty() {
                    // Only return if it's actually a connector marker (has connector key)
                    // We check for the "connector" key in the YAML
                    if data.contains("connector:") {
                        return Some(marker);
                    }
                }
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Walk upward looking for a data folder marker.
pub fn find_data_folder_marker_upward(start_dir: &Path) -> Option<DataFolderMarker> {
    let mut dir = start_dir.to_path_buf();
    loop {
        let marker_path = dir.join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            if let Ok(marker) = serde_yaml::from_str::<DataFolderMarker>(&data) {
                if !marker.data_folder.id.is_empty() {
                    return Some(marker);
                }
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Resolve workbook ID from --workbook flag or .scratchmd marker.
pub fn resolve_workbook_context(workbook_flag: Option<&str>) -> Result<String> {
    if let Some(id) = workbook_flag {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }

    let cwd = std::env::current_dir().context("failed to get current directory")?;

    // Check connector marker first
    if let Some(marker) = find_connector_marker_upward(&cwd) {
        return Ok(marker.workbook.id);
    }

    // Check workbook marker
    if let Some(marker) = find_workbook_marker_upward(&cwd) {
        return Ok(marker.workbook.id);
    }

    bail!("not inside a workbook directory. Use --workbook flag or run from a workbook directory")
}

/// Resolve both workbook ID and data folder ID from args/flags/markers.
pub fn resolve_linked_context(
    workbook_flag: Option<&str>,
    id_arg: Option<&str>,
) -> Result<(String, String)> {
    let data_folder_id = if let Some(id) = id_arg {
        id.to_string()
    } else {
        let cwd = std::env::current_dir().context("failed to get current directory")?;
        match find_data_folder_marker_upward(&cwd) {
            Some(marker) => marker.data_folder.id,
            None => bail!("not inside a linked table directory. Pass a folder ID or run from a data folder directory"),
        }
    };

    let workbook_id = resolve_workbook_context(workbook_flag)?;
    Ok((workbook_id, data_folder_id))
}

/// Poll job progress until complete, failed, or timeout.
pub fn poll_job_until_done(client: &Client, job_id: &str) -> Result<()> {
    let poll_interval = Duration::from_secs(2);
    let timeout = Duration::from_secs(30 * 60);
    let deadline = Instant::now() + timeout;

    loop {
        if Instant::now() > deadline {
            eprintln!();
            bail!("timed out waiting for job {} after {:?}", job_id, timeout);
        }

        let progress = client.get_job_progress(job_id)?;

        match progress.state.as_str() {
            "completed" => {
                eprintln!();
                return Ok(());
            }
            "failed" => {
                eprintln!();
                let reason = progress.failed_reason.unwrap_or_else(|| "unknown".to_string());
                bail!("job failed: {}", reason);
            }
            "canceled" => {
                eprintln!();
                bail!("job was canceled");
            }
            _ => {
                eprint!(".");
                std::io::stderr().flush().ok();
            }
        }

        thread::sleep(poll_interval);
    }
}

/// Output value as pretty JSON to stdout.
pub fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    println!("{}", json);
    Ok(())
}

/// Read a y/N confirmation from stdin. Returns true for "y" or "yes".
pub fn confirm(prompt: &str) -> Result<bool> {
    print!("{}", prompt);
    std::io::stdout().flush()?;

    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;
    let response = input.trim().to_lowercase();
    Ok(response == "y" || response == "yes")
}

/// Find an existing workbook marker in subdirectories of `output_dir`.
pub fn find_existing_workbook_marker(output_dir: &Path, workbook_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(output_dir).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let marker_path = entry.path().join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            if let Ok(marker) = serde_yaml::from_str::<WorkbookMarker>(&data) {
                if marker.workbook.id == workbook_id {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}

/// Sanitize a string for use as a filename.
pub fn sanitize_filename(name: &str) -> String {
    name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    // ---- sanitize_filename ----

    #[test]
    fn sanitize_normal_name() {
        assert_eq!(sanitize_filename("My Workbook"), "My Workbook");
    }

    #[test]
    fn sanitize_special_chars() {
        assert_eq!(
            sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"),
            "a-b-c-d-e-f-g-h-i-j"
        );
    }

    #[test]
    fn sanitize_empty() {
        assert_eq!(sanitize_filename(""), "");
    }

    #[test]
    fn sanitize_service_display_name() {
        assert_eq!(
            sanitize_filename("AIRTABLE - My Base/Table"),
            "AIRTABLE - My Base-Table"
        );
    }

    // ---- Marker parsing (WorkbookMarker) ----

    #[test]
    fn parse_v1_workbook_marker() {
        let yaml = r#"
version: "1"
workbook:
  id: "wb_123"
  name: "Test Workbook"
  serverUrl: "https://api.scratch.md"
  initializedAt: "2026-01-01T00:00:00Z"
"#;
        let marker: WorkbookMarker = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(marker.workbook.id, "wb_123");
        assert_eq!(marker.workbook.name, "Test Workbook");
    }

    #[test]
    fn parse_v2_workbook_marker() {
        let yaml = r#"
version: "2"
workbook:
  id: "wb_456"
  name: "V2 Workbook"
  serverUrl: "http://localhost:3010"
  initializedAt: "2026-03-05T00:00:00Z"
"#;
        let marker: WorkbookMarker = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(marker.workbook.id, "wb_456");
        assert_eq!(marker.workbook.name, "V2 Workbook");
    }

    #[test]
    fn workbook_marker_rejects_missing_id() {
        let yaml = r#"
version: "1"
workbook:
  name: "No ID"
"#;
        // The deserialization may succeed but id would be missing — the caller checks for empty id.
        let result = serde_yaml::from_str::<WorkbookMarker>(yaml);
        // id is required (no default), so this should fail
        assert!(result.is_err());
    }

    // ---- Marker parsing (ConnectorMarker) ----

    #[test]
    fn parse_connector_marker() {
        let yaml = r#"
version: "2"
workbook:
  id: "wb_123"
  name: "My Workbook"
connector:
  id: "conn_456"
  displayName: "My Airtable"
  service: "AIRTABLE"
"#;
        let marker: ConnectorMarker = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(marker.workbook.id, "wb_123");
    }

    #[test]
    fn connector_marker_has_connector_key() {
        let yaml = r#"
version: "2"
workbook:
  id: "wb_123"
connector:
  id: "conn_456"
  displayName: "Test"
  service: "WEBFLOW"
"#;
        assert!(yaml.contains("connector:"));
    }

    #[test]
    fn workbook_marker_does_not_have_connector_key() {
        let yaml = r#"
version: "1"
workbook:
  id: "wb_123"
  name: "My Workbook"
  serverUrl: "http://localhost:3010"
"#;
        assert!(!yaml.contains("connector:"));
    }

    // ---- Marker parsing (DataFolderMarker) ----

    #[test]
    fn parse_data_folder_marker() {
        let yaml = r#"
version: "1"
dataFolder:
  id: "df_789"
  name: "Blog Posts"
"#;
        let marker: DataFolderMarker = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(marker.data_folder.id, "df_789");
        assert_eq!(marker.data_folder.name, "Blog Posts");
    }

    // ---- find_workbook_marker_upward ----

    #[test]
    fn find_workbook_marker_in_current_dir() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(".scratchmd"),
            "workbook:\n  id: \"wb_test\"\n  name: \"Test\"\n",
        )
        .unwrap();
        let marker = find_workbook_marker_upward(dir.path()).unwrap();
        assert_eq!(marker.workbook.id, "wb_test");
    }

    #[test]
    fn find_workbook_marker_in_parent_dir() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(".scratchmd"),
            "workbook:\n  id: \"wb_parent\"\n  name: \"Parent\"\n",
        )
        .unwrap();
        let child = dir.path().join("subdir");
        fs::create_dir(&child).unwrap();
        let marker = find_workbook_marker_upward(&child).unwrap();
        assert_eq!(marker.workbook.id, "wb_parent");
    }

    #[test]
    fn find_workbook_marker_not_found() {
        let dir = tmp_dir();
        assert!(find_workbook_marker_upward(dir.path()).is_none());
    }

    // ---- find_connector_marker_upward ----

    #[test]
    fn find_connector_marker_in_dir() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(".scratchmd"),
            "workbook:\n  id: \"wb_1\"\nconnector:\n  id: \"conn_1\"\n  displayName: \"Test\"\n  service: \"AIRTABLE\"\n",
        )
        .unwrap();
        let marker = find_connector_marker_upward(dir.path()).unwrap();
        assert_eq!(marker.workbook.id, "wb_1");
    }

    #[test]
    fn find_connector_marker_skips_workbook_only() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(".scratchmd"),
            "workbook:\n  id: \"wb_1\"\n  name: \"WB\"\n",
        )
        .unwrap();
        // No "connector:" key, so should not be found as connector marker
        assert!(find_connector_marker_upward(dir.path()).is_none());
    }

    // ---- find_data_folder_marker_upward ----

    #[test]
    fn find_data_folder_marker_in_dir() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(".scratchmd"),
            "dataFolder:\n  id: \"df_1\"\n  name: \"Posts\"\n",
        )
        .unwrap();
        let marker = find_data_folder_marker_upward(dir.path()).unwrap();
        assert_eq!(marker.data_folder.id, "df_1");
    }

    #[test]
    fn find_data_folder_marker_not_found() {
        let dir = tmp_dir();
        assert!(find_data_folder_marker_upward(dir.path()).is_none());
    }

    // ---- find_existing_workbook_marker ----

    #[test]
    fn find_existing_workbook_marker_found() {
        let dir = tmp_dir();
        let wb_dir = dir.path().join("My Workbook");
        fs::create_dir(&wb_dir).unwrap();
        fs::write(
            wb_dir.join(".scratchmd"),
            "workbook:\n  id: \"wb_target\"\n  name: \"Target\"\n",
        )
        .unwrap();
        let result = find_existing_workbook_marker(dir.path(), "wb_target");
        assert!(result.is_some());
        assert_eq!(result.unwrap(), wb_dir);
    }

    #[test]
    fn find_existing_workbook_marker_wrong_id() {
        let dir = tmp_dir();
        let wb_dir = dir.path().join("Other");
        fs::create_dir(&wb_dir).unwrap();
        fs::write(
            wb_dir.join(".scratchmd"),
            "workbook:\n  id: \"wb_other\"\n  name: \"Other\"\n",
        )
        .unwrap();
        assert!(find_existing_workbook_marker(dir.path(), "wb_target").is_none());
    }

    #[test]
    fn find_existing_workbook_marker_empty_dir() {
        let dir = tmp_dir();
        assert!(find_existing_workbook_marker(dir.path(), "wb_1").is_none());
    }

    #[test]
    fn find_existing_workbook_marker_skips_files() {
        let dir = tmp_dir();
        fs::write(dir.path().join("not-a-dir"), "data").unwrap();
        assert!(find_existing_workbook_marker(dir.path(), "wb_1").is_none());
    }

    // ---- resolve_workbook_context ----

    #[test]
    fn resolve_workbook_from_flag() {
        let id = resolve_workbook_context(Some("wb_flag")).unwrap();
        assert_eq!(id, "wb_flag");
    }

    #[test]
    fn resolve_workbook_empty_flag_falls_through() {
        // Empty flag should not resolve — it will fail if no marker exists.
        let result = resolve_workbook_context(Some(""));
        // This will fail because cwd likely has no marker, which is fine.
        assert!(result.is_err());
    }

    // ---- resolve_linked_context ----

    #[test]
    fn resolve_linked_from_args() {
        let (wb, df) = resolve_linked_context(Some("wb_1"), Some("df_1")).unwrap();
        assert_eq!(wb, "wb_1");
        assert_eq!(df, "df_1");
    }
}
