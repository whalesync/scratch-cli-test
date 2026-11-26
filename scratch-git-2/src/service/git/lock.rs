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
//! lifecycle routes init/delete/copy/move/strip-prefix) goes through `run_write` /
//! `run_write_main_and_dirty`; the one exception is the git smart-HTTP
//! receive-pack path, which hands its guard to the task that supervises the
//! `git http-backend` child (`smart_http.rs`).
//!
//! Every waiter and holder is recorded in a [`BranchLockActivityRegistry`] so the
//! queue is observable (`GET /api/debug/locks`, `[LOCK]` log lines) — see
//! `lock_activity.rs`.

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::service::error::AppError;
use crate::service::git::lock_activity::{
    BranchLockActivityRegistry, BranchLockOperationSnapshot, HeldBranchLockRegistration,
};
use crate::service::types::{DIRTY_BRANCH, MAIN_BRANCH};

/// Per-repo lock manager. Today it holds one mutex per `repo:branch`; the
/// repo-wide reader/writer lock that lets a full GC exclude every writer is the
/// next step (DEV-11316 MR 2) and slots in beside `branch_locks`.
pub struct RepoLocks {
    branch_locks: DashMap<String, Arc<Mutex<()>>>,
    lock_activity_registry: Arc<BranchLockActivityRegistry>,
}

/// Owned guard for one `repo:branch` write lock. `Send`, so it can be moved
/// into a `spawn_blocking` closure or a `tokio::spawn` task and held for the
/// lifetime of the work rather than the lifetime of the request. Dropping it
/// releases the lock and removes the holder from the activity registry.
pub struct BranchWriteGuard {
    _mutex_guard_released_first: OwnedMutexGuard<()>,
    held_lock_registration: HeldBranchLockRegistration,
}

impl Default for RepoLocks {
    fn default() -> Self {
        Self::new()
    }
}

impl RepoLocks {
    pub fn new() -> Self {
        Self {
            branch_locks: DashMap::new(),
            lock_activity_registry: Arc::new(BranchLockActivityRegistry::new()),
        }
    }

    /// Live holders and waiters, optionally only for repos whose id starts with
    /// `repo_id_prefix` (backs `GET /api/debug/locks`).
    pub fn snapshot_lock_activity(
        &self,
        repo_id_prefix: Option<&str>,
    ) -> Vec<BranchLockOperationSnapshot> {
        self.lock_activity_registry.snapshot(repo_id_prefix)
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
        // Dropped un-converted (→ logged as an abandoned wait) if this future is
        // cancelled while queued.
        let waiting_registration = self.lock_activity_registry.register_waiter(repo_id, branch);
        let mutex_guard = lock.lock_owned().await;
        BranchWriteGuard {
            _mutex_guard_released_first: mutex_guard,
            held_lock_registration: waiting_registration.convert_to_hold(),
        }
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
        run_blocking_holding_guards(&self.lock_activity_registry, vec![branch_guard], f).await
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
        run_blocking_holding_guards(
            &self.lock_activity_registry,
            vec![main_guard, dirty_guard],
            f,
        )
        .await
    }

    /// Like [`RepoLocks::run_write_main_and_dirty`] but for an operation on two repos at once (a
    /// repo move, DEV-13019). The two repos are locked in lexicographic order of their ids, `main`
    /// before `dirty` within each, so two such operations can never deadlock each other, and a
    /// single-repo writer, which never holds a second repo's lock, can't be part of a cycle.
    pub async fn run_write_main_and_dirty_of_two_repos<F, T>(
        &self,
        first_repo_id: &str,
        second_repo_id: &str,
        f: F,
    ) -> Result<T, AppError>
    where
        F: FnOnce() -> Result<T, AppError> + Send + 'static,
        T: Send + 'static,
    {
        let (repo_id_locked_first, repo_id_locked_second) = if first_repo_id <= second_repo_id {
            (first_repo_id, second_repo_id)
        } else {
            (second_repo_id, first_repo_id)
        };
        let mut guards = Vec::with_capacity(4);
        for repo_id in [repo_id_locked_first, repo_id_locked_second] {
            guards.push(self.acquire_branch_write_guard(repo_id, MAIN_BRANCH).await);
            guards.push(self.acquire_branch_write_guard(repo_id, DIRTY_BRANCH).await);
        }
        run_blocking_holding_guards(&self.lock_activity_registry, guards, f).await
    }
}

