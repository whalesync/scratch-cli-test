use std::path::PathBuf;


use serde_json::json;

use crate::{git, Result};

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path where the bare repo will be created, e.g. /var/repos/orgId/workbookId/connId/repo.git
    #[arg(long)]
    pub path: PathBuf,
}

pub async fn run(args: Args) -> Result<()> {
    git::init_repo(&args.path)?;
    println!("{}", json!({ "ok": true, "path": args.path }));
    Ok(())
}
