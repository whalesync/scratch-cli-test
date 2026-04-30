//! `scratchmd build-index`, `scratchmd dump-index`, `scratchmd list-stale-records`, and
//! `scratchmd refresh-record-index`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::config::markers;
use crate::shared::index;
use crate::shared::layout::WorkspaceLayout;
use crate::shared::record_index::{
    self, RefreshOptions, RefreshSummary, StaleRecord, StatusCandidate,
};
use serde::Serialize;

pub fn build_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut total_indexed = 0usize;
    let mut total_connections = 0usize;

    for connection in &workspace_marker.connections {
        let conn_dir_name = &connection.dir_name;
        let master = layout.master_worktree_path(conn_dir_name);
        let db = layout.index_db_path(&connection.repo_path);

        if !master.exists() {
            eprintln!(
                "  {} — master worktree not found at {}, skipping",
                conn_dir_name,
                master.display()
            );
            eprintln!("    Run 'scratchmd workspaces init' to set up the master worktree.");
            continue;
        }

        // Ensure parent dir for db exists
        if let Some(parent) = db.parent() {
            std::fs::create_dir_all(parent)?;
        }

        print!("  Building index for {}... ", conn_dir_name);
        match index::build(&master, &db) {
            Ok(count) => {
                println!("{count} file(s)");
                total_indexed += count;
                total_connections += 1;
            }
            Err(e) => {
                println!("ERROR: {e}");
            }
        }
    }

    println!("\nDone. Indexed {total_indexed} file(s) across {total_connections} connection(s).");
    Ok(())
}

pub fn dump_command(workspace_start: &std::path::Path, filter: Option<&str>) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);

    if workspace_marker.connections.is_empty() {
        anyhow::bail!("No connections found in {}", workspace_dir.display());
    }

    for connection in &workspace_marker.connections {
        let conn_dir_name = connection.dir_name.clone();

        if let Some(f) = filter {
            if conn_dir_name != f {
                continue;
            }
        }

        let db = layout.index_db_path(&connection.repo_path);

        if !db.exists() {
            println!("[{conn_dir_name}] no index.db — run `scratchmd build-index` first");
            continue;
        }

        println!("\n[{conn_dir_name}]");
        println!("{:<50} {:<40} {}", "folder", "filename", "remote_id");
        println!("{}", "-".repeat(100));

        let rows = index::read_index(&db)?;
        let count = rows.len();
        for row in &rows {
            println!(
                "{:<50} {:<40} {}",
                row.folder,
                row.filename,
                row.remote_id.as_deref().unwrap_or("(none)")
            );
        }
        println!("{count} row(s)");

        let refs = index::read_references(&db)?;
        if !refs.is_empty() {
            println!("\n  [file_references]");
            println!(
                "  {:<50} {:<40} {:<40} {}",
                "source_folder", "source_filename", "target_table_id", "target_remote_id"
            );
            println!("  {}", "-".repeat(140));
            let ref_count = refs.len();
            for r in &refs {
                println!(
                    "  {:<50} {:<40} {:<40} {}",
                    r.source_folder, r.source_filename, r.target_table_id, r.target_remote_id
                );
            }
            println!("  {ref_count} reference(s)");
        }
    }

    Ok(())
}

