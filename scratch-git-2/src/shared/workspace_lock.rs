//! Workspace-level advisory file lock for mutating CLI operations.
//!
//! Matches git's `.git/index.lock` pattern: create `.scratch/lock` atomically
//! via `O_CREAT|O_EXCL`. If creation fails because the file already exists,
//! check whether the owning PID is still alive — if it isn't, reclaim the lock.
//!
//! Single-worktree workspaces (post Phase 5) lose the implicit serialization
//! the three-worktree design had, so any mutating CLI op (`upload`, `accept`,
//! `discard`, `download`, …) must hold this lock for the duration of its work.
//!
//! Two acquire entry points:
//! - [`acquire`] — blocks up to [`WAIT_TIMEOUT`] (30s). Right for terminal CLI
//!   invocations where the user is happy to wait.
//! - [`try_acquire_with_short_wait`] — caller-specified wait budget; returns
//!   a structured [`LockError::Busy`] on timeout. Right for napi callers on the
//!   Electron main thread where any longer wait would feel like UI jank. See
//!   the slice H spec (DEV-10144) for the 100ms budget rationale.
//!
//! ## Observability (F11)
//!
//! Three events emit a single-line `[workspace_lock] event=<name> ...` record
//! on stderr (greppable for the desktop's captured CLI logs):
//! - `event=acquired wait_ms=N attempts=N path=…` — only when `wait_ms` ≥
//!   [`CONTENDED_LOG_THRESHOLD`] (100ms). Uncontended acquires are silent so
//!   the steady-state CLI noise floor stays at zero lock lines. `held_by=N`
//!   is appended when we observed the contending PID during the poll loop.
//! - `event=stale_reclaimed stale_pid=N path=…` — every time we yank a lock
//!   from a dead PID. Worth investigating if it fires repeatedly: it means a
//!   prior `scratchmd` exited without releasing (panic, SIGKILL, crash).
//! - `event=busy wait_ms=N attempts=N pid=N path=…` — every time an acquire
//!   times out. Fires from both entry points; the napi binding additionally
//!   surfaces `Busy` via `LOCK_BUSY` JS exceptions so the desktop can show a
//!   UI prompt.
//!
//! The structured [`LockError::Busy`] also carries `waited: Duration` and
//! `attempts: u32` so a future telemetry forwarder can surface them
//! programmatically without re-parsing the stderr line.

// Service binary doesn't acquire this lock — only the CLI and the future napi
// binding do. Suppress dead_code warnings on the service-side build the same
// way `shared::review_ops` does.
#![allow(dead_code)]

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;

const LOCK_FILENAME: &str = "lock";
const SCRATCH_DIRNAME: &str = ".scratch";
/// How long [`acquire`] (the CLI-default entry point) waits on a contended lock.
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Default poll interval while waiting on a contended lock. Per-call we clamp
/// this to `timeout / 4` so short-wait callers still get a few retry chances.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Floor for the "lock was contended" telemetry line. Acquires that resolved
/// faster than this are silent — they're the uncontended common case and would
/// flood stderr without surfacing any observability signal. Set to 100ms so
/// napi short-wait callers (100ms budget) stay silent on the success path.
const CONTENDED_LOG_THRESHOLD: Duration = Duration::from_millis(100);

/// RAII guard that releases the workspace lock when dropped.
pub struct WorkspaceLockGuard {
    lock_path: PathBuf,
}

impl Drop for WorkspaceLockGuard {
    fn drop(&mut self) {
        // Best-effort removal — if we can't delete it, a future `acquire` will
        // notice the PID is dead and reclaim it.
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

/// Structured error from [`try_acquire_with_short_wait`]. The CLI's [`acquire`]
/// wraps these into `anyhow::Error` for scriptability; napi callers consume
/// them directly so they can map `Busy` to a `LOCK_BUSY` JS exception code.
#[derive(Debug)]
pub enum LockError {
    /// Lock held by another live process; gave up waiting. `waited` and
    /// `attempts` (F11) are the observability surface — a future telemetry
    /// forwarder can read them without re-parsing the stderr
    /// `[workspace_lock] event=busy …` line.
    Busy {
        pid: u32,
        lock_path: PathBuf,
        waited: Duration,
        attempts: u32,
    },
    /// Filesystem error opening, creating, or removing the lock file.
    Io(std::io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Busy {
                pid,
                lock_path,
                waited,
                attempts,
            } => write!(
                f,
                "workspace is locked by another scratchmd process (pid {pid}); \
                 gave up after {}ms across {attempts} attempt(s); lock at {}",
                waited.as_millis(),
                lock_path.display()
            ),
            LockError::Io(err) => write!(f, "lock io error: {err}"),
        }
    }
}

impl std::error::Error for LockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LockError::Io(err) => Some(err),
            LockError::Busy { .. } => None,
        }
    }
}

