use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;

use crate::config::Config;
use crate::git::lock::WriteLockManager;

#[derive(Clone)]
pub struct AppState {
    pub repos_dir: PathBuf,
    pub build_version: String,
    /// Map of repo_id → GC start timestamp (millis since epoch)
    pub gc_state: Arc<DashMap<String, i64>>,
    pub write_locks: Arc<WriteLockManager>,
}

impl AppState {
    pub fn new(config: &Config) -> Self {
        Self {
            repos_dir: config.repos_dir.clone(),
            build_version: config.build_version.clone(),
            gc_state: Arc::new(DashMap::new()),
            write_locks: Arc::new(WriteLockManager::new()),
        }
    }

    pub fn repo_path(&self, repo_id: &str) -> PathBuf {
        self.repos_dir.join(format!("{}.git", repo_id))
    }
}
