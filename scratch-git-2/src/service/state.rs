use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;

use crate::service::config::Config;
use crate::service::git::lock::WriteLockManager;

// TODO(v2-routes): wire up V2 repo routing in the final phase
// /// Separator used in V2 composite repo IDs: `{orgId}--{workbookId}--{connAccountId}`
// const V2_ID_SEPARATOR: &str = "--";

#[derive(Clone)]
pub struct AppState {
    pub repos_dir: PathBuf,
    // TODO(v2-routes): used in final phase when routes are wired to V2 repo paths
    #[allow(dead_code)]
    pub repos_v2_dir: PathBuf,
    pub build_version: String,
    /// Map of repo_id → GC start timestamp (millis since epoch)
    pub gc_state: Arc<DashMap<String, i64>>,
    pub write_locks: Arc<WriteLockManager>,
}

impl AppState {
    pub fn new(config: &Config) -> Self {
        Self {
            repos_dir: config.repos_dir.clone(),
            repos_v2_dir: config.repos_v2_dir.clone(),
            build_version: config.build_version.clone(),
            gc_state: Arc::new(DashMap::new()),
            write_locks: Arc::new(WriteLockManager::new()),
        }
    }

    /// V1 repo path: `{repos_dir}/{repo_id}.git`
    pub fn repo_path(&self, repo_id: &str) -> PathBuf {
        self.repos_dir.join(format!("{}.git", repo_id))
    }

    // TODO(v2-routes): used in final phase when routes are wired to V2 repo paths
    // /// V2 repo path from a composite ID `{orgId}--{workbookId}--{connAccountId}`.
    // /// Maps to `{repos_v2_dir}/{orgId}/{workbookId}/{connAccountId}.git`.
    // /// Falls back to treating the whole id as a flat name if it doesn't contain the separator.
    // pub fn repo_path_v2(&self, composite_id: &str) -> PathBuf {
    //     let parts: Vec<&str> = composite_id.splitn(3, V2_ID_SEPARATOR).collect();
    //     match parts.as_slice() {
    //         [org_id, workbook_id, conn_id] => self
    //             .repos_v2_dir
    //             .join(org_id)
    //             .join(workbook_id)
    //             .join(format!("{}.git", conn_id)),
    //         _ => self
    //             .repos_v2_dir
    //             .join(format!("{}.git", composite_id)),
    //     }
    // }
}
