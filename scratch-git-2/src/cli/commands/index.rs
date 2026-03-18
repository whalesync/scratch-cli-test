//! `scratchmd2 build-index` and `scratchmd2 dump-index` commands.

use std::path::PathBuf;

use crate::shared::index;

pub fn build_command(workspace_start: &std::path::Path) -> anyhow::Result<()> {
    let workspace_dir = resolve_workspace(workspace_start)?;
    let conn_dirs = find_connector_dirs(&workspace_dir);

    if conn_dirs.is_empty() {
        anyhow::bail!(
            "No connector directories found in {}. Run 'scratchmd2 workspaces init' first.",
            workspace_dir.display()
        );
    }

    let mut total_indexed = 0usize;
    let mut total_connections = 0usize;

    for conn_dir in &conn_dirs {
        let conn_dir_name = conn_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        let master = index::master_dir(&workspace_dir, &conn_dir_name);
        let db = index::db_path(&workspace_dir, &conn_dir_name);

        if !master.exists() {
            eprintln!("  {} — master worktree not found at {}, skipping", conn_dir_name, master.display());
            eprintln!("    Run 'scratchmd2 workspaces init' to set up the master worktree.");
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
    let conn_dirs = find_connector_dirs(&workspace_dir);

    if conn_dirs.is_empty() {
        anyhow::bail!(
            "No connector directories found in {}",
            workspace_dir.display()
        );
    }

    for conn_dir in &conn_dirs {
        let conn_dir_name = conn_dir.file_name().unwrap_or_default().to_string_lossy().to_string();

        if let Some(f) = filter {
            if conn_dir_name != f {
                continue;
            }
        }

        let db = index::db_path(&workspace_dir, &conn_dir_name);

        if !db.exists() {
            println!("[{conn_dir_name}] no index.db — run `scratchmd2 build-index` first");
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
    let abs = start.canonicalize()
        .unwrap_or_else(|_| start.to_path_buf());
    // Walk up looking for workspace marker
    let mut dir = abs.as_path();
    loop {
        let marker = dir.join(".scratchmd");
        if marker.exists() {
            if let Ok(content) = std::fs::read_to_string(&marker) {
                if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                    if value.get("workbook").is_some() && value.get("connector").is_none() {
                        return Ok(dir.to_path_buf());
                    }
                }
            }
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    // Fallback: use the provided path directly
    Ok(abs)
}

/// Find connector subdirectories (V2 workbooks): dirs with a connector .scratchmd marker + .git.
fn find_connector_dirs(wb_dir: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(wb_dir) else { return Vec::new() };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let subdir = entry.path();
        let marker_path = subdir.join(".scratchmd");
        let Ok(content) = std::fs::read_to_string(&marker_path) else { continue };
        let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) else { continue };
        if value.get("connector").is_none() {
            continue;
        }
        if subdir.join(".git").exists() {
            dirs.push(subdir);
        }
    }
    dirs
}
