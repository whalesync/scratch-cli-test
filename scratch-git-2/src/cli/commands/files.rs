use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use clap::Subcommand;

use crate::config::markers;
use crate::shared::layout::WorkspaceLayout;

type FileMap = HashMap<String, Vec<u8>>;

#[derive(Subcommand)]
pub enum FilesCommands {
    /// Download remote changes and three-way merge with local edits
    Download,
    /// Commit all current working-tree record changes into the local dirty branch
    #[command(name = "accept-all")]
    AcceptAll,
    /// List record changes that exist only in the working tree and have not been accepted locally
    Unreviewed,
    /// Upload local changes to the server
    Upload,
    /// Force-push local state to the server, skipping merge (fast)
    #[command(name = "force-upload")]
    ForceUpload,
}

#[derive(Clone)]
struct ConnectionContext {
    conn_dir_name: String,
    dirty_dir: PathBuf,
    scratch_dir: PathBuf,
    master_dir: PathBuf,
    bare_repo: PathBuf,
    db_path: PathBuf,
}

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

#[derive(Default)]
struct AcceptAllResult {
    files_accepted: i32,
    accepted_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct UnreviewedEntry {
    #[serde(rename = "connectionName")]
    connection_name: String,
    path: String,
    status: String,
}

pub async fn run(cmd: FilesCommands, server_url: &str, json: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;

    match cmd {
        FilesCommands::Download => run_download(&cwd, server_url, json),
        FilesCommands::AcceptAll => run_accept_all(&cwd, server_url, json),
        FilesCommands::Unreviewed => run_unreviewed(&cwd, server_url, json),
        FilesCommands::Upload => run_upload(&cwd, server_url, json),
        FilesCommands::ForceUpload => run_force_upload(&cwd, server_url, json),
    }
}

fn get_token(server_url: &str) -> anyhow::Result<String> {
    let creds = crate::config::credentials::get(server_url)
        .ok_or_else(|| anyhow::anyhow!("Not authenticated. Run `scratchmd auth login` first."))?;
    if creds.api_token.is_empty() {
        anyhow::bail!("Not authenticated. Run `scratchmd auth login` first.");
    }
    Ok(creds.api_token)
}

fn run_download(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (workspace_marker, workspace_dir, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!(
            "No connections found in {}. Run `scratchmd workspaces init` first.",
            workspace_dir.display()
        );
    }

    let mut results = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Downloading {}...", ctx.conn_dir_name);
        }
        results.push(download_single_repo(ctx, &token)?);
        if update_master_worktree(ctx, &token).is_ok() {
            let _ = sync_schema_files_from_master(ctx);
            rebuild_index_for_conn(ctx, json);
        }
    }

    let wb_name = if workspace_marker.workbook.name.is_empty() {
        workspace_marker.workbook.id.as_str()
    } else {
        workspace_marker.workbook.name.as_str()
    };
    let _ = super::generate_docs::write_docs(&workspace_dir, wb_name);

    let result = if results.len() == 1 {
        results.into_iter().next().unwrap_or_default()
    } else {
        aggregate_download(&results)
    };

    print_download_result(&result, started.elapsed().as_millis(), json)
}

fn run_upload(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, _, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut results = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Uploading {}...", ctx.conn_dir_name);
        }
        results.push(upload_single_repo(ctx, &token)?);
    }

    let result = if results.len() == 1 {
        results.into_iter().next().unwrap_or_default()
    } else {
        aggregate_upload(&results)
    };

    print_upload_result(&result, started.elapsed().as_millis(), json)
}

fn run_accept_all(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut results = Vec::new();
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Accepting changes in {}...", ctx.conn_dir_name);
        }
        results.push(accept_all_single_repo(ctx)?);
    }

    let accepted_files: Vec<String> = results
        .iter()
        .flat_map(|result| result.accepted_paths.iter().cloned())
        .collect();
    let total_accepted: i32 = results.iter().map(|result| result.files_accepted).sum();
    let elapsed_ms = started.elapsed().as_millis();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": if total_accepted == 0 { "no_changes" } else { "accepted" },
                "filesAccepted": total_accepted,
                "paths": accepted_files,
                "elapsedMs": elapsed_ms,
            }))?
        );
        return Ok(());
    }

    if total_accepted == 0 {
        println!(
            "No unreviewed local changes to accept. ({})",
            format_elapsed(elapsed_ms)
        );
        return Ok(());
    }

    println!(
        "Accepted {} local record change(s). ({})",
        total_accepted,
        format_elapsed(elapsed_ms)
    );
    print_file_list(&accepted_files);
    Ok(())
}

