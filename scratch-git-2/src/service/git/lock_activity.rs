//! Visibility into the per-`repo:branch` write-lock queue (`RepoLocks`).
//!
//! The locks themselves are plain in-memory tokio mutexes, so without this module
//! there is no way to tell, from outside the process, which operation holds a
//! repo's lock, who is queued behind it, or whether the holder is an orphan whose
//! client already gave up (the nginx proxy cuts requests at 300 s but the blocking
//! work keeps running and keeps the lock — see `lock.rs`). This registry records
//! every waiter and holder so that:
//!
//! - `GET /api/debug/locks` can show the live queue, and
//! - the service logs long waits, long holds, abandoned waits, and clients that
//!   disconnected while their operation kept the lock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::Serialize;

tokio::task_local! {
    /// Human-readable description of the HTTP request being served on this task
    /// (e.g. `POST /api/repo/write/{id}/rebase`). Set by the service's request
    /// middleware so lock tracking can say *which* operation holds a lock without
    /// every call site passing a label through.
    pub static CURRENT_REQUEST_DESCRIPTION: Arc<str>;
}

/// Waits at least this long are logged when the lock is finally acquired.
const LOCK_WAIT_DURATION_WORTH_LOGGING: Duration = Duration::from_secs(1);
/// Holds at least this long are logged when the lock is released.
const LOCK_HOLD_DURATION_WORTH_LOGGING: Duration = Duration::from_secs(10);

