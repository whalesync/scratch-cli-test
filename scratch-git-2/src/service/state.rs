use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;

use crate::service::config::Config;
use crate::service::git::lock::WriteLockManager;

#[derive(Clone)]
pub struct AppState {
    pub repos_dir: PathBuf,
    pub index_dir: PathBuf,
    pub build_version: String,
    /// Map of repo_id → GC start timestamp (millis since epoch)
    pub gc_state: Arc<DashMap<String, i64>>,
    pub write_locks: Arc<WriteLockManager>,
}

impl AppState {
    pub fn new(config: &Config) -> Self {
        Self {
            repos_dir: config.repos_dir.clone(),
            index_dir: config.index_dir.clone(),
            build_version: config.build_version.clone(),
            gc_state: Arc::new(DashMap::new()),
            write_locks: Arc::new(WriteLockManager::new()),
        }
    }

    /// V1 repo path: `{repos_dir}/{repo_id}.git`
    pub fn repo_path(&self, repo_id: &str) -> PathBuf {
        self.repos_dir.join(format!("{}.git", repo_id))
    }

    /// Index DB path: `{index_dir}/{repo_id}.db`
    ///
    /// For V2 repo IDs like `orgId/workbookId/connId`, this naturally creates
    /// `{index_dir}/orgId/workbookId/connId.db`.
    pub fn index_db_path(&self, repo_id: &str) -> PathBuf {
        self.index_dir.join(format!("{}.db", repo_id))
    }

}