fn run_unreviewed(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let (_, _, contexts, _) = resolve_workspace_and_connections(cwd, server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut entries = Vec::new();
    for ctx in &contexts {
        entries.extend(unreviewed_entries(ctx)?);
    }
    entries.sort_by(|left, right| {
        left.connection_name
            .cmp(&right.connection_name)
            .then_with(|| left.path.cmp(&right.path))
    });

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "count": entries.len(),
                "entries": entries,
            }))?
        );
        return Ok(());
    }

    if entries.is_empty() {
        println!("No unreviewed local record changes.");
        return Ok(());
    }

    println!("{} unreviewed local record change(s):", entries.len());
    for entry in entries {
        println!(
            "  [{}] {} — {}",
            entry.connection_name, entry.status, entry.path
        );
    }
    Ok(())
}

fn run_force_upload(cwd: &Path, server_url: &str, json: bool) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let (_, _, contexts, workspace_server_url) =
        resolve_workspace_and_connections(cwd, server_url)?;
    let token = get_token(&workspace_server_url)?;

    if contexts.is_empty() {
        anyhow::bail!("No connections found. Run `scratchmd workspaces init` first.");
    }

    let mut any_pushed = false;
    for ctx in &contexts {
        if contexts.len() > 1 && !json {
            println!("Force-uploading {}...", ctx.conn_dir_name);
        }
        if force_upload_single_repo(ctx, &token)? {
            any_pushed = true;
        }
    }

    let elapsed = started.elapsed().as_millis();
    if json {
        println!(
            "{}",
            serde_json::json!({ "pushed": any_pushed, "elapsedMs": elapsed })
        );
    } else if any_pushed {
        println!("Force-pushed. ({})", format_elapsed(elapsed));
    } else {
        println!("Nothing to push. ({})", format_elapsed(elapsed));
    }
    Ok(())
}

pub async fn download_workbook(
    _base_url: &str,
    token: &str,
    workbook_id: &str,
) -> anyhow::Result<()> {
    let Some(workspace_dir) = crate::config::find_workspace_dir(workbook_id) else {
        eprintln!("(Workspace not initialized locally — skipping file download)");
        return Ok(());
    };

    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, None)?;
    for ctx in &contexts {
        download_single_repo(ctx, token)?;
        if update_master_worktree(ctx, token).is_ok() {
            let _ = sync_schema_files_from_master(ctx);
            rebuild_index_for_conn(ctx, true);
        }
    }
    Ok(())
}

fn resolve_workspace_and_connections(
    cwd: &Path,
    server_url: &str,
) -> anyhow::Result<(
    markers::WorkspaceMarker,
    PathBuf,
    Vec<ConnectionContext>,
    String,
)> {
    let workspace_dir = markers::find_nearest_workspace(cwd).ok_or_else(|| {
        anyhow::anyhow!("Not inside a workspace directory. Run from a workspace directory.")
    })?;
    let workspace_marker = read_workspace_marker(&workspace_dir)?;
    let workspace_server_url = if workspace_marker.workbook.server_url.is_empty() {
        server_url.to_string()
    } else {
        workspace_marker.workbook.server_url.clone()
    };
    let contexts = build_connection_contexts(&workspace_dir, &workspace_marker, Some(cwd))?;
    Ok((
        workspace_marker,
        workspace_dir,
        contexts,
        workspace_server_url,
    ))
}

fn read_workspace_marker(workspace_dir: &Path) -> anyhow::Result<markers::WorkspaceMarker> {
    let marker_path = markers::marker_path(workspace_dir);
    match markers::read(&marker_path) {
        Ok(markers::Marker::Workspace(marker)) => Ok(marker),
        _ => anyhow::bail!(
            "Could not read workspace marker at {}",
            marker_path.display()
        ),
    }
}

