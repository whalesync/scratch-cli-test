//! `scratchmd push` — commit dirty worktrees and push to remote bare repos.
//!
//! For each connection: stages all changes in the dirty worktree, commits
//! (if anything to commit), then pushes the dirty branch to origin.
//! Also commits and pushes the workbook repo (master branch).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: current directory)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,

    /// Commit message (default: "scratchmd push")
    #[arg(long, default_value = "scratchmd push")]
    pub message: String,
}

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;

    let connections_dir = workspace.join(".scratch/connections");
    if !connections_dir.exists() {
        return Err(Error::Other(format!(
            "connections directory not found at {}. Run `scratchmd pull` first.",
            connections_dir.display()
        )));
    }

    let mut pushed = 0usize;

    // Push each connection's dirty worktree
    for entry in std::fs::read_dir(&connections_dir)? {
        let entry = entry?;
        let conn_scratch_dir = entry.path(); // .scratch/connections/{conn}/
        if !conn_scratch_dir.is_dir() {
            continue;
        }

        let conn_name = conn_scratch_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let git_dir = conn_scratch_dir.join(".git");
        if !git_dir.exists() {
            continue;
        }

        // The dirty worktree is at workspace/{conn_name}/
        let dirty_worktree = workspace.join(&conn_name);
        if !dirty_worktree.exists() {
            tracing::warn!("dirty worktree not found for {conn_name}, skipping");
            continue;
        }

        println!("  pushing connection: {conn_name}");
        push_connection(&git_dir, &dirty_worktree, &conn_name, &args.message)?;
        pushed += 1;
    }

    // Push workbook repo (master branch)
    let workbook_git = workspace.join(".scratch/workbook");
    if workbook_git.exists() {
        println!("  pushing workbook repo");
        push_workbook(&workbook_git, &args.message)?;
        pushed += 1;
    }

    if pushed == 0 {
        println!("Nothing to push — no connection directories found.");
    } else {
        println!("\nPushed {pushed} repo(s).");
    }

    Ok(())
}

fn push_connection(git_dir: &Path, dirty_worktree: &Path, conn_name: &str, message: &str) -> Result<()> {
    // Stage all changes in the dirty worktree
    let status = git_porcelain(dirty_worktree)?;
    if status.is_empty() {
        println!("    {conn_name}: nothing to commit");
    } else {
        // git add -A
        git_in(dirty_worktree, &["add", "-A"])?;
        // git commit
        git_in(dirty_worktree, &["commit", "-m", message])?;
        println!("    {conn_name}: committed {} changed file(s)", status.lines().count());
    }

    // git push origin dirty (run from the bare .git dir which has remote origin set)
    let result = Command::new("git")
        .args(["--git-dir", git_dir.to_str().unwrap(), "push", "origin", "dirty"])
        .output()
        .map_err(|e| Error::Other(format!("failed to run git push: {e}")))?;

    if result.status.success() {
        println!("    {conn_name}: pushed dirty -> origin");
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        // "Everything up-to-date" is not an error
        if stderr.contains("Everything up-to-date") || stderr.contains("up to date") {
            println!("    {conn_name}: already up-to-date");
        } else {
            return Err(Error::Other(format!(
                "git push failed for {conn_name}: {}",
                stderr.trim()
            )));
        }
    }

    Ok(())
}

fn push_workbook(workbook_dir: &Path, message: &str) -> Result<()> {
    let status = git_porcelain(workbook_dir)?;
    if status.is_empty() {
        println!("    workbook: nothing to commit");
    } else {
        git_in(workbook_dir, &["add", "-A"])?;
        git_in(workbook_dir, &["commit", "-m", message])?;
        println!("    workbook: committed {} changed file(s)", status.lines().count());
    }

    let result = Command::new("git")
        .args(["-C", workbook_dir.to_str().unwrap(), "push", "origin", "master"])
        .output()
        .map_err(|e| Error::Other(format!("failed to run git push: {e}")))?;

    if result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        if stderr.contains("Everything up-to-date") || stderr.contains("up to date") {
            println!("    workbook: already up-to-date");
        } else {
            println!("    workbook: pushed master -> origin");
        }
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        if stderr.contains("Everything up-to-date") || stderr.contains("up to date") {
            println!("    workbook: already up-to-date");
        } else {
            return Err(Error::Other(format!(
                "git push failed for workbook: {}",
                stderr.trim()
            )));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Git subprocess helpers
// ---------------------------------------------------------------------------

/// Returns `git status --porcelain` output; empty string means clean.
fn git_porcelain(cwd: &Path) -> Result<String> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output()
        .map_err(|e| Error::Other(format!("failed to run git status: {e}")))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_in(cwd: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| Error::Other(format!("failed to run git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Other(format!(
            "git {} failed: {}",
            args.join(" "),
            stderr.trim()
        )));
    }
    Ok(())
}