impl From<std::io::Error> for LockError {
    fn from(err: std::io::Error) -> Self {
        LockError::Io(err)
    }
}

/// Acquire the workspace-level mutating-op lock. Blocks up to [`WAIT_TIMEOUT`]
/// (30s) waiting on a contending PID; returns an error if the wait times out.
///
/// This is the CLI-default entry point — terminal invocations are happy to
/// wait. For napi callers on the Electron main thread, use
/// [`try_acquire_with_short_wait`] instead.
pub fn acquire(workspace_dir: &Path) -> anyhow::Result<WorkspaceLockGuard> {
    try_acquire_with_short_wait(workspace_dir, WAIT_TIMEOUT)
        .map_err(|err| match err {
            LockError::Busy {
                pid,
                lock_path,
                waited,
                attempts,
            } => anyhow::anyhow!(
                "workspace is locked by another scratchmd process (pid {pid}); \
                 timed out after {}s ({attempts} attempts) waiting at {}",
                waited.as_secs(),
                lock_path.display()
            ),
            LockError::Io(io_err) => {
                anyhow::Error::from(io_err).context("failed to acquire workspace lock")
            }
        })
        .with_context(|| {
            format!(
                "failed to acquire workspace lock at {}",
                lock_path(workspace_dir).display()
            )
        })
}

/// Acquire the lock with a caller-specified wait budget. Returns
/// [`LockError::Busy`] if `timeout` elapses with the lock still held by a live
/// process; [`LockError::Io`] for filesystem errors.
///
/// Use ~100ms for napi callers on the Electron main thread; the existing
/// [`acquire`] (30s) is right for terminal CLI use.
pub fn try_acquire_with_short_wait(
    workspace_dir: &Path,
    timeout: Duration,
) -> Result<WorkspaceLockGuard, LockError> {
    let lock_path = lock_path(workspace_dir);
    let scratch_dir = lock_path
        .parent()
        .expect("lock_path always has a parent — see lock_path()");
    std::fs::create_dir_all(scratch_dir)?;

    // Poll no slower than POLL_INTERVAL, but tighten to timeout/4 for callers
    // with sub-second budgets so they get at least a few retry chances.
    let poll_interval = std::cmp::min(POLL_INTERVAL, timeout / 4).max(Duration::from_millis(1));

    let start = std::time::Instant::now();
    let mut attempts: u32 = 0;
    let mut last_seen_pid: Option<u32> = None;
    loop {
        attempts = attempts.saturating_add(1);
        match try_create(&lock_path) {
            Ok(()) => {
                let waited = start.elapsed();
                // F11: emit a `[workspace_lock] event=acquired …` line only
                // when the acquire actually blocked beyond the contention
                // threshold. Keeps the fast path (uncontended) and napi
                // short-wait callers silent on stderr.
                if waited >= CONTENDED_LOG_THRESHOLD {
                    match last_seen_pid {
                        Some(held_by) => eprintln!(
                            "[workspace_lock] event=acquired wait_ms={} attempts={attempts} held_by={held_by} path={}",
                            waited.as_millis(),
                            lock_path.display()
                        ),
                        None => eprintln!(
                            "[workspace_lock] event=acquired wait_ms={} attempts={attempts} path={}",
                            waited.as_millis(),
                            lock_path.display()
                        ),
                    }
                }
                return Ok(WorkspaceLockGuard { lock_path });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                // The lock file exists. Decide whether the holder is still alive.
                match read_owning_pid(&lock_path) {
                    Some(pid) if pid_is_alive(pid) => {
                        last_seen_pid = Some(pid);
                        if start.elapsed() >= timeout {
                            let waited = start.elapsed();
                            eprintln!(
                                "[workspace_lock] event=busy wait_ms={} attempts={attempts} pid={pid} path={}",
                                waited.as_millis(),
                                lock_path.display()
                            );
                            return Err(LockError::Busy {
                                pid,
                                lock_path,
                                waited,
                                attempts,
                            });
                        }
                        std::thread::sleep(poll_interval);
                        continue;
                    }
                    Some(stale_pid) => {
                        eprintln!(
                            "[workspace_lock] event=stale_reclaimed stale_pid={stale_pid} path={}",
                            lock_path.display()
                        );
                    }
                    None => {
                        eprintln!(
                            "[workspace_lock] event=stale_reclaimed stale_pid=unreadable path={}",
                            lock_path.display()
                        );
                    }
                }
                // Best-effort remove; loop and retry. If another process races
                // us to recreate it, the next try_create will fail and we'll
                // re-evaluate the new owner's liveness.
                let _ = std::fs::remove_file(&lock_path);
            }
            Err(err) => return Err(LockError::Io(err)),
        }
    }
}