fn build_connection_contexts(
    workspace_dir: &Path,
    workspace_marker: &markers::WorkspaceMarker,
    cwd_filter: Option<&Path>,
) -> anyhow::Result<Vec<ConnectionContext>> {
    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let selected =
        cwd_filter.and_then(|cwd| detect_selected_connection(workspace_dir, cwd, workspace_marker));

    let contexts = workspace_marker
        .connections
        .iter()
        .filter(|connection| match selected.as_deref() {
            Some(name) => connection.dir_name == name,
            None => true,
        })
        .filter(|connection| !connection.repo_path.is_empty() && !connection.dir_name.is_empty())
        .map(|connection| ConnectionContext {
            conn_dir_name: connection.dir_name.clone(),
            dirty_dir: layout.dirty_checkout_path(&connection.dir_name),
            scratch_dir: layout.connection_scratch_path(&connection.dir_name),
            master_dir: layout.master_worktree_path(&connection.dir_name),
            bare_repo: layout.bare_repo_path(&connection.repo_path),
            db_path: layout.index_db_path(&connection.repo_path),
        })
        .collect();

    Ok(contexts)
}

fn detect_selected_connection(
    workspace_dir: &Path,
    cwd: &Path,
    workspace_marker: &markers::WorkspaceMarker,
) -> Option<String> {
    let rel = cwd.strip_prefix(workspace_dir).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();

    if parts.is_empty() {
        return None;
    }

    let candidate = if parts[0] == ".scratch" && parts.len() >= 4 && parts[1] == "connections" {
        match parts[2].as_str() {
            "scratch" | "master" => Some(parts[3].clone()),
            _ => None,
        }
    } else if parts[0].starts_with('.') {
        None
    } else {
        Some(parts[0].clone())
    }?;

    workspace_marker
        .connections
        .iter()
        .find(|connection| connection.dir_name == candidate)
        .map(|connection| connection.dir_name.clone())
}

fn download_single_repo(ctx: &ConnectionContext, token: &str) -> anyhow::Result<DownloadResult> {
    crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;

    let base_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty")?;
    let remote_hash = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/dirty")?;

    if base_hash == remote_hash {
        return Ok(DownloadResult {
            status: "up_to_date".to_string(),
            ..Default::default()
        });
    }

    let base_map = read_git_tree(&ctx.bare_repo, &base_hash)?;
    let remote_map = read_git_tree(&ctx.bare_repo, &remote_hash)?;
    let local_map = read_materialized_repo(ctx)?;
    let actions = compute_merge_actions(&base_map, &local_map, &remote_map);

    let mut result = DownloadResult {
        status: "downloaded".to_string(),
        ..Default::default()
    };
    let mut target_map = remote_map.clone();

    for act in &actions {
        match act {
            MergeAction::KeepLocal { path, content, .. } => match content {
                Some(content) => {
                    target_map.insert(path.clone(), content.clone());
                }
                None => {
                    target_map.remove(path.as_str());
                }
            },
            MergeAction::WriteRemote { path, content } => {
                if let Some(content) = content {
                    if base_map.contains_key(path.as_str()) {
                        result.files_updated += 1;
                    } else {
                        result.files_created += 1;
                    }
                    target_map.insert(path.clone(), content.clone());
                } else {
                    result.files_deleted += 1;
                    target_map.remove(path.as_str());
                }
            }
            MergeAction::Delete { path, warning } => {
                result.files_deleted += 1;
                target_map.remove(path.as_str());
                if let Some(warning) = warning {
                    result.messages.push(warning.clone());
                }
            }
            MergeAction::Merge {
                path,
                base,
                local,
                remote,
            } => {
                let merged = merge_content(path, Some(base), Some(local), Some(remote));
                target_map.insert(path.clone(), merged);
                result.files_merged += 1;
                result.conflicts_auto_resolved += 1;
            }
        }
    }

    git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &remote_hash)?;
    materialize_local_repo(ctx, &target_map)?;

    Ok(result)
}

