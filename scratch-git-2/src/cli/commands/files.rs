use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Subcommand;

use crate::config::markers;

type FileMap = HashMap<String, Vec<u8>>;

#[derive(Subcommand)]
pub enum FilesCommands {
    /// Download remote changes and three-way merge with local edits
    Download,
    /// Upload local changes to the server
    Upload,
    /// Force-push local state to the server, skipping merge (fast)
    #[command(name = "force-upload")]
    ForceUpload,
}

pub async fn run(cmd: FilesCommands, server_url: &str, json: bool) -> anyhow::Result<()> {
    // Find the workspace/connector from the current directory
    let cwd = std::env::current_dir()?;

    match cmd {
        FilesCommands::Download => run_download(&cwd, server_url, json),
        FilesCommands::Upload => run_upload(&cwd, server_url, json),
        FilesCommands::ForceUpload => run_force_upload(&cwd, server_url, json),
    }
}

fn get_token(server_url: &str) -> anyhow::Result<String> {
    let creds = crate::config::credentials::get(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd2 auth login` first."))?;
    if creds.api_token.is_empty() {
        anyhow::bail!("Not authenticated. Run `scratchmd2 auth login` first.");
    }
    Ok(creds.api_token)
}

fn run_download(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let token = get_token(server_url)?;

    // Check if we're inside a connector subdirectory
    if let Some((markers::Marker::Connector(_), conn_dir)) = markers::find_nearest(cwd) {
        let result = download_single_repo(&conn_dir, &token)?;
        return print_download_result(&result, started.elapsed().as_millis(), json);
    }

    // Find workspace marker
    let (marker, wb_dir) = markers::find_nearest(cwd)
        .ok_or_else(|| anyhow::anyhow!(
            "Not inside a workspace directory. Run from a workspace directory."
        ))?;

    let workbook_server_url = match &marker {
        markers::Marker::Workspace(m) if !m.workbook.server_url.is_empty() => {
            m.workbook.server_url.clone()
        }
        _ => server_url.to_string(),
    };
    let token = get_token(&workbook_server_url)?;

    // Find connector subdirectories (V2) or treat as V1
    let conn_dirs = find_connector_dirs(&wb_dir);
    if conn_dirs.is_empty() {
        // V1: workspace dir is the repo
        let result = download_single_repo(&wb_dir, &token)?;
        print_download_result(&result, started.elapsed().as_millis(), json)
    } else {
        // V2: iterate connector dirs
        let mut results = Vec::new();
        for dir in &conn_dirs {
            if !json {
                println!("Downloading {}...", dir.file_name().unwrap_or_default().to_string_lossy());
            }
            results.push(download_single_repo(dir, &token)?);
            // Update master worktree and rebuild index
            let conn_dir_name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            if update_master_worktree(dir, &wb_dir, &conn_dir_name, &token).is_ok() {
                rebuild_index_for_conn(&wb_dir, &conn_dir_name, json);
            }
        }
        let agg = aggregate_download(&results);

        // Refresh docs after download
        if let markers::Marker::Workspace(m) = &marker {
            let wb_name = if m.workbook.name.is_empty() { m.workbook.id.as_str() } else { m.workbook.name.as_str() };
            let _ = super::generate_docs::write_docs(&wb_dir, wb_name);
        }

        print_download_result(&agg, started.elapsed().as_millis(), json)
    }
}

fn run_upload(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let token = get_token(server_url)?;

    if let Some((markers::Marker::Connector(_), conn_dir)) = markers::find_nearest(cwd) {
        let result = upload_single_repo(&conn_dir, &token)?;
        return print_upload_result(&result, started.elapsed().as_millis(), json);
    }

    let (marker, wb_dir) = markers::find_nearest(cwd)
        .ok_or_else(|| anyhow::anyhow!(
            "Not inside a workspace directory. Run from a workspace directory."
        ))?;

    let workbook_server_url = match &marker {
        markers::Marker::Workspace(m) if !m.workbook.server_url.is_empty() => {
            m.workbook.server_url.clone()
        }
        _ => server_url.to_string(),
    };
    let token = get_token(&workbook_server_url)?;

    let conn_dirs = find_connector_dirs(&wb_dir);
    if conn_dirs.is_empty() {
        let result = upload_single_repo(&wb_dir, &token)?;
        print_upload_result(&result, started.elapsed().as_millis(), json)
    } else {
        let mut results = Vec::new();
        for dir in &conn_dirs {
            if !json {
                println!("Uploading {}...", dir.file_name().unwrap_or_default().to_string_lossy());
            }
            results.push(upload_single_repo(dir, &token)?);
        }
        let agg = aggregate_upload(&results);
        print_upload_result(&agg, started.elapsed().as_millis(), json)
    }
}

fn run_force_upload(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let token = get_token(server_url)?;

    if let Some((markers::Marker::Connector(_), conn_dir)) = markers::find_nearest(cwd) {
        let pushed = force_upload_single_repo(&conn_dir, &token)?;
        let elapsed = started.elapsed().as_millis();
        if json {
            println!("{}", serde_json::json!({ "pushed": pushed, "elapsedMs": elapsed }));
        } else if pushed {
            println!("Force-pushed. ({})", format_elapsed(elapsed));
        } else {
            println!("Nothing to push. ({})", format_elapsed(elapsed));
        }
        return Ok(());
    }

    let (marker, wb_dir) = markers::find_nearest(cwd)
        .ok_or_else(|| anyhow::anyhow!(
            "Not inside a workspace directory. Run from a workspace directory."
        ))?;

    let workbook_server_url = match &marker {
        markers::Marker::Workspace(m) if !m.workbook.server_url.is_empty() => {
            m.workbook.server_url.clone()
        }
        _ => server_url.to_string(),
    };
    let token = get_token(&workbook_server_url)?;

    let conn_dirs = find_connector_dirs(&wb_dir);
    let dirs: Vec<_> = if conn_dirs.is_empty() { vec![wb_dir.clone()] } else { conn_dirs };

    let mut any_pushed = false;
    for dir in &dirs {
        if !json {
            println!("Force-uploading {}...", dir.file_name().unwrap_or_default().to_string_lossy());
        }
        if force_upload_single_repo(dir, &token)? {
            any_pushed = true;
        }
    }

    let elapsed = started.elapsed().as_millis();
    if json {
        println!("{}", serde_json::json!({ "pushed": any_pushed, "elapsedMs": elapsed }));
    } else if any_pushed {
        println!("Force-pushed. ({})", format_elapsed(elapsed));
    } else {
        println!("Nothing to push. ({})", format_elapsed(elapsed));
    }
    Ok(())
}

/// Stage all local changes and force-push to the dirty branch.
/// Returns true if anything was pushed, false if there were no local changes.
fn force_upload_single_repo(repo_dir: &Path, token: &str) -> anyhow::Result<bool> {
    ensure_local_excludes(repo_dir);
    git_add_all(repo_dir)?;

    // Check if there's anything staged
    let status = Command::new("git")
        .current_dir(repo_dir)
        .args(["diff", "--cached", "--quiet"])
        .status()?;
    if status.success() {
        return Ok(false); // nothing staged
    }

    git_commit(repo_dir, "Force-upload from Scratch CLI")?;

    let auth = git_auth_args(token);
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(&auth)
        .args(["push", "--force", "origin", "dirty:dirty"])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git push --force failed: {}", stderr);
    }
    Ok(true)
}

/// Public entry point called by linked/syncs commands after API operations.
/// Finds and downloads all repos for a workbook.
pub async fn download_workbook(_base_url: &str, token: &str, workbook_id: &str) -> anyhow::Result<()> {
    // Try to find the workspace directory
    let wb_dir = crate::config::find_workspace_dir(workbook_id);
    let Some(wb_dir) = wb_dir else {
        // Workspace not initialized locally — skip download silently
        eprintln!("(Workspace not initialized locally — skipping file download)");
        return Ok(());
    };

    let conn_dirs = find_connector_dirs(&wb_dir);
    if conn_dirs.is_empty() {
        download_single_repo(&wb_dir, token)?;
        // V1: no master worktree / index support
    } else {
        for dir in &conn_dirs {
            download_single_repo(dir, token)?;
            let conn_dir_name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            if update_master_worktree(dir, &wb_dir, &conn_dir_name, token).is_ok() {
                rebuild_index_for_conn(&wb_dir, &conn_dir_name, false);
            }
        }
    }
    Ok(())
}

// ── Core git + merge operations ─────────────────────────────────────────────

#[derive(Default)]
struct DownloadResult {
    status: String,
    files_created: i32,
    files_updated: i32,
    files_deleted: i32,
    files_merged: i32,
    conflicts_auto_resolved: i32,
    messages: Vec<String>,
}

#[derive(Default)]
struct UploadResult {
    status: String,
    files_uploaded: i32,
    files_merged: i32,
    files_deleted: i32,
    conflicts_auto_resolved: i32,
    retries: i32,
    messages: Vec<String>,
    uploaded_paths: Vec<String>,
    merged_paths: Vec<String>,
    deleted_paths: Vec<String>,
}

fn download_single_repo(repo_dir: &Path, token: &str) -> anyhow::Result<DownloadResult> {
    ensure_local_excludes(repo_dir);
    // Fetch remote dirty branch
    git_fetch(repo_dir, token)?;

    let base_hash = git_rev_parse(repo_dir, "HEAD")?;
    let remote_hash = git_rev_parse(repo_dir, "refs/remotes/origin/dirty")?;

    if base_hash == remote_hash {
        return Ok(DownloadResult { status: "up_to_date".to_string(), ..Default::default() });
    }

    let base_map = read_git_tree(repo_dir, &base_hash)?;
    let remote_map = read_git_tree(repo_dir, &remote_hash)?;
    let local_map = read_disk(repo_dir)?;

    let actions = compute_merge_actions(&base_map, &local_map, &remote_map);

    let mut stash: FileMap = HashMap::new();
    let mut deletions: Vec<String> = Vec::new();
    let mut result = DownloadResult { status: "downloaded".to_string(), ..Default::default() };

    for act in &actions {
        match act {
            MergeAction::KeepLocal { path, content, .. } => {
                if let Some(c) = content {
                    stash.insert(path.clone(), c.clone());
                }
            }
            MergeAction::WriteRemote { content, .. } => {
                if content.is_some() {
                    // will be written after reset
                } else {
                    // remote deletion handled below
                }
                if let Some(base) = base_map.get(act.path()) {
                    let _ = base; // already existed
                    result.files_updated += 1;
                } else {
                    result.files_created += 1;
                }
            }
            MergeAction::Delete { path, warning } => {
                result.files_deleted += 1;
                deletions.push(path.clone());
                if let Some(w) = warning {
                    result.messages.push(w.clone());
                }
            }
            MergeAction::Merge { path, base, local, remote } => {
                let merged = merge_content(path, Some(base), Some(local), Some(remote));
                stash.insert(path.clone(), merged);
                result.files_merged += 1;
                result.conflicts_auto_resolved += 1;
            }
        }
    }

    // Stash .scratchmd markers before reset
    stash_markers(repo_dir, &mut stash);

    // Reset to remote state
    git_reset_hard(repo_dir, &remote_hash)?;

    // Restore stashed local files (merged content + markers)
    for (rel_path, content) in &stash {
        let full = repo_dir.join(rel_path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&full, content)?;
    }

    // Delete files that should be deleted (not in stash)
    for rel_path in &deletions {
        if !stash.contains_key(rel_path) {
            let _ = std::fs::remove_file(repo_dir.join(rel_path));
        }
    }

    Ok(result)
}

fn upload_single_repo(repo_dir: &Path, token: &str) -> anyhow::Result<UploadResult> {
    ensure_local_excludes(repo_dir);
    let base_hash = git_rev_parse(repo_dir, "HEAD")?;
    let base_map = read_git_tree(repo_dir, &base_hash)?;
    let local_map = read_disk(repo_dir)?;

    if maps_equal(&base_map, &local_map) {
        return Ok(UploadResult { status: "no_changes".to_string(), ..Default::default() });
    }

    const MAX_RETRIES: i32 = 5;
    for attempt in 0..MAX_RETRIES {
        git_fetch(repo_dir, token)?;
        let remote_hash = git_rev_parse(repo_dir, "refs/remotes/origin/dirty")?;
        let remote_map = read_git_tree(repo_dir, &remote_hash)?;

        let actions = compute_merge_actions(&base_map, &local_map, &remote_map);

        let mut merged: FileMap = HashMap::new();
        let mut messages: Vec<String> = Vec::new();
        let mut result = UploadResult {
            status: "uploaded".to_string(),
            retries: attempt,
            ..Default::default()
        };

        for act in &actions {
            match act {
                MergeAction::KeepLocal { path, content, warning } => {
                    if let Some(c) = content {
                        merged.insert(path.clone(), c.clone());
                        let remote_content = remote_map.get(path.as_str());
                        if remote_content.map(|r| r != c).unwrap_or(true) {
                            result.files_uploaded += 1;
                            result.uploaded_paths.push(path.clone());
                        }
                    }
                    if let Some(w) = warning {
                        messages.push(w.clone());
                    }
                }
                MergeAction::WriteRemote { path, content } => {
                    if let Some(c) = content {
                        merged.insert(path.clone(), c.clone());
                    }
                }
                MergeAction::Delete { path, warning } => {
                    if remote_map.contains_key(path.as_str()) {
                        result.files_deleted += 1;
                        result.deleted_paths.push(path.clone());
                    }
                    if let Some(w) = warning {
                        messages.push(w.clone());
                    }
                }
                MergeAction::Merge { path, base, local, remote } => {
                    let m = merge_content(path, Some(base), Some(local), Some(remote));
                    merged.insert(path.clone(), m);
                    result.files_merged += 1;
                    result.merged_paths.push(path.clone());
                    result.conflicts_auto_resolved += 1;
                }
            }
        }

        // Strip server-managed .scratch/ subdirs, but keep publish-plans/ so the
        // server can read the plan from git after `files upload`.
        merged.retain(|p, _| {
            !p.starts_with(".scratch/") || p.starts_with(".scratch/publish-plans/")
        });

        if maps_equal(&merged, &remote_map) {
            return Ok(UploadResult { status: "up_to_date".to_string(), ..Default::default() });
        }

        // Stash markers, reset to remote, write merged, commit, push
        let mut marker_stash: FileMap = HashMap::new();
        stash_markers(repo_dir, &mut marker_stash);

        git_reset_hard(repo_dir, &remote_hash)?;

        // Write merged files (skip files identical to remote)
        for (rel_path, content) in &merged {
            if remote_map.get(rel_path.as_str()).map(|r| r == content).unwrap_or(false) {
                continue;
            }
            let full = repo_dir.join(rel_path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&full, content)?;
        }

        // Remove files present in remote but not in merged
        for rel_path in remote_map.keys() {
            if rel_path.starts_with(".scratch/") {
                continue;
            }
            if !merged.contains_key(rel_path.as_str()) {
                let _ = std::fs::remove_file(repo_dir.join(rel_path));
            }
        }

        // Restore markers
        for (rel_path, content) in &marker_stash {
            let full = repo_dir.join(rel_path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let _ = std::fs::write(&full, content);
        }

        git_add_all(repo_dir)?;
        git_commit(repo_dir, "Upload from Scratch CLI")?;

        match git_push(repo_dir, token) {
            Ok(()) => {
                result.messages = messages;
                return Ok(result);
            }
            Err(e) => {
                // Check if it's a non-fast-forward error
                if e.to_string().contains("non-fast-forward") || e.to_string().contains("rejected") {
                    // Restore markers and retry
                    for (rel_path, content) in &marker_stash {
                        let _ = std::fs::write(repo_dir.join(rel_path), content);
                    }
                    continue;
                }
                return Err(e);
            }
        }
    }

    anyhow::bail!("Upload failed after {} attempts due to concurrent changes on the server", MAX_RETRIES)
}

// ── Git subprocess helpers ───────────────────────────────────────────────────

fn git_auth_args(token: &str) -> [String; 2] {
    ["-c".to_string(), format!("http.extraHeader=Authorization: API-Token {}", token)]
}

fn git_fetch(repo_dir: &Path, token: &str) -> anyhow::Result<()> {
    let auth = git_auth_args(token);
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(&auth)
        .args(["fetch", "origin", "refs/heads/dirty:refs/remotes/origin/dirty", "--force"])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git fetch failed: {}", stderr);
    }
    Ok(())
}

fn git_rev_parse(repo_dir: &Path, rev: &str) -> anyhow::Result<String> {
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(["rev-parse", rev])
        .output()?;
    if !output.status.success() {
        anyhow::bail!("git rev-parse {} failed", rev);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_reset_hard(repo_dir: &Path, hash: &str) -> anyhow::Result<()> {
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(["reset", "--hard", hash])
        .output()?;
    if !output.status.success() {
        anyhow::bail!("git reset --hard failed");
    }
    Ok(())
}

/// Ensure .scratchmd is listed in .git/info/exclude so git never tracks it.
/// This is a per-clone local exclude — never committed or pushed.
pub fn ensure_local_excludes(repo_dir: &Path) {
    let exclude_path = repo_dir.join(".git/info/exclude");
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    if !existing.lines().any(|l| l.trim() == ".scratchmd") {
        let mut content = existing;
        if !content.ends_with('\n') && !content.is_empty() {
            content.push('\n');
        }
        content.push_str(".scratchmd\n");
        let _ = std::fs::write(&exclude_path, content);
    }
}

fn git_add_all(repo_dir: &Path) -> anyhow::Result<()> {
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(["add", "-A"])
        .output()?;
    if !output.status.success() {
        anyhow::bail!("git add -A failed");
    }
    Ok(())
}

fn git_commit(repo_dir: &Path, message: &str) -> anyhow::Result<()> {
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args([
            "-c", "user.name=Scratch CLI",
            "-c", "user.email=cli@scratch.md",
            "commit", "-m", message, "--allow-empty",
        ])
        .output()?;
    if !output.status.success() {
        anyhow::bail!("git commit failed");
    }
    Ok(())
}

fn git_push(repo_dir: &Path, token: &str) -> anyhow::Result<()> {
    let auth = git_auth_args(token);
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(&auth)
        .args(["push", "origin", "dirty:dirty"])
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git push failed: {}", stderr);
    }
    Ok(())
}

// ── Reading git trees ────────────────────────────────────────────────────────

/// Read all files from a commit tree into a FileMap.
/// Uses `git cat-file --batch` to fetch all blob contents in a single subprocess
/// instead of one subprocess per file.
fn read_git_tree(repo_dir: &Path, hash: &str) -> anyhow::Result<FileMap> {
    let ls_output = Command::new("git")
        .current_dir(repo_dir)
        .args(["ls-tree", "-r", hash])
        .output()?;

    if !ls_output.status.success() {
        return Ok(HashMap::new());
    }

    // Collect (path, blob_hash) pairs
    let stdout = String::from_utf8_lossy(&ls_output.stdout);
    let mut entries: Vec<(String, String)> = Vec::new();
    for line in stdout.lines() {
        // Format: "100644 blob <blob-hash>\t<path>"
        if let Some((info, path)) = line.split_once('\t') {
            let parts: Vec<&str> = info.split_whitespace().collect();
            if parts.len() >= 3 && parts[1] == "blob" {
                entries.push((path.to_string(), parts[2].to_string()));
            }
        }
    }

    if entries.is_empty() {
        return Ok(HashMap::new());
    }

    // Batch-read all blobs in a single subprocess via stdin/stdout
    use std::io::Write as _;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .current_dir(repo_dir)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;

    let hashes: String = entries.iter().map(|(_, h)| format!("{}\n", h)).collect();
    child.stdin.take().unwrap().write_all(hashes.as_bytes())?;

    let batch_output = child.wait_with_output()?;
    let data = batch_output.stdout;

    // Parse batch output: "<hash> blob <size>\n<content>\n" per entry
    let mut map = FileMap::new();
    let mut cursor = 0usize;
    for (path, _) in &entries {
        let header_end = data[cursor..].iter().position(|&b| b == b'\n')
            .ok_or_else(|| anyhow::anyhow!("unexpected git cat-file batch output"))?;
        let header = std::str::from_utf8(&data[cursor..cursor + header_end])?;
        cursor += header_end + 1;

        let size: usize = header.split_whitespace()
            .nth(2)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow::anyhow!("invalid batch header: {}", header))?;

        let content = normalize_crlf(data[cursor..cursor + size].to_vec());
        cursor += size + 1; // +1 for trailing newline after content
        map.insert(path.clone(), content);
    }

    Ok(map)
}

// ── Reading local disk ───────────────────────────────────────────────────────

/// Read all local files into a FileMap, skipping .git, .scratchmd, and dotfiles.
fn read_disk(root: &Path) -> anyhow::Result<FileMap> {
    let mut map = FileMap::new();
    walk_disk(root, root, &mut map)?;
    Ok(map)
}

fn walk_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            match name_str.as_ref() {
                ".git" | "syncs" => continue,
                n if n.starts_with('.') && n != ".scratch" => continue,
                _ => walk_disk(root, &entry.path(), map)?,
            }
        } else if ft.is_file() {
            // Skip dotfiles (but .scratch/ contents are not dotfiles themselves)
            if name_str.starts_with('.') {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy().to_string();
            let content = std::fs::read(entry.path())?;
            let content = normalize_crlf(content);
            map.insert(rel, content);
        }
    }
    Ok(())
}

// ── Three-way merge ──────────────────────────────────────────────────────────

enum MergeAction {
    KeepLocal { path: String, content: Option<Vec<u8>>, warning: Option<String> },
    WriteRemote { path: String, content: Option<Vec<u8>> },
    Delete { path: String, warning: Option<String> },
    Merge { path: String, base: Vec<u8>, local: Vec<u8>, remote: Vec<u8> },
}

impl MergeAction {
    fn path(&self) -> &str {
        match self {
            Self::KeepLocal { path, .. } => path,
            Self::WriteRemote { path, .. } => path,
            Self::Delete { path, .. } => path,
            Self::Merge { path, .. } => path,
        }
    }
}

fn compute_merge_actions(
    base: &FileMap,
    local: &FileMap,
    remote: &FileMap,
) -> Vec<MergeAction> {
    let mut all_paths: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for k in base.keys() { all_paths.insert(k); }
    for k in local.keys() { all_paths.insert(k); }
    for k in remote.keys() { all_paths.insert(k); }

    let mut actions = Vec::new();

    for path in all_paths {
        let base_c = base.get(path);
        let local_c = local.get(path);
        let remote_c = remote.get(path);

        let local_changed = local_c != base_c;
        let remote_changed = remote_c != base_c;

        if !local_changed {
            // Local unchanged — follow remote
            match remote_c {
                Some(rc) => actions.push(MergeAction::WriteRemote {
                    path: path.to_string(),
                    content: Some(rc.clone()),
                }),
                None if base_c.is_some() => {
                    actions.push(MergeAction::Delete { path: path.to_string(), warning: None });
                }
                None => {} // Not in any tree
            }
        } else if !remote_changed {
            // Remote unchanged — keep local
            match local_c {
                Some(lc) => actions.push(MergeAction::KeepLocal {
                    path: path.to_string(),
                    content: Some(lc.clone()),
                    warning: None,
                }),
                None => {
                    actions.push(MergeAction::Delete { path: path.to_string(), warning: None });
                }
            }
        } else {
            // Both changed
            match (local_c, remote_c) {
                (Some(lc), Some(rc)) => {
                    if let Some(bc) = base_c {
                        actions.push(MergeAction::Merge {
                            path: path.to_string(),
                            base: bc.clone(),
                            local: lc.clone(),
                            remote: rc.clone(),
                        });
                    } else {
                        // Both added — local wins
                        actions.push(MergeAction::KeepLocal {
                            path: path.to_string(),
                            content: Some(lc.clone()),
                            warning: None,
                        });
                    }
                }
                (Some(lc), None) => {
                    // Local changed, remote deleted — keep local with warning
                    actions.push(MergeAction::KeepLocal {
                        path: path.to_string(),
                        content: Some(lc.clone()),
                        warning: Some(format!(
                            "Remote deleted {} but local has changes; keeping local version",
                            path
                        )),
                    });
                }
                (None, Some(rc)) => {
                    // Local deleted, remote changed — write remote
                    actions.push(MergeAction::WriteRemote {
                        path: path.to_string(),
                        content: Some(rc.clone()),
                    });
                }
                (None, None) => {
                    actions.push(MergeAction::Delete { path: path.to_string(), warning: None });
                }
            }
        }
    }
    actions
}

fn merge_content(
    _path: &str,
    base: Option<&Vec<u8>>,
    local: Option<&Vec<u8>>,
    remote: Option<&Vec<u8>>,
) -> Vec<u8> {
    // Binary files — local wins
    if local.map(is_binary).unwrap_or(false) || remote.map(is_binary).unwrap_or(false) {
        return local.or(remote).cloned().unwrap_or_default();
    }

    let base_str = base.map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let local_str = local.map(|l| String::from_utf8_lossy(l).into_owned()).unwrap_or_default();
    let remote_str = remote.map(|r| String::from_utf8_lossy(r).into_owned()).unwrap_or_default();

    match crate::shared::merge::merge_file_contents(&base_str, &local_str, &remote_str) {
        Ok(merged) => merged.into_bytes(),
        Err(_) => local.cloned().unwrap_or_default(),
    }
}

fn is_binary(data: &Vec<u8>) -> bool {
    data.contains(&0u8)
}

fn normalize_crlf(data: Vec<u8>) -> Vec<u8> {
    if !data.contains(&b'\r') {
        return data;
    }
    if is_binary(&data) {
        return data;
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
            // skip CR
        } else {
            out.push(data[i]);
        }
        i += 1;
    }
    out
}

fn maps_equal(a: &FileMap, b: &FileMap) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().all(|(k, v)| b.get(k).map(|bv| bv == v).unwrap_or(false))
}

// ── Marker stashing ──────────────────────────────────────────────────────────

/// Stash .scratchmd files so they survive a git reset --hard.
fn stash_markers(repo_dir: &Path, stash: &mut FileMap) {
    // Root marker
    let root_marker = repo_dir.join(".scratchmd");
    if let Ok(data) = std::fs::read(&root_marker) {
        stash.insert(".scratchmd".to_string(), data);
    }

    // Data folder markers in subdirectories
    if let Ok(entries) = std::fs::read_dir(repo_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.file_name().to_string_lossy() == ".git" {
                continue;
            }
            let marker = entry.path().join(".scratchmd");
            if let Ok(data) = std::fs::read(&marker) {
                let rel = format!("{}/.scratchmd", entry.file_name().to_string_lossy());
                stash.insert(rel, data);
            }
        }
    }
}

// ── Connector directory discovery ────────────────────────────────────────────

/// Find connector subdirectories (V2 workbooks): dirs with a .scratchmd connector marker + .git.
fn find_connector_dirs(wb_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(wb_dir) else { return Vec::new() };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let subdir = entry.path();
        // Must have a connector marker
        let marker_path = subdir.join(".scratchmd");
        let Ok(content) = std::fs::read_to_string(&marker_path) else { continue };
        let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content) else { continue };
        if value.get("connector").is_none() {
            continue;
        }
        // Must have .git
        if subdir.join(".git").exists() {
            dirs.push(subdir);
        }
    }
    dirs
}

// ── Result aggregation and printing ─────────────────────────────────────────

fn aggregate_download(results: &[DownloadResult]) -> DownloadResult {
    let mut agg = DownloadResult { status: "up_to_date".to_string(), ..Default::default() };
    for r in results {
        if r.status == "downloaded" {
            agg.status = "downloaded".to_string();
        }
        agg.files_updated += r.files_updated;
        agg.files_created += r.files_created;
        agg.files_deleted += r.files_deleted;
        agg.files_merged += r.files_merged;
        agg.conflicts_auto_resolved += r.conflicts_auto_resolved;
        agg.messages.extend(r.messages.iter().cloned());
    }
    agg
}

fn aggregate_upload(results: &[UploadResult]) -> UploadResult {
    let mut agg = UploadResult { status: "no_changes".to_string(), ..Default::default() };
    for r in results {
        if r.status == "uploaded" {
            agg.status = "uploaded".to_string();
        }
        agg.files_uploaded += r.files_uploaded;
        agg.files_merged += r.files_merged;
        agg.files_deleted += r.files_deleted;
        agg.conflicts_auto_resolved += r.conflicts_auto_resolved;
        agg.retries += r.retries;
        agg.messages.extend(r.messages.iter().cloned());
        agg.uploaded_paths.extend(r.uploaded_paths.iter().cloned());
        agg.merged_paths.extend(r.merged_paths.iter().cloned());
        agg.deleted_paths.extend(r.deleted_paths.iter().cloned());
    }
    agg
}

fn print_file_list(label: &str, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let _ = label; // label not shown per-file; category is clear from context
    let limit = paths.len().min(10);
    for path in &paths[..limit] {
        println!("  {}", path);
    }
    if paths.len() > 10 {
        println!("  ... and {} more", paths.len() - 10);
    }
}

fn print_download_result(result: &DownloadResult, elapsed_ms: u128, json: bool) -> anyhow::Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": result.status,
                "filesUpdated": result.files_updated,
                "filesCreated": result.files_created,
                "filesDeleted": result.files_deleted,
                "filesMerged": result.files_merged,
                "conflictsAutoResolved": result.conflicts_auto_resolved,
                "messages": result.messages,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    let total =
        result.files_created + result.files_updated + result.files_merged + result.files_deleted;
    let elapsed = format_elapsed(elapsed_ms);
    if total == 0 {
        println!(
            "{} ({})",
            if result.status == "up_to_date" { "Already up to date." } else { "No changes." },
            elapsed
        );
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
    println!("{} ({})", parts.join(", "), elapsed);
    for msg in &result.messages {
        println!("Warning: {}", msg);
    }
    Ok(())
}

fn format_elapsed(ms: u128) -> String {
    if ms < 1000 {
        format!("{}ms", ms)
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

fn print_upload_result(result: &UploadResult, elapsed_ms: u128, json: bool) -> anyhow::Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": result.status,
                "filesUploaded": result.files_uploaded,
                "filesMerged": result.files_merged,
                "filesDeleted": result.files_deleted,
                "conflictsAutoResolved": result.conflicts_auto_resolved,
                "retries": result.retries,
                "messages": result.messages,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    let elapsed = format_elapsed(elapsed_ms);
    if result.status == "no_changes" {
        println!("No local changes to upload. ({})", elapsed);
        return Ok(());
    }
    if result.status == "up_to_date" {
        println!("Remote already has all local changes. ({})", elapsed);
        return Ok(());
    }

    let total = result.files_uploaded + result.files_merged + result.files_deleted;
    if total == 0 {
        println!("No changes. ({})", elapsed);
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
    println!("{} ({})", parts.join(", "), elapsed);
    print_file_list("uploaded", &result.uploaded_paths);
    print_file_list("merged", &result.merged_paths);
    print_file_list("deleted", &result.deleted_paths);
    for msg in &result.messages {
        println!("Warning: {}", msg);
    }
    Ok(())
}

// ── Index rebuild ─────────────────────────────────────────────────────────────

/// Rebuild the SQLite index for one connector after master is updated.
/// Silently skips if master worktree or db parent dir doesn't exist.
pub fn rebuild_index_for_conn(workspace_dir: &Path, conn_dir_name: &str, quiet: bool) {
    let master = crate::shared::index::master_dir(workspace_dir, conn_dir_name);
    if !master.exists() {
        return;
    }
    let db = crate::shared::index::db_path(workspace_dir, conn_dir_name);
    if let Some(parent) = db.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !quiet {
        eprint!("  Rebuilding index for {}... ", conn_dir_name);
    }
    match crate::shared::index::build(&master, &db) {
        Ok(n) => {
            if !quiet {
                eprintln!("{n} file(s)");
            }
        }
        Err(e) => {
            if !quiet {
                eprintln!("warning: index rebuild failed: {e}");
            }
        }
    }
}

// ── Master worktree update ────────────────────────────────────────────────────

/// Pull the master worktree to the latest origin/main.
/// Silently skips if the worktree does not exist yet.
fn update_master_worktree(conn_dir: &Path, workspace_dir: &Path, conn_dir_name: &str, token: &str) -> anyhow::Result<()> {
    let master = crate::shared::index::master_dir(workspace_dir, conn_dir_name);
    if !master.exists() {
        return Ok(());
    }

    // Fetch main from the connector dir (has remote config + auth)
    let auth_header = format!("Authorization: API-Token {}", token);
    let _ = Command::new("git")
        .current_dir(conn_dir)
        .args([
            "-c", &format!("http.extraHeader={}", auth_header),
            "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main",
        ])
        .status();

    // Reset the master worktree to origin/main
    let status = Command::new("git")
        .current_dir(&master)
        .args(["reset", "--hard", "origin/main"])
        .status()?;

    if !status.success() {
        eprintln!("  Warning: could not update master worktree for {}", conn_dir_name);
    }
    Ok(())
}

// ── Path utility ─────────────────────────────────────────────────────────────

trait ToSlashLossy {
    fn to_slash_lossy(&self) -> String;
}

impl ToSlashLossy for Path {
    fn to_slash_lossy(&self) -> String {
        self.to_string_lossy().replace('\\', "/")
    }
}
