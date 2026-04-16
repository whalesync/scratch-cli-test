use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::{Mutex, OwnedMutexGuard};

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

    fn get_or_create(&self, repo_id: &str, branch: &str) -> Arc<Mutex<()>> {
        let key = format!("{}:{}", repo_id, branch);
        self.locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Execute an operation while holding the write lock for the given repo+branch.
    pub async fn with_lock<F, Fut, T>(&self, repo_id: &str, branch: &str, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let lock = self.get_or_create(repo_id, branch);
        let _guard = lock.lock().await;
        f().await
    }

    /// Acquire the write lock and return an owned guard.
    ///
    /// The returned guard is `Send` and can be moved into a `tokio::spawn` task,
    /// allowing the lock to be held across task boundaries (e.g. while waiting
    /// for a subprocess to exit). Drop the guard to release the lock.
    pub async fn acquire(&self, repo_id: &str, branch: &str) -> OwnedMutexGuard<()> {
        let lock = self.get_or_create(repo_id, branch);
        lock.lock_owned().await
    }
}