#[derive(Debug, Serialize)]
struct ConnectionRefreshOutput {
    #[serde(rename = "connectionName")]
    connection_name: String,
    inserted: usize,
    updated: usize,
    deleted: usize,
    unchanged: usize,
    skipped: usize,
    rebuilt: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ConnectionStaleOutput {
    #[serde(rename = "connectionName")]
    connection_name: String,
    stale_records: Vec<StaleRecord>,
    skipped: usize,
    rebuilt: bool,
    error: Option<String>,
}

pub fn list_stale_records_command(
    workspace_start: &std::path::Path,
    connection_filter: Option<&str>,
    input_paths: &[String],
    rebuild: bool,
    json: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let path_filters = selected_paths_by_connection(
        &workspace_dir,
        &workspace_marker,
        connection_filter,
        input_paths,
    )?;

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut results = Vec::new();
    let mut had_error = false;

    for connection in &workspace_marker.connections {
        if let Some(filter) = connection_filter {
            if connection.dir_name != filter {
                continue;
            }
        }

        if connection.repo_path.is_empty() || connection.dir_name.is_empty() {
            continue;
        }

        let dirty_dir = layout.dirty_checkout_path(&connection.dir_name);
        let db_path = layout.index_db_path(&connection.repo_path);

        if !dirty_dir.exists() {
            results.push(ConnectionStaleOutput {
                connection_name: connection.dir_name.clone(),
                stale_records: Vec::new(),
                skipped: 0,
                rebuilt: rebuild,
                error: Some(format!(
                    "dirty worktree not found at {}",
                    dirty_dir.display()
                )),
            });
            had_error = true;
            continue;
        }

        let candidates = build_status_candidates(&dirty_dir)?;
        let selected_paths = path_filters.get(&connection.dir_name);
        match record_index::inspect(
            &dirty_dir,
            &db_path,
            &candidates,
            RefreshOptions { rebuild },
            selected_paths,
        ) {
            Ok(stale_records) => results.push(ConnectionStaleOutput {
                connection_name: connection.dir_name.clone(),
                skipped: count_skipped_candidates(&candidates, selected_paths),
                stale_records,
                rebuilt: rebuild,
                error: None,
            }),
            Err(err) => {
                results.push(ConnectionStaleOutput {
                    connection_name: connection.dir_name.clone(),
                    stale_records: Vec::new(),
                    skipped: 0,
                    rebuilt: rebuild,
                    error: Some(err.to_string()),
                });
                had_error = true;
            }
        }
    }

    if let Some(filter) = connection_filter {
        if results.is_empty() {
            anyhow::bail!(
                "Connection '{}' was not found in {}",
                filter,
                workspace_dir.display()
            );
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&results)?);
    } else {
        print_stale_results(&results);
    }

    if had_error {
        anyhow::bail!("stale record listing failed for one or more connections");
    }

    Ok(())
}

pub fn refresh_record_index_command(
    workspace_start: &std::path::Path,
    connection_filter: Option<&str>,
    input_paths: &[String],
    rebuild: bool,
    json: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let layout = WorkspaceLayout::for_cli(&workspace_dir);
    let path_filters = selected_paths_by_connection(
        &workspace_dir,
        &workspace_marker,
        connection_filter,
        input_paths,
    )?;

    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut results = Vec::new();
    let mut had_error = false;

    for connection in &workspace_marker.connections {
        if let Some(filter) = connection_filter {
            if connection.dir_name != filter {
                continue;
            }
        }

        if connection.repo_path.is_empty() || connection.dir_name.is_empty() {
            continue;
        }

        let dirty_dir = layout.dirty_checkout_path(&connection.dir_name);
        let db_path = layout.index_db_path(&connection.repo_path);

        if !dirty_dir.exists() {
            results.push(ConnectionRefreshOutput {
                connection_name: connection.dir_name.clone(),
                inserted: 0,
                updated: 0,
                deleted: 0,
                unchanged: 0,
                skipped: 0,
                rebuilt: rebuild,
                error: Some(format!(
                    "dirty worktree not found at {}",
                    dirty_dir.display()
                )),
            });
            had_error = true;
            continue;
        }

        let candidates = build_status_candidates(&dirty_dir)?;
        let selected_paths = path_filters.get(&connection.dir_name);

        match record_index::refresh(
            &dirty_dir,
            &db_path,
            &candidates,
            RefreshOptions { rebuild },
            selected_paths,
        ) {
            Ok(summary) => results.push(ConnectionRefreshOutput {
                connection_name: connection.dir_name.clone(),
                inserted: summary.inserted,
                updated: summary.updated,
                deleted: summary.deleted,
                unchanged: summary.unchanged,
                skipped: summary.skipped,
                rebuilt: rebuild,
                error: None,
            }),
            Err(err) => {
                results.push(ConnectionRefreshOutput {
                    connection_name: connection.dir_name.clone(),
                    inserted: 0,
                    updated: 0,
                    deleted: 0,
                    unchanged: 0,
                    skipped: 0,
                    rebuilt: rebuild,
                    error: Some(err.to_string()),
                });
                had_error = true;
            }
        }
    }

    if let Some(filter) = connection_filter {
        if results.is_empty() {
            anyhow::bail!(
                "Connection '{}' was not found in {}",
                filter,
                workspace_dir.display()
            );
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&results)?);
    } else {
        print_refresh_results(&results);
    }

    if had_error {
        anyhow::bail!("record index refresh failed for one or more connections");
    }

    Ok(())
}

