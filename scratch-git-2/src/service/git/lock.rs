//! Per-repo write locking for the service.
//!
//! # Why the guard must live inside the blocking task (DEV-11266 / DEV-11316)
//!
//! Every write handler does its real work in `tokio::task::spawn_blocking`.
//! A `spawn_blocking` task is **not** cancelled when the future awaiting it is
//! dropped — it runs to completion. axum drops the handler future when the
//! client goes away (the nginx proxy in front of this service cuts requests at
//! 300 s), so a lock guard held in the *handler future* is released while the
//! work it was protecting is still running. That is exactly how an orphaned
//! `git gc` ended up pruning objects a concurrent write was still building.
//!
//! `RepoLocks::run_write` therefore acquires the guard and moves it *into* the
//! blocking closure, so the lock is held for as long as the work runs — even
//! after the request that started it has been abandoned. Handlers must not
//! acquire a guard and then call `spawn_blocking` themselves. Every route that
//! mutates a repo (branch writes, tags, staging commits, repair, and the
//! lifecycle routes init/delete/copy/strip-prefix) goes through `run_write` /
//! `run_write_main_and_dirty`; the one exception is the git smart-HTTP
//! receive-pack path, which hands its guard to the task that supervises the
//! `git http-backend` child (`smart_http.rs`).

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::service::error::AppError;
use crate::service::types::{DIRTY_BRANCH, MAIN_BRANCH};

/// Per-repo lock manager. Today it holds one mutex per `repo:branch`; the
/// repo-wide reader/writer lock that lets a full GC exclude every writer is the
/// next step (DEV-11316 MR 2) and slots in beside `branch_locks`.
pub struct RepoLocks {
    branch_locks: DashMap<String, Arc<Mutex<()>>>,
}

/// Owned guard for one `repo:branch` write lock. `Send`, so it can be moved
/// into a `spawn_blocking` closure or a `tokio::spawn` task and held for the
/// lifetime of the work rather than the lifetime of the request.
pub type BranchWriteGuard = OwnedMutexGuard<()>;

impl Default for RepoLocks {
    fn default() -> Self {
        Self::new()
    }
}

impl RepoLocks {
    pub fn new() -> Self {
        Self {
            branch_locks: DashMap::new(),
        }
    }