/// Spawn `f` on the blocking pool with `guards` moved into the closure. The
/// guards drop — and the locks release — when `f` returns or panics, never
/// earlier. A panic inside `f` surfaces as `AppError::Internal` (the
/// `JoinError`), matching what the call sites did before.
///
/// If the awaiting (handler) future is dropped before the work finishes — the
/// client disconnected — the held operations are marked orphaned in the registry.
async fn run_blocking_holding_guards<F, T>(
    lock_activity_registry: &Arc<BranchLockActivityRegistry>,
    guards: Vec<BranchWriteGuard>,
    f: F,
) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    let mut requesting_client_disconnect_watch = RequestingClientDisconnectWatch {
        lock_activity_registry: lock_activity_registry.clone(),
        held_operation_ids: guards
            .iter()
            .map(|guard| guard.held_lock_registration.operation_id())
            .collect(),
        blocking_work_finished: false,
    };
    let join_result = tokio::task::spawn_blocking(move || {
        let _guards_held_for_the_whole_operation = guards;
        f()
    })
    .await;
    requesting_client_disconnect_watch.blocking_work_finished = true;
    join_result.map_err(|join_error| AppError::internal(join_error.to_string()))?
}

/// Lives in the handler future across the `spawn_blocking` await. Dropped
/// without `blocking_work_finished` ⇒ the handler future was cancelled while the
/// blocking work (and its locks) kept running.
struct RequestingClientDisconnectWatch {
    lock_activity_registry: Arc<BranchLockActivityRegistry>,
    held_operation_ids: Vec<u64>,
    blocking_work_finished: bool,
}

impl Drop for RequestingClientDisconnectWatch {
    fn drop(&mut self) {
        if !self.blocking_work_finished {
            self.lock_activity_registry
                .mark_requesting_client_disconnected(&self.held_operation_ids);
        }
    }
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

    fn lock_activity_for_repo(
        locks: &RepoLocks,
        repo_id: &str,
    ) -> Vec<crate::service::git::lock_activity::BranchLockOperationSnapshot> {
        locks.snapshot_lock_activity(Some(repo_id))
    }