fn upload_single_repo(ctx: &ConnectionContext, token: &str) -> anyhow::Result<UploadResult> {
    let base_hash = git_rev_parse(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = read_git_tree(&ctx.bare_repo, &base_hash)?;
    sync_schema_files_from_master(ctx)?;
    let local_unreviewed = unreviewed_entries(ctx)?;
    let local_plan_map = read_local_publish_plan_map(ctx)?;

    if local_unreviewed.is_empty() && local_plan_map.is_empty() {
        crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;
        let remote_hash = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/dirty")?;
        let remote_map = read_git_tree(&ctx.bare_repo, &remote_hash)?;
        if maps_equal(&base_map, &remote_map) {
            return Ok(UploadResult {
                status: "no_changes".to_string(),
                ..Default::default()
            });
        }
    }

    const MAX_RETRIES: i32 = 5;
    for attempt in 0..MAX_RETRIES {
        crate::git_ops::fetch_origin(&ctx.bare_repo, token)?;
        let remote_hash = git_rev_parse(&ctx.bare_repo, "refs/remotes/origin/dirty")?;
        let remote_map = read_git_tree(&ctx.bare_repo, &remote_hash)?;
        let (mut merged, mut result, mut messages) =
            prepare_upload_merge(&base_map, &base_map, &remote_map, attempt);

        strip_publish_plan_files(&mut merged);
        for (path, value) in &local_plan_map {
            merged.insert(path.clone(), value.clone());
        }

        if !local_unreviewed.is_empty() {
            messages.push(format!(
                "{} record(s) have unreviewed local changes and will not be uploaded. Run `scratchmd files accept-all` first.",
                local_unreviewed.len()
            ));
        }

        if maps_equal(&merged, &remote_map) {
            git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &remote_hash)?;
            sync_schema_files_from_master(ctx)?;
            return Ok(UploadResult {
                status: "up_to_date".to_string(),
                messages,
                ..Default::default()
            });
        }

        commit_file_map_to_dirty_ref(
            &ctx.bare_repo,
            Some(remote_hash.as_str()),
            &merged,
            "Upload from Scratch CLI",
        )?;

        match crate::git_ops::push_origin_dirty(&ctx.bare_repo, token) {
            Ok(()) => {
                sync_schema_files_from_master(ctx)?;
                result.messages = messages;
                return Ok(result);
            }
            Err(err) => {
                if err.to_string().contains("non-fast-forward")
                    || err.to_string().contains("rejected")
                {
                    git_update_ref(&ctx.bare_repo, "refs/heads/dirty", &base_hash)?;
                    continue;
                }
                return Err(err);
            }
        }
    }

    anyhow::bail!(
        "Upload failed after {} attempts due to concurrent changes on the server",
        MAX_RETRIES
    )
}

fn accept_all_single_repo(ctx: &ConnectionContext) -> anyhow::Result<AcceptAllResult> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;
    let changes = compute_unreviewed_entries(&ctx.conn_dir_name, &base_map, &local_map);

    if changes.is_empty() {
        return Ok(AcceptAllResult {
            ..Default::default()
        });
    }

    let mut accepted_map = scratch_only_map(&base_map);
    for (path, value) in &local_map {
        if !is_scratch_path(path) {
            accepted_map.insert(path.clone(), value.clone());
        }
    }

    commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &accepted_map,
        "Accept all local changes",
    )?;

    Ok(AcceptAllResult {
        files_accepted: changes.len() as i32,
        accepted_paths: changes.into_iter().map(|entry| entry.path).collect(),
    })
}

fn unreviewed_entries(ctx: &ConnectionContext) -> anyhow::Result<Vec<UnreviewedEntry>> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;
    Ok(compute_unreviewed_entries(
        &ctx.conn_dir_name,
        &base_map,
        &local_map,
    ))
}

pub(crate) fn has_unreviewed_record_changes(
    bare_repo: &Path,
    dirty_dir: &Path,
) -> anyhow::Result<bool> {
    let base_hash = git_rev_parse_optional(bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(bare_repo, hash)?,
        None => HashMap::new(),
    };

    let mut working_tree_map = FileMap::new();
    read_dirty_disk(dirty_dir, dirty_dir, &mut working_tree_map)?;

    Ok(!maps_equal(
        &data_only_map(&base_map),
        &data_only_map(&working_tree_map),
    ))
}

fn force_upload_single_repo(ctx: &ConnectionContext, token: &str) -> anyhow::Result<bool> {
    let base_hash = git_rev_parse_optional(&ctx.bare_repo, "refs/heads/dirty")?;
    let base_map = match base_hash.as_deref() {
        Some(hash) => read_git_tree(&ctx.bare_repo, hash)?,
        None => HashMap::new(),
    };
    sync_schema_files_from_master(ctx)?;
    let local_map = read_materialized_repo(ctx)?;

    if maps_equal(&base_map, &local_map) {
        return Ok(false);
    }

    commit_file_map_to_dirty_ref(
        &ctx.bare_repo,
        base_hash.as_deref(),
        &local_map,
        "Force-upload from Scratch CLI",
    )?;
    crate::git_ops::force_push_origin_dirty(&ctx.bare_repo, token)?;
    Ok(true)
}

