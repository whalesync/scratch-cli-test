use std::path::PathBuf;
use std::sync::Arc;

use crate::git::{self, RepoBranchLock};
use crate::Result;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the bare git repo, e.g. /var/repos/.../repo.git
    #[arg(long)]
    pub repo: PathBuf,
}

pub async fn run(args: Args) -> Result<()> {
    let lock = Arc::new(RepoBranchLock::new());
    let result = tokio::task::spawn_blocking({
        let repo = args.repo.clone();
        let lock = lock.clone();
        move || git::rebase_dirty(&repo, &lock)
    })
    .await
    .map_err(|e| crate::Error::Other(e.to_string()))??;

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