fn resolve_workspace(start: &std::path::Path) -> anyhow::Result<PathBuf> {
    let abs = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    Ok(markers::find_nearest_workspace(&abs).unwrap_or(abs))
}

fn read_workspace_marker(
    workspace_dir: &std::path::Path,
) -> anyhow::Result<markers::WorkspaceMarker> {
    let marker_path = markers::marker_path(workspace_dir);
    match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(marker)) => Ok(marker),
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    }
}

fn print_refresh_results(results: &[ConnectionRefreshOutput]) {
    let mut total = RefreshSummary::default();

    for result in results {
        match &result.error {
            Some(error) => {
                println!("[{}] ERROR: {}", result.connection_name, error);
            }
            None => {
                println!(
                    "[{}] inserted={} updated={} deleted={} unchanged={} skipped={}{}",
                    result.connection_name,
                    result.inserted,
                    result.updated,
                    result.deleted,
                    result.unchanged,
                    result.skipped,
                    if result.rebuilt { " rebuilt=true" } else { "" }
                );
                total.inserted += result.inserted;
                total.updated += result.updated;
                total.deleted += result.deleted;
                total.unchanged += result.unchanged;
                total.skipped += result.skipped;
            }
        }
    }

    println!(
        "\nDone. inserted={} updated={} deleted={} unchanged={} skipped={}",
        total.inserted, total.updated, total.deleted, total.unchanged, total.skipped
    );
}

fn print_stale_results(results: &[ConnectionStaleOutput]) {
    let mut total_stale = 0usize;
    let mut total_skipped = 0usize;

    for result in results {
        match &result.error {
            Some(error) => {
                println!("[{}] ERROR: {}", result.connection_name, error);
            }
            None => {
                println!("[{}]", result.connection_name);
                if result.stale_records.is_empty() {
                    println!("  no stale records");
                } else {
                    for record in &result.stale_records {
                        println!("  {}  {}", record.path, record.reasons.join(","));
                    }
                }
                println!(
                    "  stale={} skipped={}{}",
                    result.stale_records.len(),
                    result.skipped,
                    if result.rebuilt { " rebuilt=true" } else { "" }
                );
                total_stale += result.stale_records.len();
                total_skipped += result.skipped;
            }
        }
    }

    println!("\nDone. stale={} skipped={}", total_stale, total_skipped);
}

fn build_status_candidates(dirty_dir: &std::path::Path) -> anyhow::Result<Vec<StatusCandidate>> {
    let status_entries = crate::git_ops::worktree_status_entries(dirty_dir)?;
    Ok(status_entries
        .into_iter()
        .map(|entry| StatusCandidate {
            path: entry.path,
            original_path: entry.original_path,
            is_rename: entry.x == b'R' || entry.y == b'R',
        })
        .collect())
}

