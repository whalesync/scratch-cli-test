//! `scratchmd pull` — clone a workbook from the API server to a local worktree structure.
//!
//! Output structure:
//!
//! ```
//! {output}/{workbookName}-{workbookId}/
//!   {connName}-{connId}/                  ← dirty branch worktree
//!     {tableId}/records/*.json
//!     {tableId}/.scratch/schema.json
//!   .scratch/
//!     workbook/
//!       .git/                             ← workbook-level repo (syncs)
//!     connections/
//!       {connName}-{connId}/
//!         .git/                           ← connection bare repo
//!         master/                         ← master branch worktree
//!           {tableId}/records/*.json
//!   CLAUDE.md
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;


use serde::Deserialize;

use crate::{Error, Result};

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Scratch API server URL, e.g. http://localhost:3010
    #[arg(long, env = "SCRATCH_SERVER_URL", default_value = "http://localhost:3011")]
    pub server: String,

    /// scratchmd HTTP server URL (for git clone)
    #[arg(long, env = "SCRATCHMD_URL", default_value = "http://localhost:3100")]
    pub scratchmd_url: String,

    /// Workbook ID to pull
    pub workbook_id: String,

    /// Output directory (workbook folder will be created inside)
    #[arg(long, default_value = ".")]
    pub output: PathBuf,
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct WorkbookResponse {
    id: String,
    name: String,
    /// Relative path under repos_dir, e.g. "orgId/workbookId/workbook.git"
    workbook_repo_path: String,
    connector_accounts: Vec<ConnectorAccountResponse>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ConnectorAccountResponse {
    id: String,
    name: String,
    /// Relative repo path under repos_dir, e.g. "orgId/workbookId/connId/repo.git"
    repo_path: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(args: Args) -> Result<()> {
    // 1. Fetch workbook metadata from API server
    let workbook = fetch_workbook(&args.server, &args.workbook_id).await?;

    let workbook_dir_name = sanitize(&workbook.name);
    let workbook_root = args.output.join(&workbook_dir_name);

    tracing::info!("pulling workbook '{}' into {}", workbook.name, workbook_root.display());

    std::fs::create_dir_all(&workbook_root)?;
    let workbook_root = workbook_root.canonicalize().map_err(|e| {
        Error::Other(format!("failed to resolve workspace path: {e}"))
    })?;

    // 2. Clone workbook bare repo from scratchmd
    let workbook_git = workbook_root.join(".scratch/workbook/.git");
    std::fs::create_dir_all(&workbook_git)?;
    let workbook_clone_url = format!("{}/git/{}", args.scratchmd_url.trim_end_matches('/'), workbook.workbook_repo_path);
    tracing::info!("cloning workbook repo {} → {}", workbook_clone_url, workbook_git.display());
    git_run(
        &workbook_root,
        &["clone", "--bare", "--quiet", &workbook_clone_url, workbook_git.to_str().unwrap()],
    )?;

    // 3. For each connection: clone bare repo + add two worktrees
    for conn in &workbook.connector_accounts {
        pull_connection(&args.scratchmd_url, &workbook_root, conn)?;
    }

    // 4. Write CLAUDE.md and .scratch/docs/
    super::generate_docs::write_docs(&workbook_root, &workbook.name)?;

    println!("\n✓ Workbook pulled to: {}", workbook_root.display());
    println!("\nDirectory structure:");
    print_tree(&workbook_root, 0, 3);

    Ok(())
}

fn pull_connection(
    scratchmd_url: &str,
    workbook_root: &Path,
    conn: &ConnectorAccountResponse,
) -> Result<()> {
    let conn_dir_name = sanitize(&conn.name);

    // Paths
    let scratch_conn_dir = workbook_root
        .join(".scratch/connections")
        .join(&conn_dir_name);
    let git_dir = scratch_conn_dir.join(".git"); // bare repo lives here
    let dirty_worktree = workbook_root.join(&conn_dir_name); // top-level visible dir
    let master_worktree = scratch_conn_dir.join("master");

    std::fs::create_dir_all(&scratch_conn_dir)?;

    // Write id file
    std::fs::write(scratch_conn_dir.join("id"), &conn.id)?;

    // Clone bare repo from scratchmd server
    // URL: {scratchmd_url}/git/{repo_path}
    let clone_url = format!("{}/git/{}", scratchmd_url.trim_end_matches('/'), conn.repo_path);
    tracing::info!("cloning {} → {}", clone_url, git_dir.display());

    git_run(
        workbook_root, // cwd doesn't matter for clone
        &[
            "clone",
            "--bare",
            "--quiet",
            &clone_url,
            git_dir.to_str().unwrap(),
        ],
    )?;

    // Add dirty worktree (top-level connection directory)
    // The dirty branch should already exist on the remote (created by init-repo).
    std::fs::create_dir_all(&dirty_worktree)?;
    let dirty_result = git_run_in(
        &git_dir,
        &[
            "worktree",
            "add",
            "--quiet",
            dirty_worktree.to_str().unwrap(),
            "dirty",
        ],
    );
    if let Err(e) = dirty_result {
        tracing::warn!("dirty worktree add failed ({}), trying to create branch: {}", conn.id, e);
        // dirty branch may not exist yet — create it from master
        git_run_in(
            &git_dir,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "dirty",
                dirty_worktree.to_str().unwrap(),
                "master",
            ],
        )?;
    }

    // Add master worktree under .scratch
    std::fs::create_dir_all(&master_worktree)?;
    git_run_in(
        &git_dir,
        &[
            "worktree",
            "add",
            "--quiet",
            master_worktree.to_str().unwrap(),
            "master",
        ],
    )?;

    tracing::info!(
        "connection '{}': dirty worktree at {}, master at {}",
        conn.name,
        dirty_worktree.display(),
        master_worktree.display()
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async fn fetch_workbook(server: &str, workbook_id: &str) -> Result<WorkbookResponse> {
    let url = format!(
        "{}/experimental/workbooks/{}",
        server.trim_end_matches('/'),
        workbook_id
    );
    tracing::info!("fetching workbook metadata from {}", url);

    let response = reqwest::get(&url)
        .await?
        .error_for_status()
        .map_err(|e| Error::Http(e))?;

    let workbook = response.json::<WorkbookResponse>().await?;
    Ok(workbook)
}

// ---------------------------------------------------------------------------
// Git subprocess helpers
// ---------------------------------------------------------------------------

fn git_run(cwd: &Path, args: &[&str]) -> Result<()> {
    git_run_in(cwd, args)
}

fn git_run_in(dir: &Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/// Remove characters that are unsafe in directory names.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Print a simple directory tree for display purposes.
fn print_tree(path: &Path, depth: usize, max_depth: usize) {
    if depth > max_depth {
        return;
    }
    let indent = "  ".repeat(depth);
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();

    if path.is_dir() {
        println!("{}{}/", indent, name);
        if let Ok(entries) = std::fs::read_dir(path) {
            let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries.iter().take(10) {
                print_tree(&entry.path(), depth + 1, max_depth);
            }
            if entries.len() > 10 {
                println!("{}  ... ({} more)", indent, entries.len() - 10);
            }
        }
    } else {
        println!("{}{}", indent, name);
    }
}