fn git_rev_parse(bare_repo: &Path, rev: &str) -> anyhow::Result<String> {
    crate::git_ops::rev_parse_to_string(bare_repo, rev)
}

fn git_rev_parse_optional(bare_repo: &Path, rev: &str) -> anyhow::Result<Option<String>> {
    crate::git_ops::rev_parse_optional_to_string(bare_repo, rev)
}

fn git_update_ref(bare_repo: &Path, refname: &str, object: &str) -> anyhow::Result<()> {
    crate::git_ops::update_ref(bare_repo, refname, object)
}

pub(crate) fn materialize_treeish_to_worktree(
    bare_repo: &Path,
    treeish: &str,
    work_tree: &Path,
) -> anyhow::Result<()> {
    clear_dir_contents(work_tree, true)?;
    std::fs::create_dir_all(work_tree)?;
    crate::git_ops::materialize_treeish_to_directory(bare_repo, treeish, work_tree)
}

fn commit_file_map_to_dirty_ref(
    bare_repo: &Path,
    parent_hash: Option<&str>,
    files: &FileMap,
    message: &str,
) -> anyhow::Result<String> {
    crate::git_ops::commit_file_map_to_ref(
        bare_repo,
        "refs/heads/dirty",
        parent_hash,
        files,
        message,
    )
}

fn read_git_tree(bare_repo: &Path, hash: &str) -> anyhow::Result<FileMap> {
    crate::git_ops::read_tree_files(bare_repo, hash)
}

fn read_materialized_repo(ctx: &ConnectionContext) -> anyhow::Result<FileMap> {
    let mut map = FileMap::new();
    read_dirty_disk(&ctx.dirty_dir, &ctx.dirty_dir, &mut map)?;
    read_scratch_disk(&ctx.scratch_dir, &ctx.scratch_dir, &mut map)?;
    Ok(map)
}

fn read_dirty_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            match name_str.as_ref() {
                "syncs" => continue,
                value if value.starts_with('.') => continue,
                _ => read_dirty_disk(root, &entry.path(), map)?,
            }
        } else if ft.is_file() {
            if name_str.starts_with('.') {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy();
            let content = normalize_crlf(std::fs::read(entry.path())?);
            map.insert(rel, content);
        }
    }

    Ok(())
}

fn read_scratch_disk(root: &Path, dir: &Path, map: &mut FileMap) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let ft = entry.file_type()?;

        if ft.is_dir() {
            if name_str.starts_with('.') && name_str != ".publish-plans" {
                continue;
            }
            read_scratch_disk(root, &entry.path(), map)?;
        } else if ft.is_file() {
            if name_str.starts_with('.') {
                continue;
            }
            let rel = entry.path().strip_prefix(root)?.to_slash_lossy();
            let content = normalize_crlf(std::fs::read(entry.path())?);
            map.insert(format!(".scratch/{rel}"), content);
        }
    }

    Ok(())
}

fn materialize_local_repo(ctx: &ConnectionContext, map: &FileMap) -> anyhow::Result<()> {
    clear_dir_contents(&ctx.dirty_dir, false)?;
    clear_dir_contents(&ctx.scratch_dir, true)?;
    std::fs::create_dir_all(&ctx.dirty_dir)?;
    std::fs::create_dir_all(&ctx.scratch_dir)?;

    for (rel_path, content) in map {
        if let Some(scratch_rel) = rel_path.strip_prefix(".scratch/") {
            write_file(&ctx.scratch_dir.join(scratch_rel), content)?;
        } else if !rel_path.starts_with(".scratch") {
            write_file(&ctx.dirty_dir.join(rel_path), content)?;
        }
    }

    Ok(())
}

fn read_local_publish_plan_map(ctx: &ConnectionContext) -> anyhow::Result<FileMap> {
    let mut scratch_map = FileMap::new();
    read_scratch_disk(&ctx.scratch_dir, &ctx.scratch_dir, &mut scratch_map)?;
    Ok(scratch_map
        .into_iter()
        .filter(|(path, _)| is_publish_plan_file(path))
        .collect())
}

fn is_scratch_path(path: &str) -> bool {
    path.starts_with(".scratch/")
}

