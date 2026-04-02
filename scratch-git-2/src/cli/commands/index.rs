//! `scratchmd build-index` and `scratchmd dump-index` commands.

use std::path::PathBuf;

use crate::config::markers;
use crate::shared::index;
use crate::shared::layout::WorkspaceLayout;

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
