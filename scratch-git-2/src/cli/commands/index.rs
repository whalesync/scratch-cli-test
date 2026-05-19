//! `scratchmd index` subcommands — operate on the per-folder SQLite tables that
//! power desktop grid pagination, validation, and column refresh.

use std::path::PathBuf;

use crate::config::markers;

pub fn add_column_command(
    workspace_start: &std::path::Path,
    folder: &str,
    column: &str,
    debug: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    crate::shared::folder_index::index_field_with_progress(
        &workspace_dir,
        folder,
        column,
        None,
        debug,
    )
}

pub fn clear_column_command(
    workspace_start: &std::path::Path,
    folder: &str,
    column: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let result =
        crate::shared::folder_index::clear_column_index(&workspace_dir, folder, column, None)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn clear_folder_command(workspace_start: &std::path::Path, folder: &str) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let result = crate::shared::folder_index::clear_folder_index(&workspace_dir, folder, None)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn find_stale_files_command(
    workspace_start: &std::path::Path,
    folder: &str,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let filenames = crate::shared::folder_index::find_stale_files(&workspace_dir, folder, None)?;
    println!("{}", serde_json::to_string(&filenames)?);
    Ok(())
}

pub fn find_column_stale_files_command(
    workspace_start: &std::path::Path,
    folder: &str,
    columns: &[String],
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let filenames = crate::shared::folder_index::find_column_stale_files(
        &workspace_dir,
        folder,
        columns,
        None,
    )?;
    println!("{}", serde_json::to_string(&filenames)?);
    Ok(())
}

pub fn find_stale_command(
    workspace_start: &std::path::Path,
    folder: &str,
    columns: &[String],
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let report = crate::shared::folder_index::find_stale(&workspace_dir, folder, columns, None)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

pub fn rebuild_folder_command(
    workspace_start: &std::path::Path,
    folder: &str,
    debug: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let rows = crate::shared::folder_index::reindex_table(&workspace_dir, folder, None, debug)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({ "rows": rows }))?
    );
    Ok(())
}

pub fn rebuild_all_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    if workspace_marker.connections.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run 'scratchmd workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut total_rows = 0usize;
    let mut total_folders = 0usize;

    for connection in &workspace_marker.connections {
        let conn_dir_name = &connection.dir_name;
        let working_dir = workspace_dir.join(conn_dir_name);
        if !working_dir.exists() {
            eprintln!(
                "  {} — working directory not found, skipping",
                conn_dir_name
            );
            continue;
        }

        let subfolders: Vec<String> = match std::fs::read_dir(&working_dir) {
            Ok(entries) => entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => {
                eprintln!("  {} — could not read directory, skipping", conn_dir_name);
                continue;
            }
        };

        for subfolder in &subfolders {
            let folder = format!("{conn_dir_name}/{subfolder}");
            eprint!("  reindexing {}... ", folder);
            match crate::shared::folder_index::reindex_table(&workspace_dir, &folder, None, false) {
                Ok(rows) => {
                    eprintln!("{rows} rows");
                    total_rows += rows;
                    total_folders += 1;
                }
                Err(e) => {
                    eprintln!("ERROR: {e}");
                }
            }
        }
    }

    eprintln!("\nDone. {total_rows} rows across {total_folders} folder(s).");
    Ok(())
}

pub fn refresh_folder_command(
    workspace_start: &std::path::Path,
    folder: &str,
    validate: bool,
    debug: bool,
) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let result =
        crate::shared::folder_index::refresh_folder(&workspace_dir, folder, validate, debug)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn refresh_files_full_command(
    workspace_start: &std::path::Path,
    folder: &str,
    files: &[String],
    validate: bool,
    debug: bool,
) -> anyhow::Result<()> {
    if files.is_empty() {
        anyhow::bail!("provide at least one --file argument");
    }
    let workspace_dir = resolve_workspace(workspace_start)?;
    crate::shared::folder_index::reindex_files(&workspace_dir, folder, files, None, debug)?;
    if validate {
        crate::shared::folder_index::validate_files(&workspace_dir, folder, files, None, debug)?;
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({ "reindexed": files.len() }))?
    );
    Ok(())
}

pub fn refresh_files_columns_only_command(
    workspace_start: &std::path::Path,
    folder: &str,
    files: &[String],
    debug: bool,
) -> anyhow::Result<()> {
    if files.is_empty() {
        anyhow::bail!("provide at least one --file argument");
    }
    let workspace_dir = resolve_workspace(workspace_start)?;
    crate::shared::folder_index::reindex_files_columns(&workspace_dir, folder, files, None, debug)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({ "reindexed": files.len() }))?
    );
    Ok(())
}

pub(crate) fn resolve_workspace(start: &std::path::Path) -> anyhow::Result<PathBuf> {
    let abs = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    Ok(markers::find_nearest_workspace(&abs).unwrap_or(abs))
}

pub(crate) fn read_workspace_marker(
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