fn is_publish_plan_file(path: &str) -> bool {
    path.strip_prefix(".scratch/")
        .map(|rest| rest.starts_with(".publish-plans/") || rest.contains("/publish-plan-"))
        .unwrap_or(false)
}

fn strip_publish_plan_files(map: &mut FileMap) {
    map.retain(|path, _| !is_publish_plan_file(path));
}

fn scratch_only_map(map: &FileMap) -> FileMap {
    map.iter()
        .filter(|(path, _)| is_scratch_path(path))
        .map(|(path, value)| (path.clone(), value.clone()))
        .collect()
}

fn data_only_map(map: &FileMap) -> FileMap {
    map.iter()
        .filter(|(path, _)| !is_scratch_path(path))
        .map(|(path, value)| (path.clone(), value.clone()))
        .collect()
}

fn compute_unreviewed_entries(
    connection_name: &str,
    base_map: &FileMap,
    local_map: &FileMap,
) -> Vec<UnreviewedEntry> {
    let base_data = data_only_map(base_map);
    let local_data = data_only_map(local_map);
    let mut all_paths: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();

    for key in base_data.keys() {
        all_paths.insert(key);
    }
    for key in local_data.keys() {
        all_paths.insert(key);
    }

    let mut entries = Vec::new();
    for path in all_paths {
        match (base_data.get(path), local_data.get(path)) {
            (None, Some(_)) => entries.push(UnreviewedEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "added".to_string(),
            }),
            (Some(_), None) => entries.push(UnreviewedEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "deleted".to_string(),
            }),
            (Some(base), Some(local)) if base != local => entries.push(UnreviewedEntry {
                connection_name: connection_name.to_string(),
                path: path.to_string(),
                status: "modified".to_string(),
            }),
            _ => {}
        }
    }

    entries
}

fn sync_schema_files_from_master(ctx: &ConnectionContext) -> anyhow::Result<()> {
    let master_scratch_dir = ctx.master_dir.join(".scratch");
    sync_schema_files_dir(&master_scratch_dir, &master_scratch_dir, &ctx.scratch_dir)
}

fn sync_schema_files_dir(root: &Path, dir: &Path, scratch_dir: &Path) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            sync_schema_files_dir(root, &path, scratch_dir)?;
            continue;
        }

        if !ft.is_file() || entry.file_name() != "schema.json" {
            continue;
        }

        let rel = path.strip_prefix(root)?;
        write_file(&scratch_dir.join(rel), &std::fs::read(&path)?)?;
    }

    Ok(())
}

fn clear_dir_contents(dir: &Path, remove_hidden: bool) -> anyhow::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !remove_hidden && name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(path)?;
        } else {
            std::fs::remove_file(path)?;
        }
    }

    Ok(())
}

