//! `scratchmdv4 plan-publish` — diff dirty vs master and write a publish plan.
//!
//! For each connection, compares the dirty worktree (`workspace/{ConnName}/`)
//! against the master worktree (`.scratch/connections/{ConnName}/master/`) and
//! writes a plan under:
//!
//!   `workspace/{ConnName}/.scratch/publish-plans/{planId}/`
//!
//! Plan structure:
//!   plan.json                          ← metadata + summary
//!   {folder}/create/{filename}         ← dirty content (record to be created)
//!   {folder}/update/{filename}         ← dirty content (fields to be updated)
//!   {folder}/delete/{filename}         ← master content (has remoteId)
//!
//! No network calls — built entirely from local state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Error, Result};
use super::resolve_workspace;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Path to the pulled workspace root (default: auto-detected)
    #[arg(long, default_value = ".")]
    pub workspace: PathBuf,
}

// ---------------------------------------------------------------------------
// plan.json metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMeta {
    pub plan_id: String,
    pub created_at: String,
    pub connection_name: String,
    pub connection_id: String,
    pub summary: PlanSummary,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlanSummary {
    pub create: usize,
    pub update: usize,
    pub delete: usize,
}

// ---------------------------------------------------------------------------
// Internal diff entry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpType {
    Create,
    Update,
    Delete,
}

struct DiffEntry {
    op: OpType,
    /// Relative path from connection root, e.g. "Transformers Test/posts/recXXX.json"
    rel_path: String,
    /// Content to write into the plan file
    content: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(args: Args) -> Result<()> {
    let workspace = resolve_workspace(&args.workspace)?;
    let connections_dir = workspace.join(".scratch/connections");

    if !connections_dir.exists() {
        return Err(Error::Other(format!(
            "connections directory not found at {}. Run `scratchmdv4 pull` first.",
            connections_dir.display()
        )));
    }

    let timestamp = now_compact();
    let mut any_changes = false;

    for entry in std::fs::read_dir(&connections_dir)? {
        let entry = entry?;
        let conn_scratch_dir = entry.path();
        if !conn_scratch_dir.is_dir() {
            continue;
        }

        let conn_name = conn_scratch_dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let master_dir = conn_scratch_dir.join("master");
        let dirty_dir = workspace.join(&conn_name);

        if !master_dir.exists() || !dirty_dir.exists() {
            continue;
        }

        let connection_id = std::fs::read_to_string(conn_scratch_dir.join("id"))
            .unwrap_or_default()
            .trim()
            .to_string();

        let diff = diff_worktrees(&master_dir, &dirty_dir)?;
        if diff.is_empty() {
            println!("  {conn_name}: nothing to publish");
            continue;
        }

        any_changes = true;

        let creates = diff.iter().filter(|d| d.op == OpType::Create).count();
        let updates = diff.iter().filter(|d| d.op == OpType::Update).count();
        let deletes = diff.iter().filter(|d| d.op == OpType::Delete).count();
        println!("  {conn_name}  ({} create, {} update, {} delete)", creates, updates, deletes);

        // Per-folder breakdown
        let mut by_folder: std::collections::BTreeMap<String, (usize, usize, usize)> = std::collections::BTreeMap::new();
        for entry in &diff {
            let (folder, _) = split_path(&entry.rel_path);
            let counts = by_folder.entry(folder).or_insert((0, 0, 0));
            match entry.op {
                OpType::Create => counts.0 += 1,
                OpType::Update => counts.1 += 1,
                OpType::Delete => counts.2 += 1,
            }
        }
        for (folder, (c, u, d)) in &by_folder {
            let label = if folder.is_empty() { "(root)" } else { folder.as_str() };
            println!("    {label}  ({} create, {} update, {} delete)", c, u, d);
        }

        // Plan root: {ConnName}/.scratch/publish-plans/{planId}/
        let plan_root = dirty_dir.join(format!(".scratch/publish-plans/{timestamp}"));
        std::fs::create_dir_all(&plan_root)?;

        // Write plan.json
        let meta = PlanMeta {
            plan_id: timestamp.clone(),
            created_at: now_iso8601(),
            connection_name: conn_name.clone(),
            connection_id,
            summary: PlanSummary { create: creates, update: updates, delete: deletes },
        };
        std::fs::write(plan_root.join("plan.json"), serde_json::to_string_pretty(&meta)?)?;

        // Write each operation file
        for entry in &diff {
            let op_dir_name = match entry.op {
                OpType::Create => "create",
                OpType::Update => "update",
                OpType::Delete => "delete",
            };

            // Split rel_path into folder + filename
            let (folder, filename) = split_path(&entry.rel_path);

            // Target: {plan_root}/{folder}/{op_dir}/{filename}
            let op_dir = if folder.is_empty() {
                plan_root.join(op_dir_name)
            } else {
                plan_root.join(&folder).join(op_dir_name)
            };
            std::fs::create_dir_all(&op_dir)?;
            std::fs::write(op_dir.join(&filename), &entry.content)?;
        }

        println!("  → {}", plan_root.display());
    }

    if !any_changes {
        println!("\nNothing to publish — all connections are in sync.");
    } else {
        println!("\nNext: scratchmdv4 execute-publish (see PUBLISH_NEXT_STEPS.md)");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

fn diff_worktrees(master_dir: &Path, dirty_dir: &Path) -> Result<Vec<DiffEntry>> {
    let master_files = collect_files(master_dir)?;
    let dirty_files = collect_files(dirty_dir)?;

    let mut diff = Vec::new();

    for (rel_path, dirty_content) in &dirty_files {
        match master_files.get(rel_path) {
            None => {
                diff.push(DiffEntry { op: OpType::Create, rel_path: rel_path.clone(), content: dirty_content.clone() });
            }
            Some(master_content) => {
                if dirty_content != master_content {
                    diff.push(DiffEntry { op: OpType::Update, rel_path: rel_path.clone(), content: dirty_content.clone() });
                }
            }
        }
    }

    for rel_path in master_files.keys() {
        if !dirty_files.contains_key(rel_path) {
            diff.push(DiffEntry { op: OpType::Delete, rel_path: rel_path.clone(), content: "{}".to_string() });
        }
    }

    // Creates first, then updates, then deletes
    diff.sort_by_key(|d| match d.op { OpType::Create => 0, OpType::Update => 1, OpType::Delete => 2 });

    Ok(diff)
}

fn collect_files(root: &Path) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    collect_files_rec(root, root, &mut map)?;
    Ok(map)
}

fn collect_files_rec(root: &Path, dir: &Path, map: &mut HashMap<String, String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();

        if path.is_dir() {
            if name == ".scratch" || name == ".git" {
                continue;
            }
            collect_files_rec(root, &path, map)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
            map.insert(rel, std::fs::read_to_string(&path)?);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

fn split_path(rel_path: &str) -> (String, String) {
    match rel_path.rfind('/') {
        Some(i) => (rel_path[..i].to_string(), rel_path[i + 1..].to_string()),
        None => (String::new(), rel_path.to_string()),
    }
}

fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = unix_to_parts(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn now_compact() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = unix_to_parts(secs);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

fn unix_to_parts(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let total_min = secs / 60;
    let mi = total_min % 60;
    let total_h = total_min / 60;
    let h = total_h % 24;
    let total_days = total_h / 24;
    let z = total_days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, mi, s)
}
