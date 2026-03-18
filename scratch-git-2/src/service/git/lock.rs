use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::Mutex;

/// Manages per-repo+branch write locks to prevent concurrent writes.
pub struct WriteLockManager {
    locks: DashMap<String, Arc<Mutex<()>>>,
}

impl WriteLockManager {
    pub fn new() -> Self {
        Self {
            locks: DashMap::new(),
        }
    }

    /// Execute an operation while holding the write lock for the given repo+branch.
    pub async fn with_lock<F, Fut, T>(&self, repo_id: &str, branch: &str, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let key = format!("{}:{}", repo_id, branch);
        let lock = self
            .locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        f().await
    }
}