fn selected_paths_by_connection(
    workspace_dir: &std::path::Path,
    workspace_marker: &markers::WorkspaceMarker,
    connection_filter: Option<&str>,
    input_paths: &[String],
) -> anyhow::Result<HashMap<String, HashSet<String>>> {
    if input_paths.is_empty() {
        return Ok(HashMap::new());
    }

    let eligible_connections = workspace_marker
        .connections
        .iter()
        .filter(|connection| {
            connection_filter
                .map(|filter| connection.dir_name == filter)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    if eligible_connections.is_empty() {
        return Ok(HashMap::new());
    }

    let mut by_connection: HashMap<String, HashSet<String>> = HashMap::new();
    for input_path in input_paths {
        let (connection_name, rel_path) = resolve_selected_path(
            workspace_dir,
            &eligible_connections,
            connection_filter,
            input_path,
        )?;
        by_connection
            .entry(connection_name)
            .or_default()
            .insert(rel_path);
    }

    Ok(by_connection)
}

fn resolve_selected_path(
    workspace_dir: &std::path::Path,
    eligible_connections: &[&markers::ConnectionEntry],
    connection_filter: Option<&str>,
    input_path: &str,
) -> anyhow::Result<(String, String)> {
    let normalized = normalize_input_path(workspace_dir, input_path)?;

    if let Some(filter) = connection_filter {
        if let Some(rest) = normalized.strip_prefix(&format!("{filter}/")) {
            return Ok((filter.to_string(), rest.to_string()));
        }
        return Ok((filter.to_string(), normalized));
    }

    for connection in eligible_connections {
        let prefix = format!("{}/", connection.dir_name);
        if let Some(rest) = normalized.strip_prefix(&prefix) {
            return Ok((connection.dir_name.clone(), rest.to_string()));
        }
    }

    if eligible_connections.len() == 1 {
        return Ok((
            eligible_connections[0].dir_name.clone(),
            normalized.to_string(),
        ));
    }

    anyhow::bail!(
        "Path '{}' does not identify a connection. Use '<connection-name>/<relative-path>' or pass --connection.",
        input_path
    )
}

fn normalize_input_path(
    workspace_dir: &std::path::Path,
    input_path: &str,
) -> anyhow::Result<String> {
    let input = std::path::Path::new(input_path);
    let path = if input.is_absolute() {
        input.to_path_buf()
    } else {
        workspace_dir.join(input)
    };
    let rel = path.strip_prefix(workspace_dir).map_err(|_| {
        anyhow::anyhow!(
            "Path '{}' is outside workspace {}",
            input_path,
            workspace_dir.display()
        )
    })?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn count_skipped_candidates(
    candidates: &[StatusCandidate],
    selected_paths: Option<&HashSet<String>>,
) -> usize {
    candidates
        .iter()
        .map(|candidate| {
            let original_path = candidate
                .original_path
                .as_deref()
                .map(|value| value.replace('\\', "/"));
            if selected_paths
                .map(|paths| {
                    !(paths.contains(&candidate.path.replace('\\', "/"))
                        || original_path
                            .as_deref()
                            .map(|path| paths.contains(path))
                            .unwrap_or(false))
                })
                .unwrap_or(false)
            {
                return 0usize;
            }
            let mut count = 0usize;
            if !is_record_candidate_path(&candidate.path) {
                count += 1;
            }
            if candidate.is_rename {
                if let Some(original_path) = candidate.original_path.as_deref() {
                    if !is_record_candidate_path(original_path) {
                        count += 1;
                    }
                }
            }
            count
        })
        .sum()
}

fn is_record_candidate_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with(".scratch/") {
        return false;
    }

    let candidate_path = std::path::Path::new(&normalized);
    let Some(file_name) = candidate_path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file_name == "schema.json" || !file_name.ends_with(".json") {
        return false;
    }

    candidate_path
        .components()
        .all(|component| match component {
            std::path::Component::Normal(segment) => {
                let text = segment.to_string_lossy();
                !text.starts_with('.')
            }
            _ => false,
        })
}

#[cfg(test)]
mod tests {
    use super::{
        list_stale_records_command, read_workspace_marker, refresh_record_index_command,
        resolve_selected_path, selected_paths_by_connection,
    };
    use crate::config::markers;
    use crate::shared::record_index;
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;

    fn run_git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {:?} failed", args);
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn refresh_record_index_command_bootstraps_connection_db() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path();
        fs::create_dir_all(workspace.join(".scratch")).unwrap();
        write_file(
            &workspace.join(".scratch/.scratchmd"),
            r#"version: "3"
workbook:
  id: wkb_test
  name: Test
  orgId: org123
  serverUrl: http://localhost
  initializedAt: "2026-01-01T00:00:00Z"
connections:
  - id: conn_1
    displayName: Conn
    service: AIRTABLE
    repoPath: org123/wkb_test/conn_1
    dirName: Conn
"#,
        );

        let dirty_dir = workspace.join("Conn");
        run_git(workspace, &["init", "Conn"]);
        run_git(&dirty_dir, &["checkout", "-b", "dirty"]);
        write_file(&dirty_dir.join("posts/one.json"), "{\"id\":1}");
        write_file(&dirty_dir.join("posts/schema.json"), "{}");
        run_git(&dirty_dir, &["add", "-A"]);
        run_git(
            &dirty_dir,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=scratch@example.com",
                "commit",
                "-m",
                "initial",
            ],
        );

        refresh_record_index_command(workspace, None, &[], false, false).unwrap();

        let marker = read_workspace_marker(workspace).unwrap();
        let repo_path = &marker.connections[0].repo_path;
        let db_path =
            crate::shared::layout::WorkspaceLayout::for_cli(workspace).index_db_path(repo_path);
        let rows = record_index::read_index(&db_path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].folder_path, "posts");
        assert_eq!(rows[0].file_name, "one.json");
    }

    #[test]
    fn list_stale_records_command_uses_same_shared_inspector() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path();
        fs::create_dir_all(workspace.join(".scratch")).unwrap();
        write_file(
            &workspace.join(".scratch/.scratchmd"),
            r#"version: "3"
workbook:
  id: wkb_test
  name: Test
  orgId: org123
  serverUrl: http://localhost
  initializedAt: "2026-01-01T00:00:00Z"
connections:
  - id: conn_1
    displayName: Conn
    service: AIRTABLE
    repoPath: org123/wkb_test/conn_1
    dirName: Conn
"#,
        );

        let dirty_dir = workspace.join("Conn");
        run_git(workspace, &["init", "Conn"]);
        run_git(&dirty_dir, &["checkout", "-b", "dirty"]);
        write_file(&dirty_dir.join("posts/one.json"), "{\"id\":1}");
        run_git(&dirty_dir, &["add", "-A"]);
        run_git(
            &dirty_dir,
            &[
                "-c",
                "user.name=Scratch",
                "-c",
                "user.email=scratch@example.com",
                "commit",
                "-m",
                "initial",
            ],
        );

        refresh_record_index_command(workspace, None, &[], false, false).unwrap();
        write_file(
            &dirty_dir.join("posts/one.json"),
            "{\"id\":1,\"name\":\"updated\"}",
        );

        list_stale_records_command(workspace, None, &[], false, false).unwrap();
    }

    #[test]
    fn selected_paths_allow_single_connection_relative_path() {
        let marker = markers::WorkspaceMarker {
            version: "3".to_string(),
            workbook: markers::WorkbookRef {
                id: "wkb_test".to_string(),
                name: "Test".to_string(),
                org_id: "org123".to_string(),
                server_url: "http://localhost".to_string(),
                initialized_at: "2026-01-01T00:00:00Z".to_string(),
            },
            connections: vec![markers::ConnectionEntry {
                id: "conn_1".to_string(),
                display_name: "Conn".to_string(),
                service: "AIRTABLE".to_string(),
                repo_path: "org123/wkb_test/conn_1".to_string(),
                dir_name: "Conn".to_string(),
            }],
        };

        let by_connection = selected_paths_by_connection(
            std::path::Path::new("/tmp/workspace"),
            &marker,
            None,
            &[String::from("posts/one.json")],
        )
        .unwrap();
        assert!(by_connection["Conn"].contains("posts/one.json"));
    }

    #[test]
    fn selected_paths_strip_connection_prefix() {
        let connection = markers::ConnectionEntry {
            id: "conn_1".to_string(),
            display_name: "Conn".to_string(),
            service: "AIRTABLE".to_string(),
            repo_path: "org123/wkb_test/conn_1".to_string(),
            dir_name: "Conn".to_string(),
        };

        let (connection_name, rel_path) = resolve_selected_path(
            std::path::Path::new("/tmp/workspace"),
            &[&connection],
            None,
            "Conn/posts/one.json",
        )
        .unwrap();
        assert_eq!(connection_name, "Conn");
        assert_eq!(rel_path, "posts/one.json");
    }
}
