//! `scratchmdv4 dump-index` — print the contents of all connection file indexes.

use std::path::PathBuf;

use rusqlite::Connection;

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: auto-detected)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,

    /// Dump only the named connection (case-sensitive). Dumps all if omitted.
    #[arg(long)]
    pub connection: Option<String>,
}

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;
    let connections_dir = workspace.join(".scratch/connections");

    if !connections_dir.exists() {
        return Err(Error::Other(format!(
            "connections directory not found at {}. Run `scratchmdv4 pull` first.",
            connections_dir.display()
        )));
    }

    for entry in std::fs::read_dir(&connections_dir)? {
        let entry = entry?;
        let conn_dir = entry.path();
        if !conn_dir.is_dir() {
            continue;
        }

        let conn_name = conn_dir.file_name().unwrap_or_default().to_string_lossy().to_string();

        if let Some(filter) = &args.connection {
            if &conn_name != filter {
                continue;
            }
        }

        let db_path = conn_dir.join("index.db");
        if !db_path.exists() {
            println!("[{conn_name}] no index.db — run `scratchmdv4 build-index` first");
            continue;
        }

        println!("\n[{conn_name}]");
        println!("{:<50} {:<40} {}", "folder", "filename", "remote_id");
        println!("{}", "-".repeat(100));

        let db = Connection::open(&db_path)
            .map_err(|e| Error::Other(format!("failed to open index.db for {conn_name}: {e}")))?;

        let mut stmt = db
            .prepare("SELECT folder, filename, remote_id FROM file_index ORDER BY folder, filename")
            .map_err(|e| Error::Other(format!("query failed: {e}")))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| Error::Other(format!("query failed: {e}")))?;

        let mut count = 0usize;
        for row in rows {
            let (folder, filename, remote_id) = row.map_err(|e| Error::Other(e.to_string()))?;
            println!(
                "{:<50} {:<40} {}",
                folder,
                filename,
                remote_id.as_deref().unwrap_or("(none)")
            );
            count += 1;
        }
        println!("{count} row(s)");

        // Dump file_references
        let ref_table_exists: bool = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='file_references'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n > 0)
            .unwrap_or(false);

        if ref_table_exists {
            println!("\n  [file_references]");
            println!("  {:<50} {:<40} {:<40} {}", "source_folder", "source_filename", "target_table_id", "target_remote_id");
            println!("  {}", "-".repeat(140));

            let mut ref_stmt = db
                .prepare("SELECT source_folder, source_filename, target_table_id, target_remote_id FROM file_references ORDER BY source_folder, source_filename")
                .map_err(|e| Error::Other(format!("query failed: {e}")))?;

            let ref_rows = ref_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| Error::Other(format!("query failed: {e}")))?;

            let mut ref_count = 0usize;
            for row in ref_rows {
                let (src_folder, src_file, target_table, target_id) = row.map_err(|e| Error::Other(e.to_string()))?;
                println!("  {:<50} {:<40} {:<40} {}", src_folder, src_file, target_table, target_id);
                ref_count += 1;
            }
            println!("  {ref_count} reference(s)");
        }
    }

    Ok(())
}