fn write_file(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

enum MergeAction {
    KeepLocal {
        path: String,
        content: Option<Vec<u8>>,
        warning: Option<String>,
    },
    WriteRemote {
        path: String,
        content: Option<Vec<u8>>,
    },
    Delete {
        path: String,
        warning: Option<String>,
    },
    Merge {
        path: String,
        base: Vec<u8>,
        local: Vec<u8>,
        remote: Vec<u8>,
    },
}

fn compute_merge_actions(base: &FileMap, local: &FileMap, remote: &FileMap) -> Vec<MergeAction> {
    let mut all_paths: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for key in base.keys() {
        all_paths.insert(key);
    }
    for key in local.keys() {
        all_paths.insert(key);
    }
    for key in remote.keys() {
        all_paths.insert(key);
    }

    let mut actions = Vec::new();

    for path in all_paths {
        let base_content = base.get(path);
        let local_content = local.get(path);
        let remote_content = remote.get(path);

        let local_changed = local_content != base_content;
        let remote_changed = remote_content != base_content;

        if !local_changed {
            match remote_content {
                Some(content) => actions.push(MergeAction::WriteRemote {
                    path: path.to_string(),
                    content: Some(content.clone()),
                }),
                None if base_content.is_some() => actions.push(MergeAction::Delete {
                    path: path.to_string(),
                    warning: None,
                }),
                None => {}
            }
        } else if !remote_changed {
            match local_content {
                Some(content) => actions.push(MergeAction::KeepLocal {
                    path: path.to_string(),
                    content: Some(content.clone()),
                    warning: None,
                }),
                None => actions.push(MergeAction::Delete {
                    path: path.to_string(),
                    warning: None,
                }),
            }
        } else {
            match (local_content, remote_content) {
                (Some(local_content), Some(remote_content)) => {
                    if let Some(base_content) = base_content {
                        actions.push(MergeAction::Merge {
                            path: path.to_string(),
                            base: base_content.clone(),
                            local: local_content.clone(),
                            remote: remote_content.clone(),
                        });
                    } else {
                        actions.push(MergeAction::KeepLocal {
                            path: path.to_string(),
                            content: Some(local_content.clone()),
                            warning: None,
                        });
                    }
                }
                (Some(local_content), None) => actions.push(MergeAction::KeepLocal {
                    path: path.to_string(),
                    content: Some(local_content.clone()),
                    warning: Some(format!(
                        "Remote deleted {} but local has changes; keeping local version",
                        path
                    )),
                }),
                (None, Some(remote_content)) => actions.push(MergeAction::WriteRemote {
                    path: path.to_string(),
                    content: Some(remote_content.clone()),
                }),
                (None, None) => actions.push(MergeAction::Delete {
                    path: path.to_string(),
                    warning: None,
                }),
            }
        }
    }

    actions
}

fn prepare_upload_merge(
    base_map: &FileMap,
    local_map: &FileMap,
    remote_map: &FileMap,
    attempt: i32,
) -> (FileMap, UploadResult, Vec<String>) {
    let actions = compute_merge_actions(base_map, local_map, remote_map);

    let mut merged = remote_map.clone();
    let mut messages = Vec::new();
    let mut result = UploadResult {
        status: "uploaded".to_string(),
        retries: attempt,
        ..Default::default()
    };

    for act in &actions {
        match act {
            MergeAction::KeepLocal {
                path,
                content,
                warning,
            } => {
                match content {
                    Some(content) => {
                        merged.insert(path.clone(), content.clone());
                        if remote_map
                            .get(path.as_str())
                            .map(|remote| remote != content)
                            .unwrap_or(true)
                        {
                            result.files_uploaded += 1;
                            result.uploaded_paths.push(path.clone());
                        }
                    }
                    None => {
                        merged.remove(path.as_str());
                        if remote_map.contains_key(path.as_str()) {
                            result.files_deleted += 1;
                            result.deleted_paths.push(path.clone());
                        }
                    }
                }
                if let Some(warning) = warning {
                    messages.push(warning.clone());
                }
            }
            MergeAction::WriteRemote { path, content } => match content {
                Some(content) => {
                    merged.insert(path.clone(), content.clone());
                }
                None => {
                    merged.remove(path.as_str());
                }
            },
            MergeAction::Delete { path, warning } => {
                merged.remove(path.as_str());
                if remote_map.contains_key(path.as_str()) {
                    result.files_deleted += 1;
                    result.deleted_paths.push(path.clone());
                }
                if let Some(warning) = warning {
                    messages.push(warning.clone());
                }
            }
            MergeAction::Merge {
                path,
                base,
                local,
                remote,
            } => {
                let content = merge_content(path, Some(base), Some(local), Some(remote));
                merged.insert(path.clone(), content);
                result.files_merged += 1;
                result.merged_paths.push(path.clone());
                result.conflicts_auto_resolved += 1;
            }
        }
    }

    (merged, result, messages)
}

fn merge_content(
    _path: &str,
    base: Option<&Vec<u8>>,
    local: Option<&Vec<u8>>,
    remote: Option<&Vec<u8>>,
) -> Vec<u8> {
    if local.map(|value| is_binary(value)).unwrap_or(false)
        || remote.map(|value| is_binary(value)).unwrap_or(false)
    {
        return local.or(remote).cloned().unwrap_or_default();
    }

    let base_str = base
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default();
    let local_str = local
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default();
    let remote_str = remote
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default();

    match crate::shared::merge::merge_file_contents(&base_str, &local_str, &remote_str) {
        Ok(merged) => merged.into_bytes(),
        Err(_) => local.cloned().unwrap_or_default(),
    }
}

fn is_binary(data: &[u8]) -> bool {
    data.contains(&0)
}

fn normalize_crlf(data: Vec<u8>) -> Vec<u8> {
    if !data.contains(&b'\r') || is_binary(&data) {
        return data;
    }

    let mut out = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'\r' && index + 1 < data.len() && data[index + 1] == b'\n' {
            index += 1;
        } else {
            out.push(data[index]);
        }
        index += 1;
    }
    out
}

