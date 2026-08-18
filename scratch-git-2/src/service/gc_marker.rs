//! RAII "GC in progress" marker (DEV-11316).
//!
//! `AppState::gc_state` maps `repo_id → GC start time (ms since epoch)`; every
//! response envelope reports it as `status.gcInProgress`, and `/gc` + `/repair`
//! refuse to start while it is set. It used to be set and cleared by hand
//! around a `spawn_blocking` call in the handler — so when the client timed
//! out and axum dropped the handler future, the `remove` never ran and the
//! marker leaked until the next deploy, 409-ing every later GC on that repo
//! (production fingerprint of the DEV-11266 corruption). A panic in the
//! blocking closure leaked it the same way.
//!
//! [`GcMarkerGuard`] owns the marker: it is inserted atomically on
//! `try_acquire` and removed on `Drop`. Move the guard **into** the blocking
//! task that runs `git gc`, so the marker lives exactly as long as the work —
//! whatever happens to the request.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;

/// Shared `repo_id → GC start time (millis since epoch)` map.
pub type GcStateMap = Arc<DashMap<String, i64>>;

/// Owns the `gcInProgress` marker for one repo; clears it on drop.
#[must_use = "dropping the guard immediately clears the gcInProgress marker"]
pub struct GcMarkerGuard {
    gc_state: GcStateMap,
    repo_id: String,
    started_at_millis: i64,
}

impl GcMarkerGuard {
    /// Atomically set the marker for `repo_id`. Returns `None` (and leaves the
    /// existing marker untouched) when a GC is already recorded as running.
    pub fn try_acquire(gc_state: &GcStateMap, repo_id: &str) -> Option<GcMarkerGuard> {
        let started_at_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        match gc_state.entry(repo_id.to_string()) {
            Entry::Occupied(_) => None,
            Entry::Vacant(vacant) => {
                vacant.insert(started_at_millis);
                Some(GcMarkerGuard {
                    gc_state: gc_state.clone(),
                    repo_id: repo_id.to_string(),
                    started_at_millis,
                })
            }
        }
    }

    pub fn started_at_millis(&self) -> i64 {
        self.started_at_millis
    }
}

impl Drop for GcMarkerGuard {
    fn drop(&mut self) {
        // Only remove the entry this guard created. (Nothing else inserts
        // today, but the check keeps a stale guard from clearing a newer run.)
        self.gc_state.remove_if(&self.repo_id, |_, started_at| {
            *started_at == self.started_at_millis
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_gc_state() -> GcStateMap {
        Arc::new(DashMap::new())
    }

    #[test]
    fn marker_is_set_while_held_and_cleared_on_drop() {
        let gc_state = new_gc_state();
        let guard = GcMarkerGuard::try_acquire(&gc_state, "repo-a").expect("first acquire");
        assert!(gc_state.contains_key("repo-a"));
        assert!(
            GcMarkerGuard::try_acquire(&gc_state, "repo-a").is_none(),
            "second acquire must be refused while the first guard is alive"
        );
        drop(guard);
        assert!(!gc_state.contains_key("repo-a"));
        assert!(GcMarkerGuard::try_acquire(&gc_state, "repo-a").is_some());
    }

    /// The production leak: the handler future is dropped mid-GC. The guard
    /// lives in the blocking task, so the marker is cleared when the work
    /// ends — not never.
    #[tokio::test]
    async fn marker_is_cleared_when_work_finishes_even_if_the_request_future_was_dropped() {
        let gc_state = new_gc_state();
        let (work_started_tx, work_started_rx) = std::sync::mpsc::channel::<()>();
        let (release_work_tx, release_work_rx) = std::sync::mpsc::channel::<()>();

        let guard = GcMarkerGuard::try_acquire(&gc_state, "repo-b").unwrap();
        let handler_future = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _marker_held_for_the_whole_gc = guard;
                work_started_tx.send(()).unwrap();
                release_work_rx
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
            })
            .await
            .unwrap();
        });
        tokio::task::spawn_blocking(move || {
            work_started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
        })
        .await
        .unwrap();

        handler_future.abort();
        let _ = handler_future.await;
        assert!(
            gc_state.contains_key("repo-b"),
            "marker must stay set while the GC work is still running"
        );

        release_work_tx.send(()).unwrap();
        // The blocking task finishes on its own thread; give it a moment.
        for _ in 0..100 {
            if !gc_state.contains_key("repo-b") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !gc_state.contains_key("repo-b"),
            "marker leaked after the GC work finished"
        );
    }

    /// Many simultaneous `/gc` (or `/repair`) arrivals: exactly one wins, and
    /// the losers do not disturb the winner's timestamp.
    #[test]
    fn concurrent_try_acquire_has_exactly_one_winner() {
        use std::sync::{Barrier, Mutex};
        const THREADS: usize = 32;
        let gc_state = new_gc_state();
        let barrier = Arc::new(Barrier::new(THREADS));
        let winners: Arc<Mutex<Vec<GcMarkerGuard>>> = Arc::new(Mutex::new(Vec::new()));
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let gc_state = gc_state.clone();
                let barrier = barrier.clone();
                let winners = winners.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    if let Some(guard) = GcMarkerGuard::try_acquire(&gc_state, "repo-d") {
                        winners.lock().unwrap().push(guard);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let winners = Arc::try_unwrap(winners).ok().unwrap().into_inner().unwrap();
        assert_eq!(winners.len(), 1, "exactly one concurrent acquire may win");
        assert_eq!(
            *gc_state.get("repo-d").unwrap(),
            winners[0].started_at_millis()
        );
        drop(winners);
        assert!(!gc_state.contains_key("repo-d"));
    }

    /// Defensive `remove_if`: a stale guard must not clear a newer marker
    /// that replaced its entry.
    #[test]
    fn dropping_stale_guard_does_not_remove_replacement_marker() {
        let gc_state = new_gc_state();
        let stale = GcMarkerGuard::try_acquire(&gc_state, "repo-e").unwrap();
        // Simulate the entry being replaced out from under the guard.
        let replacement_started_at = stale.started_at_millis() + 1;
        gc_state.insert("repo-e".to_string(), replacement_started_at);
        drop(stale);
        assert_eq!(
            gc_state.get("repo-e").map(|v| *v),
            Some(replacement_started_at),
            "stale guard removed a marker it did not own"
        );
    }

    #[tokio::test]
    async fn marker_is_cleared_when_the_gc_closure_panics() {
        let gc_state = new_gc_state();
        let guard = GcMarkerGuard::try_acquire(&gc_state, "repo-c").unwrap();
        let join_result = tokio::task::spawn_blocking(move || {
            let _marker = guard;
            panic!("git gc exploded");
        })
        .await;
        assert!(join_result.is_err());
        assert!(!gc_state.contains_key("repo-c"));
    }
}
