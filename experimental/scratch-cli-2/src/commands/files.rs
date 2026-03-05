use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};
use serde::Serialize;

use crate::cli::Cli;
use crate::commands::helpers::*;
use crate::merge;

#[derive(Args)]
pub struct FilesCommand {
    #[command(subcommand)]
    pub action: FilesAction,
}

#[derive(Subcommand)]
pub enum FilesAction {
    /// Download remote changes and merge locally
    Download {
        /// Workbook ID (auto-detected if inside a workbook directory)
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Upload local changes to the server
    Upload {
        /// Workbook ID (auto-detected if inside a workbook directory)
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

impl FilesCommand {
    pub fn run(&self, cli: &Cli) -> Result<()> {
        match &self.action {
            FilesAction::Download { id, json } => run_download(cli, id.as_deref(), *json),
            FilesAction::Upload { id, json } => run_upload(cli, id.as_deref(), *json),
        }
    }
}

// --- Result types ---

#[derive(Serialize)]
struct DownloadResult {
    status: String,
    #[serde(rename = "filesUpdated")]
    files_updated: i32,
    #[serde(rename = "filesCreated")]
    files_created: i32,
    #[serde(rename = "filesDeleted")]
    files_deleted: i32,
    #[serde(rename = "filesMerged")]
    files_merged: i32,
    #[serde(rename = "conflictsAutoResolved")]
    conflicts_auto_resolved: i32,
    messages: Vec<String>,
}

impl DownloadResult {
    fn up_to_date() -> Self {
        Self {
            status: "up_to_date".into(),
            files_updated: 0,
            files_created: 0,
            files_deleted: 0,
            files_merged: 0,
            conflicts_auto_resolved: 0,
            messages: vec![],
        }
    }
}

#[derive(Serialize)]
struct UploadResult {
    status: String,
    #[serde(rename = "filesUploaded")]
    files_uploaded: i32,
    #[serde(rename = "filesMerged")]
    files_merged: i32,
    #[serde(rename = "filesDeleted")]
    files_deleted: i32,
    #[serde(rename = "conflictsAutoResolved")]
    conflicts_auto_resolved: i32,
    retries: i32,
    messages: Vec<String>,
}

// --- Top-level command runners ---

fn run_download(cli: &Cli, workbook_id_arg: Option<&str>, json_output: bool) -> Result<()> {
    let cwd = std::env::current_dir().context("failed to get current directory")?;

    // Resolve workbook directory.
    let (workbook_dir, version) = resolve_files_context(&cwd, workbook_id_arg)?;

    let server_url = get_server_url(cli);
    let creds = crate::credentials::load_credentials(&server_url)?;
    if creds.api_token.is_empty() {
        bail!("not logged in. Run 'scratchmd auth login' first");
    }

    if version == "2" {
        run_v2_download(&workbook_dir, &creds.api_token, json_output)
    } else {
        let result = download_single_repo(&workbook_dir, &creds.api_token)?;
        print_download_result(&result, json_output)
    }
}

fn run_upload(cli: &Cli, workbook_id_arg: Option<&str>, json_output: bool) -> Result<()> {
    let cwd = std::env::current_dir().context("failed to get current directory")?;

    let (workbook_dir, version) = resolve_files_context(&cwd, workbook_id_arg)?;

    let server_url = get_server_url(cli);
    let creds = crate::credentials::load_credentials(&server_url)?;
    if creds.api_token.is_empty() {
        bail!("not logged in. Run 'scratchmd auth login' first");
    }

    if version == "2" {
        run_v2_upload(&workbook_dir, &creds.api_token, &creds.email, json_output)
    } else {
        let result = upload_single_repo(&workbook_dir, &creds.api_token, &creds.email)?;
        print_upload_result(&result, json_output)
    }
}

/// Resolve the workbook directory and version from cwd or workbook ID arg.
/// Returns (workbook_dir, version_string).
fn resolve_files_context(cwd: &Path, workbook_id_arg: Option<&str>) -> Result<(PathBuf, String)> {
    if let Some(wb_id) = workbook_id_arg {
        // Check if we're already inside this workbook.
        if let Some((dir, marker)) = find_workbook_marker_dir_upward(cwd) {
            if marker.workbook.id == wb_id {
                let version = marker.version.unwrap_or_default();
                return Ok((dir, version));
            }
        }
        // Scan children of cwd.
        if let Some(dir) = find_existing_workbook_marker(cwd, wb_id) {
            let marker = load_workbook_marker_full(&dir)?;
            let version = marker.version.unwrap_or_default();
            return Ok((dir, version));
        }
        bail!(
            "workbook {} not found. Run 'scratchmd workbooks init {}' first",
            wb_id,
            wb_id
        );
    }

    // Check if inside a connector subdirectory (V2).
    if let Some((conn_dir, _)) = find_connector_marker_dir_upward(cwd) {
        return Ok((conn_dir, "connector".into()));
    }

    // Auto-detect workbook from cwd.
    if let Some((dir, marker)) = find_workbook_marker_dir_upward(cwd) {
        let version = marker.version.unwrap_or_default();
        return Ok((dir, version));
    }

    bail!("not inside a workbook directory. Run from a workbook directory or pass a workbook ID")
}

// --- V2 multi-connector ---

fn run_v2_download(workbook_dir: &Path, api_token: &str, json_output: bool) -> Result<()> {
    let conn_dirs = find_connector_directories(workbook_dir)?;
    if conn_dirs.is_empty() {
        if json_output {
            return print_json(&DownloadResult::up_to_date());
        }
        println!("No connector directories found. Run 'scratchmd workbooks init' first.");
        return Ok(());
    }

    let mut results = Vec::new();
    for dir in &conn_dirs {
        if !json_output {
            println!("Downloading {}...", dir.file_name().unwrap_or_default().to_string_lossy());
        }
        results.push(download_single_repo(dir, api_token)?);
    }

    let agg = aggregate_download_results(&results);
    print_download_result(&agg, json_output)
}

fn run_v2_upload(
    workbook_dir: &Path,
    api_token: &str,
    email: &str,
    json_output: bool,
) -> Result<()> {
    let conn_dirs = find_connector_directories(workbook_dir)?;
    if conn_dirs.is_empty() {
        if json_output {
            return print_json(&UploadResult {
                status: "no_changes".into(),
                files_uploaded: 0,
                files_merged: 0,
                files_deleted: 0,
                conflicts_auto_resolved: 0,
                retries: 0,
                messages: vec![],
            });
        }
        println!("No connector directories found.");
        return Ok(());
    }

    let mut results = Vec::new();
    for dir in &conn_dirs {
        if !json_output {
            println!("Uploading {}...", dir.file_name().unwrap_or_default().to_string_lossy());
        }
        results.push(upload_single_repo(dir, api_token, email)?);
    }

    let agg = aggregate_upload_results(&results);
    print_upload_result(&agg, json_output)
}

// --- Single repo download ---

fn download_single_repo(repo_dir: &Path, api_token: &str) -> Result<DownloadResult> {
    let base_hash = git_rev_parse(repo_dir, "HEAD")?;

    git_fetch(repo_dir, api_token)?;

    let remote_hash = git_rev_parse(repo_dir, "refs/remotes/origin/dirty")?;

    if base_hash == remote_hash {
        return Ok(DownloadResult::up_to_date());
    }

    let base_map = git_tree_to_file_map(repo_dir, &base_hash)?;
    let remote_map = git_tree_to_file_map(repo_dir, &remote_hash)?;
    let local_map = disk_to_file_map(repo_dir)?;

    let actions = merge::compute_merge_actions(&base_map, &local_map, &remote_map);

    let mut stash: HashMap<String, Vec<u8>> = HashMap::new();
    let mut deletions: Vec<String> = Vec::new();
    let mut messages: Vec<String> = Vec::new();
    let mut result = DownloadResult {
        status: "downloaded".into(),
        files_updated: 0,
        files_created: 0,
        files_deleted: 0,
        files_merged: 0,
        conflicts_auto_resolved: 0,
        messages: vec![],
    };

    for act in &actions {
        match act.action {
            merge::ActionType::KeepLocal => {
                if let Some(ref local) = act.local {
                    stash.insert(act.path.clone(), local.clone());
                }
            }
            merge::ActionType::WriteRemote => {
                if act.base.is_none() {
                    result.files_created += 1;
                } else {
                    result.files_updated += 1;
                }
            }
            merge::ActionType::Delete => {
                result.files_deleted += 1;
                deletions.push(act.path.clone());
                if let Some(ref msg) = act.warning_msg {
                    messages.push(msg.clone());
                }
            }
            merge::ActionType::Merge => {
                let merged = merge_file_content(
                    act.base.as_deref(),
                    act.local.as_deref(),
                    act.remote.as_deref(),
                );
                stash.insert(act.path.clone(), merged);
                result.files_merged += 1;
                if act.base.is_some() {
                    result.conflicts_auto_resolved += 1;
                }
            }
        }
    }

    // Stash .scratchmd markers before reset.
    stash_markers(repo_dir, &mut stash);

    // Reset to remote state.
    git_reset_hard(repo_dir, &remote_hash)?;

    // Restore stashed files (local edits + markers).
    for (rel_path, content) in &stash {
        let full_path = repo_dir.join(rel_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&full_path, content)
            .with_context(|| format!("failed to write {}", rel_path))?;
    }

    // Delete removed files.
    for rel_path in &deletions {
        let full_path = repo_dir.join(rel_path);
        std::fs::remove_file(&full_path).ok();
    }

    result.messages = messages;
    Ok(result)
}

// --- Single repo upload ---

fn upload_single_repo(
    repo_dir: &Path,
    api_token: &str,
    email: &str,
) -> Result<UploadResult> {
    let base_hash = git_rev_parse(repo_dir, "HEAD")?;
    let base_map = git_tree_to_file_map(repo_dir, &base_hash)?;
    let local_map = disk_to_file_map(repo_dir)?;

    if file_map_equal(&base_map, &local_map) {
        return Ok(UploadResult {
            status: "no_changes".into(),
            files_uploaded: 0,
            files_merged: 0,
            files_deleted: 0,
            conflicts_auto_resolved: 0,
            retries: 0,
            messages: vec![],
        });
    }

    let author_email = if email.is_empty() {
        "cli@scratch.md"
    } else {
        email
    };

    const MAX_RETRIES: i32 = 5;

    for attempt in 0..MAX_RETRIES {
        git_fetch(repo_dir, api_token)?;

        let remote_hash = git_rev_parse(repo_dir, "refs/remotes/origin/dirty")?;
        let remote_map = git_tree_to_file_map(repo_dir, &remote_hash)?;

        let actions = merge::compute_merge_actions(&base_map, &local_map, &remote_map);

        let mut merged_map: merge::FileMap = HashMap::new();
        let mut messages: Vec<String> = Vec::new();
        let mut result = UploadResult {
            status: "uploaded".into(),
            files_uploaded: 0,
            files_merged: 0,
            files_deleted: 0,
            conflicts_auto_resolved: 0,
            retries: attempt,
            messages: vec![],
        };

        for act in &actions {
            match act.action {
                merge::ActionType::KeepLocal => {
                    if let Some(ref local) = act.local {
                        merged_map.insert(act.path.clone(), local.clone());
                        let remote_content = remote_map.get(&act.path);
                        let changed = match remote_content {
                            Some(rc) => rc != local,
                            None => true,
                        };
                        if changed {
                            result.files_uploaded += 1;
                        }
                    }
                }
                merge::ActionType::WriteRemote => {
                    if let Some(ref remote) = act.remote {
                        merged_map.insert(act.path.clone(), remote.clone());
                    }
                }
                merge::ActionType::Delete => {
                    if remote_map.contains_key(&act.path) {
                        result.files_deleted += 1;
                    }
                    if let Some(ref msg) = act.warning_msg {
                        messages.push(msg.clone());
                    }
                }
                merge::ActionType::Merge => {
                    let merged = merge_file_content(
                        act.base.as_deref(),
                        act.local.as_deref(),
                        act.remote.as_deref(),
                    );
                    merged_map.insert(act.path.clone(), merged);
                    result.files_merged += 1;
                    if act.base.is_some() {
                        result.conflicts_auto_resolved += 1;
                    }
                }
            }
        }

        result.messages = messages;

        // If merged state equals remote, nothing to push.
        if file_map_equal(&merged_map, &remote_map) {
            return Ok(UploadResult {
                status: "up_to_date".into(),
                files_uploaded: 0,
                files_merged: 0,
                files_deleted: 0,
                conflicts_auto_resolved: 0,
                retries: 0,
                messages: vec![],
            });
        }

        // Stash markers.
        let mut marker_stash: HashMap<String, Vec<u8>> = HashMap::new();
        stash_markers(repo_dir, &mut marker_stash);

        // Reset to remote.
        git_reset_hard(repo_dir, &remote_hash)?;

        // Write merged files (only those that differ from remote).
        for (rel_path, content) in &merged_map {
            if let Some(remote_content) = remote_map.get(rel_path) {
                if content == remote_content {
                    continue;
                }
            }
            let full_path = repo_dir.join(rel_path);
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create dir for {}", rel_path))?;
            }
            std::fs::write(&full_path, content)
                .with_context(|| format!("failed to write {}", rel_path))?;
        }

        // Remove files in remote that aren't in merged.
        for rel_path in remote_map.keys() {
            if !merged_map.contains_key(rel_path) {
                let full_path = repo_dir.join(rel_path);
                std::fs::remove_file(&full_path).ok();
            }
        }

        // Stage + commit + push.
        git_add_all(repo_dir)?;
        git_commit(repo_dir, "Upload from Scratch CLI", "Scratch CLI", author_email)?;

        match git_push(repo_dir, api_token) {
            Ok(()) => {
                restore_markers(repo_dir, &marker_stash);
                return Ok(result);
            }
            Err(e) => {
                restore_markers(repo_dir, &marker_stash);
                let err_msg = e.to_string();
                if err_msg.contains("non-fast-forward")
                    || err_msg.contains("rejected")
                    || err_msg.contains("fetch first")
                {
                    continue; // Retry.
                }
                return Err(e);
            }
        }
    }

    bail!(
        "upload failed after {} attempts due to concurrent changes on the server",
        MAX_RETRIES
    )
}

// --- Git helpers (using system git) ---

fn git_cmd(repo_dir: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(repo_dir);
    cmd
}

fn git_rev_parse(repo_dir: &Path, rev: &str) -> Result<String> {
    let output = git_cmd(repo_dir)
        .args(["rev-parse", rev])
        .output()
        .context("failed to run git rev-parse")?;
    if !output.status.success() {
        bail!(
            "git rev-parse {} failed: {}",
            rev,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_fetch(repo_dir: &Path, api_token: &str) -> Result<()> {
    let header = format!("http.extraHeader=Authorization: API-Token {}", api_token);
    let output = git_cmd(repo_dir)
        .args([
            "-c",
            &header,
            "fetch",
            "origin",
            "dirty:refs/remotes/origin/dirty",
            "--force",
        ])
        .output()
        .context("failed to run git fetch")?;
    // Ignore "already up to date" — check stderr for real errors.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Some versions of git print warnings to stderr but still exit 0.
        // Only fail on actual errors (non-zero exit).
        bail!("git fetch failed: {}", stderr);
    }
    Ok(())
}

fn git_reset_hard(repo_dir: &Path, commit: &str) -> Result<()> {
    let output = git_cmd(repo_dir)
        .args(["reset", "--hard", commit])
        .output()
        .context("failed to run git reset")?;
    if !output.status.success() {
        bail!(
            "git reset --hard failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn git_add_all(repo_dir: &Path) -> Result<()> {
    let output = git_cmd(repo_dir)
        .args(["add", "-A"])
        .output()
        .context("failed to run git add")?;
    if !output.status.success() {
        bail!(
            "git add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn git_commit(repo_dir: &Path, message: &str, author_name: &str, author_email: &str) -> Result<()> {
    let author = format!("{} <{}>", author_name, author_email);
    let output = git_cmd(repo_dir)
        .args(["commit", "-m", message, "--author", &author, "--allow-empty"])
        .output()
        .context("failed to run git commit")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "nothing to commit" is not an error for our purposes.
        if !stderr.contains("nothing to commit") {
            bail!("git commit failed: {}", stderr);
        }
    }
    Ok(())
}

fn git_push(repo_dir: &Path, api_token: &str) -> Result<()> {
    let header = format!("http.extraHeader=Authorization: API-Token {}", api_token);
    let output = git_cmd(repo_dir)
        .args([
            "-c",
            &header,
            "push",
            "origin",
            "dirty:dirty",
        ])
        .output()
        .context("failed to run git push")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git push failed: {}", stderr);
    }
    Ok(())
}

/// Read all files from a git commit tree into a FileMap.
fn git_tree_to_file_map(repo_dir: &Path, commit_hash: &str) -> Result<merge::FileMap> {
    // List all files in the tree.
    let output = git_cmd(repo_dir)
        .args(["ls-tree", "-r", "--name-only", commit_hash])
        .output()
        .context("failed to run git ls-tree")?;
    if !output.status.success() {
        bail!(
            "git ls-tree failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let file_list = String::from_utf8_lossy(&output.stdout);
    let mut fm: merge::FileMap = HashMap::new();

    for line in file_list.lines() {
        let path = line.trim();
        if path.is_empty() {
            continue;
        }

        // Read file content from the commit.
        let blob_ref = format!("{}:{}", commit_hash, path);
        let content_output = git_cmd(repo_dir)
            .args(["show", &blob_ref])
            .output()
            .with_context(|| format!("failed to read {}", blob_ref))?;
        if !content_output.status.success() {
            continue; // Skip unreadable files.
        }

        let mut data = content_output.stdout;
        if !merge::is_binary(&data) {
            data = merge::normalize_crlf(&data);
        }
        fm.insert(path.replace('\\', "/"), data);
    }

    Ok(fm)
}

/// Read all files from a directory into a FileMap, skipping .git and .scratchmd.
fn disk_to_file_map(root_dir: &Path) -> Result<merge::FileMap> {
    let abs_root = std::fs::canonicalize(root_dir)
        .with_context(|| format!("failed to canonicalize {}", root_dir.display()))?;

    let mut fm: merge::FileMap = HashMap::new();

    for entry in walkdir::WalkDir::new(&abs_root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            name != ".git"
        })
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name == ".scratchmd" || name == ".schema.json" {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&abs_root)
            .unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        let mut data = std::fs::read(entry.path())
            .with_context(|| format!("failed to read {}", entry.path().display()))?;
        if !merge::is_binary(&data) {
            data = merge::normalize_crlf(&data);
        }
        fm.insert(rel_str, data);
    }

    Ok(fm)
}

// --- Merge helper ---

fn merge_file_content(base: Option<&[u8]>, local: Option<&[u8]>, remote: Option<&[u8]>) -> Vec<u8> {
    let local_data = local.unwrap_or(&[]);
    let remote_data = remote.unwrap_or(&[]);

    // Binary files — local wins.
    if merge::is_binary(local_data) || merge::is_binary(remote_data) {
        return if !local_data.is_empty() {
            local_data.to_vec()
        } else {
            remote_data.to_vec()
        };
    }

    merge::text::merge_text(base, local_data, remote_data)
}

// --- Marker helpers ---

/// Stash .scratchmd marker files (root + data folder markers) before git reset.
fn stash_markers(repo_dir: &Path, stash: &mut HashMap<String, Vec<u8>>) {
    // Root marker.
    let root_marker = repo_dir.join(".scratchmd");
    if let Ok(data) = std::fs::read(&root_marker) {
        stash.insert(".scratchmd".into(), data);
    }

    // Data folder markers in subdirectories.
    if let Ok(entries) = std::fs::read_dir(repo_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            let marker_path = entry.path().join(".scratchmd");
            if let Ok(data) = std::fs::read(&marker_path) {
                let rel = format!("{}/{}", name.to_string_lossy(), ".scratchmd");
                stash.insert(rel, data);
            }
        }
    }
}

/// Restore stashed marker files after git operations.
fn restore_markers(repo_dir: &Path, stash: &HashMap<String, Vec<u8>>) {
    for (rel_path, content) in stash {
        let full_path = repo_dir.join(rel_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&full_path, content).ok();
    }
}

// --- Connector directory helpers ---

/// Find connector subdirectories in a V2 workbook (dirs with .scratchmd connector markers + .git).
fn find_connector_directories(workbook_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    let entries = std::fs::read_dir(workbook_dir)
        .context("failed to read workbook directory")?;

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let sub_dir = entry.path();

        // Check for connector marker.
        let marker_path = sub_dir.join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            if !data.contains("connector:") {
                continue;
            }
        } else {
            continue;
        }

        // Check for .git directory.
        if !sub_dir.join(".git").is_dir() {
            continue;
        }

        dirs.push(sub_dir);
    }

    Ok(dirs)
}

// --- Extended marker types ---

#[derive(serde::Deserialize)]
struct WorkbookMarkerFull {
    #[serde(default)]
    version: Option<String>,
    workbook: WorkbookMarkerConfigFull,
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct WorkbookMarkerConfigFull {
    id: String,
    #[serde(default, rename = "serverUrl")]
    server_url: Option<String>,
}

fn load_workbook_marker_full(dir: &Path) -> Result<WorkbookMarkerFull> {
    let data = std::fs::read_to_string(dir.join(".scratchmd"))
        .context("failed to read .scratchmd marker")?;
    let marker: WorkbookMarkerFull =
        serde_yaml::from_str(&data).context("failed to parse .scratchmd marker")?;
    if marker.workbook.id.is_empty() {
        bail!("marker missing workbook ID");
    }
    Ok(marker)
}

/// Walk upward from `start_dir` looking for a .scratchmd workbook marker.
/// Returns (directory, marker) or None.
fn find_workbook_marker_dir_upward(start_dir: &Path) -> Option<(PathBuf, WorkbookMarkerFull)> {
    let mut dir = start_dir.to_path_buf();
    loop {
        let marker_path = dir.join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            // Skip connector markers.
            if data.contains("connector:") {
                if !dir.pop() {
                    break;
                }
                continue;
            }
            if let Ok(marker) = serde_yaml::from_str::<WorkbookMarkerFull>(&data) {
                if !marker.workbook.id.is_empty() {
                    return Some((dir, marker));
                }
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Walk upward looking for a connector marker. Returns (directory, marker_yaml).
fn find_connector_marker_dir_upward(start_dir: &Path) -> Option<(PathBuf, String)> {
    let mut dir = start_dir.to_path_buf();
    loop {
        let marker_path = dir.join(".scratchmd");
        if let Ok(data) = std::fs::read_to_string(&marker_path) {
            if data.contains("connector:") {
                return Some((dir, data));
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

// --- FileMap comparison ---

fn file_map_equal(a: &merge::FileMap, b: &merge::FileMap) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (k, av) in a {
        match b.get(k) {
            Some(bv) if av == bv => {}
            _ => return false,
        }
    }
    true
}

// --- Result aggregation ---

fn aggregate_download_results(results: &[DownloadResult]) -> DownloadResult {
    let mut agg = DownloadResult::up_to_date();
    for r in results {
        if r.status == "downloaded" {
            agg.status = "downloaded".into();
        }
        agg.files_updated += r.files_updated;
        agg.files_created += r.files_created;
        agg.files_deleted += r.files_deleted;
        agg.files_merged += r.files_merged;
        agg.conflicts_auto_resolved += r.conflicts_auto_resolved;
        agg.messages.extend(r.messages.clone());
    }
    agg
}

fn aggregate_upload_results(results: &[UploadResult]) -> UploadResult {
    let mut agg = UploadResult {
        status: "no_changes".into(),
        files_uploaded: 0,
        files_merged: 0,
        files_deleted: 0,
        conflicts_auto_resolved: 0,
        retries: 0,
        messages: vec![],
    };
    for r in results {
        if r.status == "uploaded" {
            agg.status = "uploaded".into();
        }
        agg.files_uploaded += r.files_uploaded;
        agg.files_merged += r.files_merged;
        agg.files_deleted += r.files_deleted;
        agg.conflicts_auto_resolved += r.conflicts_auto_resolved;
        agg.retries += r.retries;
        agg.messages.extend(r.messages.clone());
    }
    agg
}

// --- Output formatters ---

fn print_download_result(result: &DownloadResult, json_output: bool) -> Result<()> {
    if json_output {
        return print_json(result);
    }

    let total = result.files_created + result.files_updated + result.files_merged + result.files_deleted;
    if total == 0 {
        if result.status == "up_to_date" {
            println!("Already up to date.");
        } else {
            println!("No changes.");
        }
        return Ok(());
    }

    println!();
    let mut parts = Vec::new();
    if result.files_created > 0 {
        parts.push(format!("{} added", result.files_created));
    }
    if result.files_updated > 0 {
        parts.push(format!("{} modified", result.files_updated));
    }
    if result.files_merged > 0 {
        parts.push(format!("{} merged", result.files_merged));
    }
    if result.files_deleted > 0 {
        parts.push(format!("{} deleted", result.files_deleted));
    }
    if !parts.is_empty() {
        println!("{}", parts.join(", "));
    }

    for msg in &result.messages {
        println!("Warning: {}", msg);
    }

    Ok(())
}

fn print_upload_result(result: &UploadResult, json_output: bool) -> Result<()> {
    if json_output {
        return print_json(result);
    }

    if result.status == "no_changes" {
        println!("No local changes to upload.");
        return Ok(());
    }
    if result.status == "up_to_date" {
        println!("Remote already has all local changes.");
        return Ok(());
    }

    let total = result.files_uploaded + result.files_merged + result.files_deleted;
    if total == 0 {
        println!("No changes.");
        return Ok(());
    }

    println!();
    let mut parts = Vec::new();
    if result.files_uploaded > 0 {
        parts.push(format!("{} uploaded", result.files_uploaded));
    }
    if result.files_merged > 0 {
        parts.push(format!("{} merged", result.files_merged));
    }
    if result.files_deleted > 0 {
        parts.push(format!("{} deleted", result.files_deleted));
    }
    if !parts.is_empty() {
        println!("{}", parts.join(", "));
    }

    for msg in &result.messages {
        println!("Warning: {}", msg);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn make_map(entries: &[(&str, &[u8])]) -> merge::FileMap {
        entries.iter().map(|(k, v)| (k.to_string(), v.to_vec())).collect()
    }

    // ---- file_map_equal ----

    #[test]
    fn file_map_equal_same() {
        let a = make_map(&[("a.txt", b"hello"), ("b.txt", b"world")]);
        let b = make_map(&[("a.txt", b"hello"), ("b.txt", b"world")]);
        assert!(file_map_equal(&a, &b));
    }

    #[test]
    fn file_map_equal_empty() {
        assert!(file_map_equal(&make_map(&[]), &make_map(&[])));
    }

    #[test]
    fn file_map_not_equal_different_content() {
        assert!(!file_map_equal(
            &make_map(&[("a.txt", b"hello")]),
            &make_map(&[("a.txt", b"world")]),
        ));
    }

    #[test]
    fn file_map_not_equal_different_keys() {
        assert!(!file_map_equal(
            &make_map(&[("a.txt", b"hello")]),
            &make_map(&[("b.txt", b"hello")]),
        ));
    }

    #[test]
    fn file_map_not_equal_different_lengths() {
        assert!(!file_map_equal(
            &make_map(&[("a.txt", b"hello")]),
            &make_map(&[("a.txt", b"hello"), ("b.txt", b"extra")]),
        ));
    }

    // ---- disk_to_file_map ----

    #[test]
    fn disk_to_file_map_reads_files() {
        let dir = tmp_dir();
        fs::write(dir.path().join("hello.txt"), b"hello").unwrap();
        fs::write(dir.path().join("world.txt"), b"world").unwrap();
        let map = disk_to_file_map(dir.path()).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("hello.txt").unwrap(), b"hello");
        assert_eq!(map.get("world.txt").unwrap(), b"world");
    }

    #[test]
    fn disk_to_file_map_skips_git_dir() {
        let dir = tmp_dir();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git").join("HEAD"), b"ref").unwrap();
        fs::write(dir.path().join("file.txt"), b"content").unwrap();
        let map = disk_to_file_map(dir.path()).unwrap();
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("file.txt"));
    }

    #[test]
    fn disk_to_file_map_skips_scratchmd() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".scratchmd"), b"marker").unwrap();
        fs::write(dir.path().join("file.txt"), b"content").unwrap();
        let map = disk_to_file_map(dir.path()).unwrap();
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn disk_to_file_map_skips_schema_json() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".schema.json"), b"{}").unwrap();
        fs::write(dir.path().join("file.txt"), b"content").unwrap();
        let map = disk_to_file_map(dir.path()).unwrap();
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn disk_to_file_map_reads_subdirs() {
        let dir = tmp_dir();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("nested.txt"), b"nested").unwrap();
        fs::write(dir.path().join("root.txt"), b"root").unwrap();
        let map = disk_to_file_map(dir.path()).unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("subdir/nested.txt"));
        assert!(map.contains_key("root.txt"));
    }

    #[test]
    fn disk_to_file_map_empty_dir() {
        let dir = tmp_dir();
        assert!(disk_to_file_map(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn disk_to_file_map_normalizes_crlf() {
        let dir = tmp_dir();
        fs::write(dir.path().join("crlf.txt"), b"a\r\nb\r\n").unwrap();
        let map = disk_to_file_map(dir.path()).unwrap();
        assert_eq!(map.get("crlf.txt").unwrap(), b"a\nb\n");
    }

    // ---- stash_markers / restore_markers ----

    #[test]
    fn stash_and_restore_markers() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".scratchmd"), b"root marker").unwrap();
        let subfolder = dir.path().join("Posts");
        fs::create_dir(&subfolder).unwrap();
        fs::write(subfolder.join(".scratchmd"), b"folder marker").unwrap();
        // .git should be skipped
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git").join(".scratchmd"), b"skip").unwrap();

        let mut stash = HashMap::new();
        stash_markers(dir.path(), &mut stash);
        assert_eq!(stash.len(), 2);
        assert_eq!(stash.get(".scratchmd").unwrap(), b"root marker");
        assert_eq!(stash.get("Posts/.scratchmd").unwrap(), b"folder marker");

        // Delete and restore
        fs::remove_file(dir.path().join(".scratchmd")).unwrap();
        fs::remove_file(subfolder.join(".scratchmd")).unwrap();
        restore_markers(dir.path(), &stash);
        assert_eq!(fs::read(dir.path().join(".scratchmd")).unwrap(), b"root marker");
        assert_eq!(fs::read(subfolder.join(".scratchmd")).unwrap(), b"folder marker");
    }

    // ---- find_connector_directories ----

    #[test]
    fn find_connector_dirs_valid() {
        let dir = tmp_dir();
        let conn = dir.path().join("AIRTABLE - Base");
        fs::create_dir(&conn).unwrap();
        fs::write(conn.join(".scratchmd"), "workbook:\n  id: wb1\nconnector:\n  id: c1\n").unwrap();
        fs::create_dir(conn.join(".git")).unwrap();
        assert_eq!(find_connector_directories(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn find_connector_dirs_empty() {
        assert!(find_connector_directories(tmp_dir().path()).unwrap().is_empty());
    }

    #[test]
    fn find_connector_dirs_skips_no_git() {
        let dir = tmp_dir();
        let conn = dir.path().join("conn");
        fs::create_dir(&conn).unwrap();
        fs::write(conn.join(".scratchmd"), "workbook:\n  id: wb1\nconnector:\n  id: c1\n").unwrap();
        assert!(find_connector_directories(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn find_connector_dirs_skips_no_connector_key() {
        let dir = tmp_dir();
        let conn = dir.path().join("notconn");
        fs::create_dir(&conn).unwrap();
        fs::write(conn.join(".scratchmd"), "workbook:\n  id: wb1\n  name: WB\n").unwrap();
        fs::create_dir(conn.join(".git")).unwrap();
        assert!(find_connector_directories(dir.path()).unwrap().is_empty());
    }

    // ---- aggregate results ----

    #[test]
    fn aggregate_download_all_up_to_date() {
        let agg = aggregate_download_results(&[DownloadResult::up_to_date(), DownloadResult::up_to_date()]);
        assert_eq!(agg.status, "up_to_date");
        assert_eq!(agg.files_updated, 0);
    }

    #[test]
    fn aggregate_download_mixed_status() {
        let results = vec![
            DownloadResult { status: "downloaded".into(), files_updated: 2, files_created: 1,
                files_deleted: 0, files_merged: 1, conflicts_auto_resolved: 1, messages: vec!["w".into()] },
            DownloadResult::up_to_date(),
        ];
        let agg = aggregate_download_results(&results);
        assert_eq!(agg.status, "downloaded");
        assert_eq!(agg.files_updated, 2);
        assert_eq!(agg.files_created, 1);
        assert_eq!(agg.files_merged, 1);
        assert_eq!(agg.messages.len(), 1);
    }

    #[test]
    fn aggregate_upload_all_no_changes() {
        let r = || UploadResult { status: "no_changes".into(), files_uploaded: 0, files_merged: 0,
            files_deleted: 0, conflicts_auto_resolved: 0, retries: 0, messages: vec![] };
        assert_eq!(aggregate_upload_results(&[r(), r()]).status, "no_changes");
    }

    #[test]
    fn aggregate_upload_mixed_status() {
        let results = vec![
            UploadResult { status: "uploaded".into(), files_uploaded: 3, files_merged: 1,
                files_deleted: 0, conflicts_auto_resolved: 1, retries: 1, messages: vec!["m".into()] },
            UploadResult { status: "no_changes".into(), files_uploaded: 0, files_merged: 0,
                files_deleted: 2, conflicts_auto_resolved: 0, retries: 0, messages: vec![] },
        ];
        let agg = aggregate_upload_results(&results);
        assert_eq!(agg.status, "uploaded");
        assert_eq!(agg.files_uploaded, 3);
        assert_eq!(agg.files_deleted, 2);
        assert_eq!(agg.retries, 1);
    }

    // ---- merge_file_content ----

    #[test]
    fn merge_text_files() {
        let base = b"line1\nline2\nline3";
        let local = b"line1\nlocal\nline3";
        assert_eq!(merge_file_content(Some(base), Some(local), Some(base)), local.to_vec());
    }

    #[test]
    fn merge_binary_local_wins() {
        let local = b"local\x00data";
        let remote = b"remote\x00data";
        assert_eq!(merge_file_content(Some(b"b\x00"), Some(local), Some(remote)), local.to_vec());
    }

    #[test]
    fn merge_binary_no_local_remote_wins() {
        let remote = b"remote\x00data";
        assert_eq!(merge_file_content(None, None, Some(remote)), remote.to_vec());
    }

    // ---- Marker parsing ----

    #[test]
    fn load_workbook_marker_full_v1() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".scratchmd"),
            "version: \"1\"\nworkbook:\n  id: wb_1\n  serverUrl: http://localhost:3010\n").unwrap();
        let m = load_workbook_marker_full(dir.path()).unwrap();
        assert_eq!(m.workbook.id, "wb_1");
        assert_eq!(m.version, Some("1".into()));
    }

    #[test]
    fn load_workbook_marker_full_v2() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".scratchmd"),
            "version: \"2\"\nworkbook:\n  id: wb_2\n  serverUrl: https://api.scratch.md\n").unwrap();
        let m = load_workbook_marker_full(dir.path()).unwrap();
        assert_eq!(m.version, Some("2".into()));
    }

    #[test]
    fn load_workbook_marker_full_no_file_fails() {
        assert!(load_workbook_marker_full(tmp_dir().path()).is_err());
    }

    // ---- find_workbook_marker_dir_upward ----

    #[test]
    fn find_wb_dir_current() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".scratchmd"), "workbook:\n  id: wb1\n").unwrap();
        let (d, m) = find_workbook_marker_dir_upward(dir.path()).unwrap();
        assert_eq!(d, dir.path());
        assert_eq!(m.workbook.id, "wb1");
    }

