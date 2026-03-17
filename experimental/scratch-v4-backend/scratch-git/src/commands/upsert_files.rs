use std::io::{self, BufRead};
use std::path::PathBuf;
use std::sync::Arc;



use crate::git::{self, FileEntry, RepoBranchLock};
use crate::Result;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the bare git repo, e.g. /var/repos/.../repo.git
    #[arg(long)]
    pub repo: PathBuf,

    /// Folder within the repo, e.g. "tableId/records"
    #[arg(long)]
    pub folder: String,

    /// Commit message
    #[arg(long)]
    pub message: String,
}

pub async fn run(args: Args) -> Result<()> {
    // Read ndjson from stdin: one {"path": "...", "content": "..."} per line
    let stdin = io::stdin();
    let mut files: Vec<FileEntry> = Vec::new();

    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: FileEntry = serde_json::from_str(trimmed)?;
        files.push(entry);
    }

    let lock = Arc::new(RepoBranchLock::new());
    let result = tokio::task::spawn_blocking({
        let repo = args.repo.clone();
        let folder = args.folder.clone();
        let message = args.message.clone();
        let lock = lock.clone();
        move || git::upsert_files(&repo, &folder, &message, &files, &lock)
    })
    .await
    .map_err(|e| crate::Error::Other(e.to_string()))??;

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