fn describe_current_request_or_internal_caller() -> Arc<str> {
    CURRENT_REQUEST_DESCRIPTION
        .try_with(|request_description| request_description.clone())
        .unwrap_or_else(|_| Arc::from("internal caller (no HTTP request)"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchLockOperationPhase {
    WaitingForLock,
    HoldingLock,
}

struct TrackedBranchLockOperation {
    repo_id: String,
    branch: String,
    request_description: Arc<str>,
    phase: BranchLockOperationPhase,
    started_waiting_at_instant: Instant,
    started_waiting_at_wall_clock: DateTime<Utc>,
    acquired_lock_at_instant: Option<Instant>,
    requesting_client_disconnected: bool,
}

/// One row of `GET /api/debug/locks`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchLockOperationSnapshot {
    pub operation_id: u64,
    pub repo_id: String,
    pub branch: String,
    pub request_description: String,
    pub phase: BranchLockOperationPhase,
    pub started_waiting_at: DateTime<Utc>,
    /// Time spent queued before acquiring (still growing while `waitingForLock`).
    pub waited_for_lock_milliseconds: u64,
    /// Time the lock has been held so far; `None` while still waiting.
    pub held_lock_milliseconds: Option<u64>,
    /// The HTTP client that started this operation has gone away (typically the
    /// proxy's 300 s timeout) while the operation keeps running and holding the lock.
    pub requesting_client_disconnected: bool,
}

#[derive(Default)]
pub struct BranchLockActivityRegistry {
    next_operation_id: AtomicU64,
    tracked_operations_by_id: DashMap<u64, TrackedBranchLockOperation>,
}

impl BranchLockActivityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that the current request has started waiting for `repo_id:branch`.
    /// The returned registration removes the entry (and logs an abandoned wait) if
    /// it is dropped before [`WaitingForBranchLockRegistration::convert_to_hold`].
    pub fn register_waiter(
        self: &Arc<Self>,
        repo_id: &str,
        branch: &str,
    ) -> WaitingForBranchLockRegistration {
        let operation_id = self.next_operation_id.fetch_add(1, Ordering::Relaxed);
        self.tracked_operations_by_id.insert(
            operation_id,
            TrackedBranchLockOperation {
                repo_id: repo_id.to_string(),
                branch: branch.to_string(),
                request_description: describe_current_request_or_internal_caller(),
                phase: BranchLockOperationPhase::WaitingForLock,
                started_waiting_at_instant: Instant::now(),
                started_waiting_at_wall_clock: Utc::now(),
                acquired_lock_at_instant: None,
                requesting_client_disconnected: false,
            },
        );
        WaitingForBranchLockRegistration {
            registry: self.clone(),
            operation_id,
            converted_to_hold: false,
        }
    }

    /// Mark every listed (held) operation as orphaned: its HTTP client went away
    /// while the operation keeps running and keeps the lock.
    pub fn mark_requesting_client_disconnected(&self, held_operation_ids: &[u64]) {
        for operation_id in held_operation_ids {
            let Some(mut tracked_operation) = self.tracked_operations_by_id.get_mut(operation_id)
            else {
                continue;
            };
            tracked_operation.requesting_client_disconnected = true;
            let held_so_far = tracked_operation
                .acquired_lock_at_instant
                .map(|acquired_at| acquired_at.elapsed())
                .unwrap_or_default();
            tracing::warn!(
                "[LOCK] Client for {} disconnected after the operation had held {}:{} for {}ms; \
                 the operation keeps running and keeps the lock until it finishes",
                tracked_operation.request_description,
                tracked_operation.repo_id,
                tracked_operation.branch,
                held_so_far.as_millis(),
            );
        }
    }

    /// Every tracked waiter and holder, optionally restricted to repos whose id
    /// starts with `repo_id_prefix`. Holders first, then waiters, oldest first.
    pub fn snapshot(&self, repo_id_prefix: Option<&str>) -> Vec<BranchLockOperationSnapshot> {
        let mut snapshots: Vec<BranchLockOperationSnapshot> = self
            .tracked_operations_by_id
            .iter()
            .filter(|entry| {
                repo_id_prefix.is_none_or(|prefix| entry.value().repo_id.starts_with(prefix))
            })
            .map(|entry| {
                let tracked_operation = entry.value();
                let waited_for_lock = match tracked_operation.acquired_lock_at_instant {
                    Some(acquired_at) => {
                        acquired_at.duration_since(tracked_operation.started_waiting_at_instant)
                    }
                    None => tracked_operation.started_waiting_at_instant.elapsed(),
                };
                BranchLockOperationSnapshot {
                    operation_id: *entry.key(),
                    repo_id: tracked_operation.repo_id.clone(),
                    branch: tracked_operation.branch.clone(),
                    request_description: tracked_operation.request_description.to_string(),
                    phase: tracked_operation.phase,
                    started_waiting_at: tracked_operation.started_waiting_at_wall_clock,
                    waited_for_lock_milliseconds: waited_for_lock.as_millis() as u64,
                    held_lock_milliseconds: tracked_operation
                        .acquired_lock_at_instant
                        .map(|acquired_at| acquired_at.elapsed().as_millis() as u64),
                    requesting_client_disconnected: tracked_operation
                        .requesting_client_disconnected,
                }
            })
            .collect();
        snapshots.sort_by(|left, right| {
            let holders_before_waiters = |phase: BranchLockOperationPhase| match phase {
                BranchLockOperationPhase::HoldingLock => 0,
                BranchLockOperationPhase::WaitingForLock => 1,
            };
            (
                &left.repo_id,
                &left.branch,
                holders_before_waiters(left.phase),
                left.operation_id,
            )
                .cmp(&(
                    &right.repo_id,
                    &right.branch,
                    holders_before_waiters(right.phase),
                    right.operation_id,
                ))
        });
        snapshots
    }

    fn record_lock_acquired(&self, operation_id: u64) {
        let Some(mut tracked_operation) = self.tracked_operations_by_id.get_mut(&operation_id)
        else {
            return;
        };
        let acquired_at = Instant::now();
        tracked_operation.phase = BranchLockOperationPhase::HoldingLock;
        tracked_operation.acquired_lock_at_instant = Some(acquired_at);
        let waited_for_lock =
            acquired_at.duration_since(tracked_operation.started_waiting_at_instant);
        if waited_for_lock >= LOCK_WAIT_DURATION_WORTH_LOGGING {
            tracing::info!(
                "[LOCK] {} acquired {}:{} after waiting {}ms",
                tracked_operation.request_description,
                tracked_operation.repo_id,
                tracked_operation.branch,
                waited_for_lock.as_millis(),
            );
        }
    }

    fn record_waiter_abandoned(&self, operation_id: u64) {
        let Some((_, tracked_operation)) = self.tracked_operations_by_id.remove(&operation_id)
        else {
            return;
        };
        tracing::warn!(
            "[LOCK] {} gave up waiting for {}:{} after {}ms — its client disconnected before \
             the lock was free, so the operation never ran",
            tracked_operation.request_description,
            tracked_operation.repo_id,
            tracked_operation.branch,
            tracked_operation
                .started_waiting_at_instant
                .elapsed()
                .as_millis(),
        );
    }

    fn record_lock_released(&self, operation_id: u64) {
        let Some((_, tracked_operation)) = self.tracked_operations_by_id.remove(&operation_id)
        else {
            return;
        };
        let Some(acquired_at) = tracked_operation.acquired_lock_at_instant else {
            return;
        };
        let held_lock_for = acquired_at.elapsed();
        let waited_for_lock =
            acquired_at.duration_since(tracked_operation.started_waiting_at_instant);
        if tracked_operation.requesting_client_disconnected {
            tracing::warn!(
                "[LOCK] Orphaned {} released {}:{} after holding it {}ms (waited {}ms first); \
                 its client had already disconnected",
                tracked_operation.request_description,
                tracked_operation.repo_id,
                tracked_operation.branch,
                held_lock_for.as_millis(),
                waited_for_lock.as_millis(),
            );
        } else if held_lock_for >= LOCK_HOLD_DURATION_WORTH_LOGGING {
            tracing::info!(
                "[LOCK] {} released {}:{} after holding it {}ms (waited {}ms first)",
                tracked_operation.request_description,
                tracked_operation.repo_id,
                tracked_operation.branch,
                held_lock_for.as_millis(),
                waited_for_lock.as_millis(),
            );
        }
    }
}

/// A queued waiter. Dropping it before `convert_to_hold` means the waiting future
/// was cancelled (client gone), so the entry is removed and the abandonment logged.
pub struct WaitingForBranchLockRegistration {
    registry: Arc<BranchLockActivityRegistry>,
    operation_id: u64,
    converted_to_hold: bool,
}

impl WaitingForBranchLockRegistration {
    pub fn convert_to_hold(mut self) -> HeldBranchLockRegistration {
        self.converted_to_hold = true;
        self.registry.record_lock_acquired(self.operation_id);
        HeldBranchLockRegistration {
            registry: self.registry.clone(),
            operation_id: self.operation_id,
        }
    }
}

impl Drop for WaitingForBranchLockRegistration {
    fn drop(&mut self) {
        if !self.converted_to_hold {
            self.registry.record_waiter_abandoned(self.operation_id);
        }
    }
}

/// Lives inside a `BranchWriteGuard`; dropping it (lock released) removes the
/// entry and logs long or orphaned holds.
pub struct HeldBranchLockRegistration {
    registry: Arc<BranchLockActivityRegistry>,
    operation_id: u64,
}

impl HeldBranchLockRegistration {
    pub fn operation_id(&self) -> u64 {
        self.operation_id
    }
}

impl Drop for HeldBranchLockRegistration {
    fn drop(&mut self) {
        self.registry.record_lock_released(self.operation_id);
    }
}