fn try_create(lock_path: &Path) -> std::io::Result<()> {
    let mut file: File = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)?;
    let pid = std::process::id();
    file.write_all(format!("{pid}\n").as_bytes())?;
    Ok(())
}

fn read_owning_pid(lock_path: &Path) -> Option<u32> {
    let mut file = File::open(lock_path).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    buf.trim().parse::<u32>().ok()
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    // `kill -0` is the portable liveness probe: returns 0 if the process
    // exists (whether or not we have permission to signal it).
    // Safety: kill(2) with signal 0 has no observable side effect.
    let rc = unsafe { libc_kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    // ESRCH (3) means "no such process". Any other errno (e.g. EPERM) means
    // the process exists but we can't signal it — still alive.
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    errno != 3 // libc::ESRCH
}

#[cfg(not(unix))]
fn pid_is_alive(_pid: u32) -> bool {
    // Conservative default on non-Unix: assume the holder is alive so we
    // don't yank the lock out from under it. Windows liveness via OpenProcess
    // can be added later if/when we ship a Windows build.
    true
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

fn lock_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(SCRATCH_DIRNAME).join(LOCK_FILENAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn acquire_and_release_creates_and_removes_lock() {
        let dir = TempDir::new().unwrap();
        let lock_file = lock_path(dir.path());

        {
            let _guard = acquire(dir.path()).unwrap();
            assert!(lock_file.exists(), "lock file should exist while held");
        }
        assert!(!lock_file.exists(), "lock file should be removed on drop");
    }

    #[test]
    fn double_acquire_in_same_process_fails_fast_or_blocks() {
        // Locks are reentrant ONLY across drops, not within. Acquiring twice in
        // the same process is a programming error; we don't try to support it.
        // This test just ensures the second acquire is observable as "stuck"
        // rather than silently succeeding.
        let dir = TempDir::new().unwrap();
        let _guard = acquire(dir.path()).unwrap();

        // We can't call acquire() again synchronously without blocking the test
        // for 30s; instead verify the lockfile is present and try_create fails.
        let result = try_create(&lock_path(dir.path()));
        assert!(
            result.is_err(),
            "second create should fail with AlreadyExists"
        );
    }

    #[test]
    fn stale_lock_is_reclaimed() {
        let dir = TempDir::new().unwrap();
        let lock = lock_path(dir.path());
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        // Write a PID that almost certainly isn't alive — PID 0 is reserved
        // on Linux ("the swapper") and kill(0, 0) historically returns ESRCH
        // for unprivileged callers. On macOS this also returns ESRCH. If a
        // platform ever treats PID 0 as alive, swap in a freshly-spawned and
        // reaped child's PID here.
        std::fs::write(&lock, b"999999\n").unwrap();

        let _guard = acquire(dir.path()).unwrap();
        // Reclaim should have rewritten the file with our own PID.
        let owner = read_owning_pid(&lock).unwrap();
        assert_eq!(owner, std::process::id());
    }

    #[test]
    fn try_acquire_with_short_wait_returns_busy_on_held_lock() {
        let dir = TempDir::new().unwrap();
        let _held = acquire(dir.path()).unwrap();

        let started = std::time::Instant::now();
        let result = try_acquire_with_short_wait(dir.path(), Duration::from_millis(100));
        let elapsed = started.elapsed();

        match result {
            Err(LockError::Busy {
                pid,
                waited,
                attempts,
                ..
            }) => {
                assert_eq!(pid, std::process::id());
                // F11: Busy now carries the elapsed wait + attempt count for
                // telemetry forwarders that don't want to grep the stderr
                // `[workspace_lock] event=busy …` line. waited should be >=
                // the configured timeout (we returned only once
                // start.elapsed() >= timeout) and strictly less than 1s (it
                // was 100ms-bounded).
                assert!(
                    waited >= Duration::from_millis(100),
                    "waited should be >= configured timeout, got {waited:?}",
                );
                assert!(
                    waited < Duration::from_secs(1),
                    "waited should be bounded by timeout, got {waited:?}",
                );
                assert!(
                    attempts >= 1,
                    "attempts should be >= 1 after at least one poll loop, got {attempts}",
                );
            }
            Err(LockError::Io(err)) => panic!("expected Busy, got Io({err})"),
            Ok(_) => panic!("expected Busy, got Ok"),
        }
        // Allow generous slack for slow CI runners; the contract is "doesn't
        // block for 30s", not "exactly 100ms".
        assert!(
            elapsed < Duration::from_secs(2),
            "short-wait should not block for the full default timeout (took {elapsed:?})"
        );
    }

    #[test]
    fn try_acquire_with_short_wait_succeeds_when_uncontended() {
        let dir = TempDir::new().unwrap();
        let guard = try_acquire_with_short_wait(dir.path(), Duration::from_millis(100))
            .expect("uncontended acquire should succeed");
        assert!(lock_path(dir.path()).exists());
        drop(guard);
        assert!(!lock_path(dir.path()).exists());
    }

    /// F11: the structured error includes the elapsed wait and attempt count
    /// so a future telemetry forwarder can read them without scraping logs.
    /// The human-readable form also surfaces them for terminal users.
    #[test]
    fn busy_display_includes_waited_ms_and_attempts() {
        let err = LockError::Busy {
            pid: 4321,
            lock_path: PathBuf::from("/tmp/x/.scratch/lock"),
            waited: Duration::from_millis(312),
            attempts: 4,
        };
        let text = err.to_string();
        assert!(text.contains("pid 4321"), "missing pid: {text}");
        assert!(text.contains("312ms"), "missing waited ms: {text}");
        assert!(text.contains("4 attempt"), "missing attempts: {text}");
        assert!(
            text.contains("/tmp/x/.scratch/lock"),
            "missing lock path: {text}"
        );
    }

    /// F11: a contended acquire that does eventually succeed populates
    /// `last_seen_pid` (used in the `[workspace_lock] event=acquired … held_by=N`
    /// line) and reports more than one attempt. We can't capture stderr from
    /// a unit test cleanly, so this just exercises the timing path: wait long
    /// enough to cross at least one poll cycle, then verify both threads
    /// finished.
    #[test]
    fn contended_acquire_eventually_succeeds_after_release() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let dir = TempDir::new().unwrap();
        let workspace = dir.path().to_path_buf();
        let barrier = Arc::new(Barrier::new(2));

        let holder_barrier = barrier.clone();
        let holder_dir = workspace.clone();
        let holder = thread::spawn(move || {
            let guard = acquire(&holder_dir).unwrap();
            // Signal we're holding the lock, then release it after long enough
            // for the waiter to enter its poll loop at least once.
            holder_barrier.wait();
            thread::sleep(Duration::from_millis(400));
            drop(guard);
        });

        let waiter_dir = workspace.clone();
        let waiter = thread::spawn(move || {
            barrier.wait();
            // 2s budget — more than enough for the 400ms holder sleep.
            try_acquire_with_short_wait(&waiter_dir, Duration::from_secs(2))
                .expect("waiter should acquire after holder releases")
        });

        holder.join().unwrap();
        let _waiter_guard = waiter.join().unwrap();
        // Lock file is held by the waiter now; will be cleaned up on drop.
    }
}
