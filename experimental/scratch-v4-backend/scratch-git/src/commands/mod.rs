pub mod generate_docs;
pub mod init_repo;
pub mod pull;
pub mod push;
pub mod rebase_dirty;
pub mod run_sync;
pub mod serve;
pub mod upsert_files;

use std::path::{Path, PathBuf};
use crate::{Error, Result};

/// Resolve a workspace path to absolute without using canonicalize(),
/// which fails when the directory was deleted and recreated under the shell.
pub fn resolve_workspace(path: &Path) -> Result<PathBuf> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| Error::Other(format!("cannot determine current directory: {e}")))?
            .join(path)
    };
    if !abs.exists() {
        return Err(Error::Other(format!("workspace not found at {}", abs.display())));
    }
    Ok(abs)
}
