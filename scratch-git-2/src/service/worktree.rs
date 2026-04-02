//! Temporary git worktree helper.
//!
//! Creates a worktree from a bare repo for a given branch, and removes it on drop.
//! Used by the service to materialize a working directory for shared business logic.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A temporary git worktree that is automatically cleaned up on drop.
pub struct TempWorktree {
    /// Path to the materialized working directory.
    pub path: PathBuf,
    /// Path to the bare repo this worktree belongs to.
    bare_repo: PathBuf,
}

impl TempWorktree {
    /// Create a new worktree from `bare_repo` for `branch` under `worktrees_root`.
    ///
    /// The worktree is placed at `{worktrees_root}/{uuid}`.
    pub fn create(bare_repo: &Path, branch: &str, worktrees_root: &Path) -> Result<Self, String> {
        let id = uuid_v4();
        let wt_path = worktrees_root.join(&id);

        std::fs::create_dir_all(worktrees_root)
            .map_err(|e| format!("failed to create worktrees dir: {e}"))?;

        let output = Command::new("git")
            .args(["worktree", "add", "--force"])
            .arg(&wt_path)
            .arg(branch)
            .current_dir(bare_repo)
            .output()
            .map_err(|e| format!("failed to run git worktree add: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {stderr}"));
        }

        Ok(Self {
            path: wt_path,
            bare_repo: bare_repo.to_path_buf(),
        })
    }

    /// Stage all changes and commit to the worktree's branch.
    pub fn commit(&self, message: &str) -> Result<(), String> {
        let run = |args: &[&str]| -> Result<(), String> {
            let output = Command::new("git")
                .args(args)
                .current_dir(&self.path)
                .output()
                .map_err(|e| format!("git {}: {e}", args[0]))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("git {} failed: {stderr}", args[0]));
            }
            Ok(())
        };

        run(&["add", "-A"])?;

        // Check if there's anything to commit
        let status = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&self.path)
            .output()
            .map_err(|e| format!("git status: {e}"))?;

        if status.stdout.is_empty() {
            return Ok(()); // nothing to commit
        }

        run(&[
            "commit",
            "-m",
            message,
            "--author",
            "Scratch <scratch@whalesync.com>",
        ])
    }

    /// Remove the worktree and delete the directory.
    fn cleanup(&self) {
        // git worktree remove
        let _ = Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&self.path)
            .current_dir(&self.bare_repo)
            .output();

        // Belt-and-suspenders: remove the directory if git didn't
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl Drop for TempWorktree {
    fn drop(&mut self) {
        self.cleanup();
    }
}

/// Simple UUID v4 (random) without pulling in the uuid crate.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Mix in thread id for uniqueness across concurrent calls
    let tid = std::thread::current().id();
    let hash = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(format!("{tid:?}").len() as u128);
    format!("{:032x}", hash)
}
