use std::path::PathBuf;
use std::sync::Arc;


use tokio::net::TcpListener;

use crate::git::RepoBranchLock;
use crate::server::{build_router, AppState};
use crate::Result;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Port to listen on
    #[arg(long, default_value = "3100", env = "SCRATCHMD_PORT")]
    pub port: u16,

    /// Root directory where all repos live
    #[arg(long, env = "SCRATCHMD_REPOS_DIR", default_value = "../../../local/repos-v4")]
    pub repos_dir: PathBuf,
}

pub async fn run(args: Args) -> Result<()> {
    std::fs::create_dir_all(&args.repos_dir)?;
    let repos_dir = args.repos_dir.canonicalize().map_err(|e| {
        crate::Error::Other(format!("repos_dir not found at {}: {e}", args.repos_dir.display()))
    })?;

    let state = AppState {
        repos_dir: repos_dir.clone(),
        lock: Arc::new(RepoBranchLock::new()),
    };

    let router = build_router(state);
    let addr = format!("0.0.0.0:{}", args.port);
    let listener = TcpListener::bind(&addr).await.map_err(crate::Error::Io)?;

    tracing::info!("scratchmd serving on http://{}", addr);
    tracing::info!("  repos dir: {}", repos_dir.display());
    tracing::info!("  git clone: http://{}:{}/git/{{repoPath}}", "localhost", args.port);
    tracing::info!("  init repo: POST http://{}:{}/api/repos/init", "localhost", args.port);
    tracing::info!("  upsert:    POST http://{}:{}/api/repos/upsert-files", "localhost", args.port);

    axum::serve(listener, router)
        .await
        .map_err(crate::Error::Io)?;

    Ok(())
}
