//! `scratchmdv4 delete-publish-plans` — remove publish plan folders.
//!
//! Without --plan-id: deletes ALL plans across all connections.
//! With --plan-id: deletes only that specific plan from all connections.

use std::path::PathBuf;

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: auto-detected)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,

    /// Delete only this specific plan ID (e.g. 20260317-123456). Deletes all if omitted.
    #[arg(long)]
    pub plan_id: Option<String>,
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

    let mut deleted = 0usize;

    for entry in std::fs::read_dir(&connections_dir)? {
        let entry = entry?;
        let conn_scratch_dir = entry.path();
        if !conn_scratch_dir.is_dir() {
            continue;
        }

        let conn_name = conn_scratch_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        let dirty_dir = workspace.join(&conn_name);
        let plans_dir = dirty_dir.join(".scratch/publish-plans");

        if !plans_dir.exists() {
            continue;
        }

        match &args.plan_id {
            Some(id) => {
                let plan_dir = plans_dir.join(id);
                if plan_dir.exists() {
                    std::fs::remove_dir_all(&plan_dir)?;
                    println!("  deleted {}", plan_dir.display());
                    deleted += 1;
                }
            }
            None => {
                for plan_entry in std::fs::read_dir(&plans_dir)? {
                    let plan_entry = plan_entry?;
                    let plan_dir = plan_entry.path();
                    if plan_dir.is_dir() {
                        std::fs::remove_dir_all(&plan_dir)?;
                        println!("  deleted {}", plan_dir.display());
                        deleted += 1;
                    }
                }
            }
        }
    }

    if deleted == 0 {
        println!("No publish plans found.");
    } else {
        println!("\nDeleted {deleted} plan(s).");
    }

    Ok(())
}