fn maps_equal(left: &FileMap, right: &FileMap) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .all(|(key, value)| right.get(key).map(|other| other == value).unwrap_or(false))
}

fn aggregate_download(results: &[DownloadResult]) -> DownloadResult {
    let mut agg = DownloadResult {
        status: "up_to_date".to_string(),
        ..Default::default()
    };
    for result in results {
        if result.status == "downloaded" {
            agg.status = "downloaded".to_string();
        }
        agg.files_updated += result.files_updated;
        agg.files_created += result.files_created;
        agg.files_deleted += result.files_deleted;
        agg.files_merged += result.files_merged;
        agg.conflicts_auto_resolved += result.conflicts_auto_resolved;
        agg.messages.extend(result.messages.iter().cloned());
    }
    agg
}

fn aggregate_upload(results: &[UploadResult]) -> UploadResult {
    let mut agg = UploadResult {
        status: "no_changes".to_string(),
        ..Default::default()
    };
    for result in results {
        if result.status == "uploaded" {
            agg.status = "uploaded".to_string();
        }
        if result.status == "up_to_date" && agg.status == "no_changes" {
            agg.status = "up_to_date".to_string();
        }
        agg.files_uploaded += result.files_uploaded;
        agg.files_merged += result.files_merged;
        agg.files_deleted += result.files_deleted;
        agg.conflicts_auto_resolved += result.conflicts_auto_resolved;
        agg.retries += result.retries;
        agg.messages.extend(result.messages.iter().cloned());
        agg.uploaded_paths
            .extend(result.uploaded_paths.iter().cloned());
        agg.merged_paths.extend(result.merged_paths.iter().cloned());
        agg.deleted_paths
            .extend(result.deleted_paths.iter().cloned());
    }
    agg
}

fn print_file_list(paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let limit = paths.len().min(10);
    for path in &paths[..limit] {
        println!("  {}", path);
    }
    if paths.len() > 10 {
        println!("  ... and {} more", paths.len() - 10);
    }
}

fn print_download_result(
    result: &DownloadResult,
    elapsed_ms: u128,
    json: bool,
) -> anyhow::Result<()> {
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
            if result.status == "up_to_date" {
                "Already up to date."
            } else {
                "No changes."
            },
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
    for message in &result.messages {
        println!("Warning: {}", message);
    }
    Ok(())
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
        for message in &result.messages {
            println!("Warning: {}", message);
        }
        return Ok(());
    }
    if result.status == "up_to_date" {
        println!("Remote already has all local changes. ({})", elapsed);
        for message in &result.messages {
            println!("Warning: {}", message);
        }
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
    print_file_list(&result.uploaded_paths);
    print_file_list(&result.merged_paths);
    print_file_list(&result.deleted_paths);
    for message in &result.messages {
        println!("Warning: {}", message);
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

fn rebuild_index_for_conn(ctx: &ConnectionContext, quiet: bool) {
    if !ctx.master_dir.exists() {
        return;
    }
    if let Some(parent) = ctx.db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !quiet {
        eprint!("  Rebuilding index for {}... ", ctx.conn_dir_name);
    }
    match crate::shared::index::build(&ctx.master_dir, &ctx.db_path) {
        Ok(count) => {
            if !quiet {
                eprintln!("{count} file(s)");
            }
        }
        Err(err) => {
            if !quiet {
                eprintln!("warning: index rebuild failed: {err}");
            }
        }
    }
}

fn update_master_worktree(ctx: &ConnectionContext, token: &str) -> anyhow::Result<()> {
    let _ = crate::git_ops::fetch_origin(&ctx.bare_repo, token);
    let Some(main_hash) = git_rev_parse_optional(&ctx.bare_repo, "refs/remotes/origin/main")?
    else {
        return Ok(());
    };
    materialize_treeish_to_worktree(&ctx.bare_repo, &main_hash, &ctx.master_dir)
}

trait ToSlashLossy {
    fn to_slash_lossy(&self) -> String;
}

impl ToSlashLossy for Path {
    fn to_slash_lossy(&self) -> String {
        self.to_string_lossy().replace('\\', "/")
    }
}

#[cfg(test)]
#[path = "tests/files.rs"]
mod tests;