    /// A holder and a queued waiter both show up, labelled with the request that
    /// started them, holder first; both disappear once the work is done.
    #[tokio::test]
    async fn lock_activity_snapshot_lists_holder_then_waiter_with_request_descriptions() {
        use crate::service::git::lock_activity::{
            BranchLockOperationPhase, CURRENT_REQUEST_DESCRIPTION,
        };
        let locks = Arc::new(RepoLocks::new());
        let (holder_started_tx, holder_started_rx) = mpsc::channel::<()>();
        let (release_holder_tx, release_holder_rx) = mpsc::channel::<()>();

        let holder = tokio::spawn(CURRENT_REQUEST_DESCRIPTION.scope(
            Arc::from("POST /api/repo/write/{id}/rebase"),
            {
                let locks = locks.clone();
                async move {
                    locks
                        .run_write("repo-activity", DIRTY_BRANCH, move || {
                            holder_started_tx.send(()).unwrap();
                            release_holder_rx
                                .recv_timeout(Duration::from_secs(10))
                                .unwrap();
                            Ok::<_, AppError>(())
                        })
                        .await
                }
            },
        ));
        tokio::task::spawn_blocking(move || {
            holder_started_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
        })
        .await
        .unwrap();

        let waiter = tokio::spawn(CURRENT_REQUEST_DESCRIPTION.scope(
            Arc::from("POST /api/repo/manage/{id}/reset"),
            {
                let locks = locks.clone();
                async move {
                    locks
                        .run_write("repo-activity", DIRTY_BRANCH, || Ok::<_, AppError>(()))
                        .await
                }
            },
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;

        let lock_activity = lock_activity_for_repo(&locks, "repo-activity");
        assert_eq!(lock_activity.len(), 2, "{lock_activity:?}");
        assert_eq!(
            lock_activity[0].phase,
            BranchLockOperationPhase::HoldingLock
        );
        assert_eq!(
            lock_activity[0].request_description,
            "POST /api/repo/write/{id}/rebase"
        );
        assert_eq!(lock_activity[0].branch, DIRTY_BRANCH);
        assert!(lock_activity[0].held_lock_milliseconds.is_some());
        assert_eq!(
            lock_activity[1].phase,
            BranchLockOperationPhase::WaitingForLock
        );
        assert_eq!(
            lock_activity[1].request_description,
            "POST /api/repo/manage/{id}/reset"
        );
        assert!(lock_activity[1].held_lock_milliseconds.is_none());
        assert!(lock_activity[1].waited_for_lock_milliseconds >= 50);

        release_holder_tx.send(()).unwrap();
        holder.await.unwrap().unwrap();
        waiter.await.unwrap().unwrap();
        assert!(lock_activity_for_repo(&locks, "repo-activity").is_empty());
        // Other repos are filtered out by the prefix.
        assert!(lock_activity_for_repo(&locks, "some-other-repo").is_empty());
    }

    /// A waiter whose future is cancelled (client gone) never runs and must not
    /// linger in the snapshot.
    #[tokio::test]
    async fn lock_activity_drops_waiter_cancelled_while_queued() {
        let locks = Arc::new(RepoLocks::new());
        let held = locks
            .acquire_branch_write_guard("repo-abandoned-wait", MAIN_BRANCH)
            .await;
        let waiter = tokio::spawn({
            let locks = locks.clone();
            async move {
                locks
                    .run_write("repo-abandoned-wait", MAIN_BRANCH, || Ok::<_, AppError>(()))
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            lock_activity_for_repo(&locks, "repo-abandoned-wait").len(),
            2
        );

        waiter.abort();
        let _ = waiter.await;
        let lock_activity = lock_activity_for_repo(&locks, "repo-abandoned-wait");
        assert_eq!(lock_activity.len(), 1, "{lock_activity:?}");
        assert!(!lock_activity[0].requesting_client_disconnected);

        drop(held);
        assert!(lock_activity_for_repo(&locks, "repo-abandoned-wait").is_empty());
    }

    /// The orphan case from the 504 incidents: the handler future is dropped
    /// while the blocking work keeps the lock. The holder must be flagged as
    /// client-disconnected and stay listed until the work actually finishes.
    #[tokio::test]
    async fn lock_activity_flags_holder_whose_client_disconnected_until_work_finishes() {
        let locks = Arc::new(RepoLocks::new());
        let (work_started_tx, work_started_rx) = mpsc::channel::<()>();
        let (release_work_tx, release_work_rx) = mpsc::channel::<()>();
        let handler_future = tokio::spawn({
            let locks = locks.clone();
            async move {
                locks
                    .run_write_main_and_dirty("repo-orphan", move || {
                        work_started_tx.send(()).unwrap();
                        release_work_rx
                            .recv_timeout(Duration::from_secs(10))
                            .unwrap();
                        Ok::<_, AppError>(())
                    })
                    .await
            }
        });
        tokio::task::spawn_blocking(move || {
            work_started_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
        })
        .await
        .unwrap();
        assert!(lock_activity_for_repo(&locks, "repo-orphan")
            .iter()
            .all(|operation| !operation.requesting_client_disconnected));

        handler_future.abort();
        let _ = handler_future.await;
        let lock_activity = lock_activity_for_repo(&locks, "repo-orphan");
        assert_eq!(lock_activity.len(), 2, "main and dirty both still held");
        assert!(lock_activity
            .iter()
            .all(|operation| operation.requesting_client_disconnected));

        release_work_tx.send(()).unwrap();
        // The blocking work releases the guards when it returns.
        tokio::time::timeout(
            Duration::from_secs(5),
            locks.acquire_branch_write_guard("repo-orphan", DIRTY_BRANCH),
        )
        .await
        .expect("orphaned work never released the lock");
        // A guard releases its mutex before it removes its holder from the registry (field
        // order), so the lock above can be acquired an instant before the orphaned work's dirty
        // holder leaves the snapshot. There is no handle to join the orphaned work on, so wait
        // for the snapshot to empty rather than asserting on the first look.
        tokio::time::timeout(Duration::from_secs(5), async {
            while !lock_activity_for_repo(&locks, "repo-orphan").is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("orphaned work's lock holders never left the activity snapshot");
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
