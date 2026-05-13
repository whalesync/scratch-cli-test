//! `scratchmd index` subcommands — build, dump, inspect, and reindex the SQLite
//! file index that powers grid pagination and validation lookups.

use std::path::PathBuf;

use crate::config::markers;
use crate::shared::index;
use crate::shared::layout::WorkspaceLayout;

pub fn init_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
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
            println!("[{conn_dir_name}] no index.db — run `scratchmd index init` first");
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