    fn get_or_create_branch_lock(&self, repo_id: &str, branch: &str) -> Arc<Mutex<()>> {
        let key = format!("{}:{}", repo_id, branch);
        self.branch_locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Acquire the write lock for `repo:branch` and return an owned guard.
    ///
    /// Prefer [`RepoLocks::run_write`]. Use this only when the guarded work is
    /// not a `spawn_blocking` closure — e.g. `smart_http.rs` holds the guard in
    /// a `tokio::spawn` task for the lifetime of a `git http-backend` child.
    /// Whatever owns the guard must be something that outlives the request.
    pub async fn acquire_branch_write_guard(
        &self,
        repo_id: &str,
        branch: &str,
    ) -> BranchWriteGuard {
        let lock = self.get_or_create_branch_lock(repo_id, branch);
        lock.lock_owned().await
    }

    /// Run `f` on the blocking thread pool while holding the `repo:branch`
    /// write lock **inside that blocking task**, so the lock survives the
    /// handler future being dropped (client timeout / disconnect).
    pub async fn run_write<F, T>(&self, repo_id: &str, branch: &str, f: F) -> Result<T, AppError>
    where
        F: FnOnce() -> Result<T, AppError> + Send + 'static,
        T: Send + 'static,
    {
        let branch_guard = self.acquire_branch_write_guard(repo_id, branch).await;
        run_blocking_holding_guards(vec![branch_guard], f).await
    }

    /// Like [`RepoLocks::run_write`] but for operations that rewrite both
    /// `main` and `dirty` (rename, move-folder, repair). Always acquires
    /// `main` before `dirty` — the one lock ordering used everywhere in this
    /// service — so two such operations can never deadlock each other.
    pub async fn run_write_main_and_dirty<F, T>(&self, repo_id: &str, f: F) -> Result<T, AppError>
    where
        F: FnOnce() -> Result<T, AppError> + Send + 'static,
        T: Send + 'static,
    {
        let main_guard = self.acquire_branch_write_guard(repo_id, MAIN_BRANCH).await;
        let dirty_guard = self.acquire_branch_write_guard(repo_id, DIRTY_BRANCH).await;
        run_blocking_holding_guards(vec![main_guard, dirty_guard], f).await
    }
}

/// Spawn `f` on the blocking pool with `guards` moved into the closure. The
/// guards drop — and the locks release — when `f` returns or panics, never
/// earlier. A panic inside `f` surfaces as `AppError::Internal` (the
/// `JoinError`), matching what the call sites did before.
async fn run_blocking_holding_guards<F, T>(
    guards: Vec<BranchWriteGuard>,
    f: F,
) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _guards_held_for_the_whole_operation = guards;
        f()
    })
    .await
    .map_err(|join_error| AppError::internal(join_error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// The bug that let an orphaned operation run unlocked: the handler future
    /// is dropped (client timeout) while the blocking work continues. With the
    /// guard inside the blocking task the lock must stay held until the work
    /// actually finishes.
    #[tokio::test]
    async fn run_write_keeps_lock_held_after_handler_future_is_dropped() {
        let locks = Arc::new(RepoLocks::new());
        let (work_started_tx, work_started_rx) = mpsc::channel::<()>();
        let (release_work_tx, release_work_rx) = mpsc::channel::<()>();

        // Simulate the handler: a spawned future that runs the write, whose
        // blocking closure blocks until we tell it to finish.
        let handler_future = tokio::spawn({
            let locks = locks.clone();
            async move {
                locks
                    .run_write("repo-a", MAIN_BRANCH, move || {
                        work_started_tx.send(()).unwrap();
                        release_work_rx
                            .recv_timeout(Duration::from_secs(10))
                            .expect("test never released the blocking work");
                        Ok::<_, AppError>(())
                    })
                    .await
            }
        });

        // Wait until the blocking work is running, then "time out" the request.
        tokio::task::spawn_blocking(move || {
            work_started_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
        })
        .await
        .unwrap();
        handler_future.abort();
        let _ = handler_future.await;

        // The lock must STILL be held: the work is running, only the request died.
        let still_held = tokio::time::timeout(
            Duration::from_millis(200),
            locks.acquire_branch_write_guard("repo-a", MAIN_BRANCH),
        )
        .await
        .is_err();
        assert!(
            still_held,
            "lock was released while the blocking work was still running"
        );

        // Let the work finish → the lock must become available.
        release_work_tx.send(()).unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            locks.acquire_branch_write_guard("repo-a", MAIN_BRANCH),
        )
        .await
        .expect("lock was not released after the blocking work finished");
    }

    #[tokio::test]
    async fn run_write_releases_lock_when_closure_panics() {
        let locks = Arc::new(RepoLocks::new());

        let result = locks
            .run_write("repo-b", DIRTY_BRANCH, || -> Result<(), AppError> {
                panic!("boom inside the guarded work");
            })
            .await;
        assert!(matches!(result, Err(AppError::Internal(_))));

        tokio::time::timeout(
            Duration::from_secs(5),
            locks.acquire_branch_write_guard("repo-b", DIRTY_BRANCH),
        )
        .await
        .expect("lock leaked after a panic in the guarded closure");
    }

    /// `run_write_main_and_dirty` must wait for a single-branch dirty holder
    /// (e.g. a smart_http push holding only the dirty guard) and then proceed
    /// — never deadlock — because a dirty-only holder never waits on main.
    #[tokio::test]
    async fn run_write_main_and_dirty_waits_for_dirty_only_holder_then_proceeds() {
        let locks = Arc::new(RepoLocks::new());
        let dirty_only_guard = locks
            .acquire_branch_write_guard("repo-d", DIRTY_BRANCH)
            .await;

        let both = tokio::spawn({
            let locks = locks.clone();
            async move {
                locks
                    .run_write_main_and_dirty("repo-d", || Ok::<_, AppError>(()))
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !both.is_finished(),
            "main+dirty write ran while dirty was held"
        );
        // While it waits it already holds main → a main-only writer queues too.
        assert!(tokio::time::timeout(
            Duration::from_millis(200),
            locks.run_write("repo-d", MAIN_BRANCH, || Ok::<_, AppError>(()))
        )
        .await
        .is_err());

        drop(dirty_only_guard);
        tokio::time::timeout(Duration::from_secs(5), both)
            .await
            .expect("main+dirty write deadlocked")
            .unwrap()
            .unwrap();
        // Everything released afterwards.
        locks
            .run_write_main_and_dirty("repo-d", || Ok::<_, AppError>(()))
            .await
            .unwrap();
    }

    /// Abort the waiter after the dual-guard closure has started: neither
    /// main nor dirty may become writable until the closure ends.
    #[tokio::test]
    async fn run_write_main_and_dirty_keeps_both_guards_after_waiter_abort() {
        let locks = Arc::new(RepoLocks::new());
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let waiter = tokio::spawn({
            let locks = locks.clone();
            async move {
                locks
                    .run_write_main_and_dirty("repo-e", move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                        Ok::<_, AppError>(())
                    })
                    .await
            }
        });
        tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(10)))
            .await
            .unwrap()
            .unwrap();
        waiter.abort();
        let _ = waiter.await;

        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(200),
                    locks.acquire_branch_write_guard("repo-e", branch)
                )
                .await
                .is_err(),
                "{branch} became writable while the aborted dual-guard work was still running"
            );
        }
        release_tx.send(()).unwrap();
        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            tokio::time::timeout(
                Duration::from_secs(5),
                locks.acquire_branch_write_guard("repo-e", branch),
            )
            .await
            .unwrap_or_else(|_| panic!("{branch} not released after the work finished"));
        }
    }

    #[tokio::test]
    async fn run_write_main_and_dirty_releases_both_guards_after_panic() {
        let locks = Arc::new(RepoLocks::new());
        let result = locks
            .run_write_main_and_dirty("repo-f", || -> Result<(), AppError> {
                panic!("boom");
            })
            .await;
        assert!(matches!(result, Err(AppError::Internal(_))));
        for branch in [MAIN_BRANCH, DIRTY_BRANCH] {
            tokio::time::timeout(
                Duration::from_secs(5),
                locks.acquire_branch_write_guard("repo-f", branch),
            )
            .await
            .unwrap_or_else(|_| panic!("{branch} leaked after a panic"));
        }
    }

    #[tokio::test]
    async fn run_write_serializes_writers_on_the_same_branch_but_not_across_branches() {
        let locks = Arc::new(RepoLocks::new());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (started_tx, started_rx) = mpsc::channel::<()>();

        let holder = tokio::spawn({
            let locks = locks.clone();
            async move {
                locks
                    .run_write("repo-c", MAIN_BRANCH, move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                        Ok::<_, AppError>(())
                    })
                    .await
            }
        });
        tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(10)))
            .await
            .unwrap()
            .unwrap();

        // Same branch: blocked.
        assert!(tokio::time::timeout(
            Duration::from_millis(200),
            locks.run_write("repo-c", MAIN_BRANCH, || Ok::<_, AppError>(()))
        )
        .await
        .is_err());
        // Other branch of the same repo: proceeds.
        tokio::time::timeout(
            Duration::from_secs(5),
            locks.run_write("repo-c", DIRTY_BRANCH, || Ok::<_, AppError>(())),
        )
        .await
        .expect("dirty write blocked by a main write")
        .unwrap();

        release_tx.send(()).unwrap();
        holder.await.unwrap().unwrap();
    }
}
