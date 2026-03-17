pub mod generate_docs;
pub mod init_repo;
pub mod pull;
pub mod push;
pub mod rebase_dirty;
pub mod run_sync;
pub mod serve;
pub mod upsert_files;
pub mod validate_sync;
pub mod build_index;
pub mod dump_index;
pub mod plan_publish;
pub mod delete_publish_plans;

use std::path::{Path, PathBuf};
use crate::{Error, Result};

/// Get the current working directory, preferring $PWD (shell-maintained string)
/// over getcwd() (kernel inode reference that breaks after dir deletion/recreation).
pub fn cwd() -> Result<PathBuf> {
    if let Ok(pwd) = std::env::var("PWD") {
        let p = PathBuf::from(pwd);
        if p.is_absolute() && p.exists() {
            return Ok(p);
        }
    }
    std::env::current_dir()
        .map_err(|e| Error::Other(format!("cannot determine current directory: {e}")))
}

/// Resolve a workspace path to absolute.
/// If the path is `.` (the default), walks up the directory tree from cwd
/// looking for a `.scratch/workbook` directory — so you can run commands
/// from anywhere inside a pulled workspace without specifying --workspace.
pub fn resolve_workspace(path: &Path) -> Result<PathBuf> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd()?.join(path)
    };

    // If the path resolves to an explicit non-cwd location, use it directly.
    // If it's the cwd (i.e. --workspace was "." or omitted), try walking up
    // to find the workspace root.
    let current = cwd()?;
    let search_from = if abs == current { current.clone() } else { abs.clone() };

    // Walk up looking for .scratch/workbook
    let mut dir = search_from.clone();
    loop {
        if dir.join(".scratch/workbook").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }

    // Fallback: use the resolved path directly if it exists
    if abs.exists() {
        return Ok(abs);
    }

    Err(Error::Other(format!(
        "could not find a workspace (no .scratch/workbook found) starting from {}",
        search_from.display()
    )))
}