    #[test]
    fn find_wb_dir_skips_connector_marker() {
        let dir = tmp_dir();
        fs::write(dir.path().join(".scratchmd"), "workbook:\n  id: wb1\n").unwrap();
        let child = dir.path().join("conn");
        fs::create_dir(&child).unwrap();
        fs::write(child.join(".scratchmd"), "workbook:\n  id: wb1\nconnector:\n  id: c1\n").unwrap();
        let (d, _) = find_workbook_marker_dir_upward(&child).unwrap();
        assert_eq!(d, dir.path()); // should find parent, not connector dir
    }

    #[test]
    fn find_wb_dir_not_found() {
        assert!(find_workbook_marker_dir_upward(tmp_dir().path()).is_none());
    }

    // ---- JSON serialization ----

    #[test]
    fn download_result_json_camel_case() {
        let r = DownloadResult { status: "downloaded".into(), files_updated: 1, files_created: 2,
            files_deleted: 3, files_merged: 4, conflicts_auto_resolved: 5, messages: vec![] };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["filesUpdated"], 1);
        assert_eq!(j["filesCreated"], 2);
        assert_eq!(j["conflictsAutoResolved"], 5);
    }

    #[test]
    fn upload_result_json_camel_case() {
        let r = UploadResult { status: "uploaded".into(), files_uploaded: 1, files_merged: 2,
            files_deleted: 3, conflicts_auto_resolved: 4, retries: 5, messages: vec![] };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["filesUploaded"], 1);
        assert_eq!(j["retries"], 5);
    }
}
