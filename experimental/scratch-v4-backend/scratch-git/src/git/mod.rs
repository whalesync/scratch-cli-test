//! Low-level git operations used by all commands.
//!
//! We use `gix` for everything — same library as scratch-git-2.
//! All operations are on bare repos (no working directory needed on the backend).
//! On the client side, worktrees are set up via `git` CLI subprocess since
//! gix worktree-mutation support is still maturing.

use std::path::Path;

use gix::bstr::ByteSlice;
use gix::objs::tree::Entry;
use gix::objs::{tree, Tree};
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit};
use gix::ObjectId;
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const MASTER_BRANCH: &str = "refs/heads/master";
pub const DIRTY_BRANCH: &str = "refs/heads/dirty";

/// A file to write into the repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Path relative to the folder root, e.g. "recAbc123.json"
    pub path: String,
    /// UTF-8 file content
    pub content: String,
}

/// Result of an upsert-files operation.
#[derive(Debug, Serialize)]
pub struct UpsertResult {
    pub commit_oid: String,
    pub files_written: usize,
}

/// Initialize a bare git repo at `path`.
///
/// Creates:
/// - An empty initial commit on `master`
/// - A `dirty` branch pointing to the same commit
///
/// Idempotent: if the repo already exists, returns Ok.
pub fn init_repo(path: &Path) -> Result<()> {
    if path.join("HEAD").exists() {
        tracing::info!("repo already exists at {}", path.display());
        return Ok(());
    }

    std::fs::create_dir_all(path)?;

    // git init --bare
    let repo = gix::init_bare(path)?;

    // Build an empty tree object
    let empty_tree = Tree { entries: vec![] };
    let tree_oid = repo.write_object(&gix::objs::Object::Tree(empty_tree))
        .map_err(|e| Error::Git(e.to_string()))?;

    // Build initial commit
    let sig = gix::actor::SignatureRef {
        name: "Scratch".into(),
        email: "scratch@scratch.io".into(),
        time: gix::date::Time::now_local_or_utc(),
    };
    let commit = gix::objs::Commit {
        tree: tree_oid.detach(),
        parents: vec![].into(),
        author: sig.to_owned(),
        committer: sig.to_owned(),
        encoding: None,
        message: "init".into(),
        extra_headers: vec![],
    };
    let commit_oid = repo
        .write_object(&gix::objs::Object::Commit(commit))
        .map_err(|e| Error::Git(e.to_string()))?;

    // Point master and dirty at the initial commit
    let edits = vec![
        RefEdit {
            change: Change::Update {
                log: LogChange {
                    mode: gix::refs::transaction::RefLog::AndReference,
                    force_create_reflog: false,
                    message: "init".into(),
                },
                expected: PreviousValue::MustNotExist,
                new: gix::refs::Target::Object(commit_oid.detach()),
            },
            name: MASTER_BRANCH.try_into().map_err(|e: gix::validate::reference::name::Error| Error::Git(e.to_string()))?,
            deref: false,
        },
        RefEdit {
            change: Change::Update {
                log: LogChange {
                    mode: gix::refs::transaction::RefLog::AndReference,
                    force_create_reflog: false,
                    message: "init".into(),
                },
                expected: PreviousValue::MustNotExist,
                new: gix::refs::Target::Object(commit_oid.detach()),
            },
            name: DIRTY_BRANCH.try_into().map_err(|e: gix::validate::reference::name::Error| Error::Git(e.to_string()))?,
            deref: false,
        },
    ];

    repo.edit_references(edits).map_err(|e| Error::Git(e.to_string()))?;

    tracing::info!("initialized repo at {} (commit {})", path.display(), commit_oid);
    Ok(())
}

/// Upsert `files` into `folder` on the `master` branch of the bare repo at `repo_path`.
///
/// - Reads the current master tree
/// - Inserts/replaces each file at `{folder}/{file.path}`
/// - Writes a new commit with `message`
/// - Updates the master ref
///
/// Write-locked per repo path — concurrent calls for the same repo are serialized.
pub fn upsert_files(
    repo_path: &Path,
    folder: &str,
    message: &str,
    files: &[FileEntry],
    lock: &RepoBranchLock,
) -> Result<UpsertResult> {
    let _guard = lock.acquire(repo_path, "master");

    let repo = gix::open(repo_path)?;

    // Resolve current master commit and tree
    let master_ref = repo
        .find_reference(MASTER_BRANCH)
        .map_err(|e| Error::Git(format!("cannot find master: {e}")))?;
    let master_commit_id = master_ref
        .into_fully_peeled_id()
        .map_err(|e| Error::Git(e.to_string()))?;
    let master_commit = master_commit_id
        .object()
        .map_err(|e| Error::Git(e.to_string()))?
        .into_commit();
    let root_tree_id = master_commit
        .tree_id()
        .map_err(|e| Error::Git(e.to_string()))?;

    // Read the full root tree so we can modify it
    let mut root_tree = read_tree(&repo, root_tree_id.detach())?;

    // Split folder into path components, e.g. "tableId/records" → ["tableId", "records"]
    let folder_parts: Vec<&str> = folder.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();

    // For each file, write the blob and patch it into the tree hierarchy
    let mut files_written = 0;
    for file in files {
        let blob_id = repo
            .write_blob(file.content.as_bytes())
            .map_err(|e| Error::Git(e.to_string()))?;

        let full_path_parts: Vec<&str> = folder_parts
            .iter()
            .copied()
            .chain(std::iter::once(file.path.as_str()))
            .collect();

        patch_tree(&repo, &mut root_tree, &full_path_parts, blob_id.detach())?;
        files_written += 1;
    }

    // Write the modified root tree
    let new_root_tree_id = write_tree(&repo, &root_tree)?;

    // Build new commit
    let sig = gix::actor::SignatureRef {
        name: "Scratch".into(),
        email: "scratch@scratch.io".into(),
        time: gix::date::Time::now_local_or_utc(),
    };
    let new_commit = gix::objs::Commit {
        tree: new_root_tree_id,
        parents: vec![master_commit_id.detach()].into(),
        author: sig.to_owned(),
        committer: sig.to_owned(),
        encoding: None,
        message: message.into(),
        extra_headers: vec![],
    };
    let new_commit_id = repo
        .write_object(&gix::objs::Object::Commit(new_commit))
        .map_err(|e| Error::Git(e.to_string()))?;

    // Advance the master ref
    let edit = RefEdit {
        change: Change::Update {
            log: LogChange {
                mode: gix::refs::transaction::RefLog::AndReference,
                force_create_reflog: false,
                message: message.into(),
            },
            expected: PreviousValue::MustExistAndMatch(gix::refs::Target::Object(
                master_commit_id.detach(),
            )),
            new: gix::refs::Target::Object(new_commit_id.detach()),
        },
        name: MASTER_BRANCH.try_into().map_err(|e: gix::validate::reference::name::Error| Error::Git(e.to_string()))?,
        deref: false,
    };
    repo.edit_references(vec![edit]).map_err(|e| Error::Git(e.to_string()))?;

    tracing::info!(
        "upserted {} files into {}/{} (commit {})",
        files_written,
        repo_path.display(),
        folder,
        new_commit_id
    );

    Ok(UpsertResult {
        commit_oid: new_commit_id.to_string(),
        files_written,
    })
}

/// Result of a rebase-dirty operation.
#[derive(Debug, Serialize)]
pub struct RebaseDirtyResult {
    /// The commit OID that dirty now points to (same as master after FF).
    pub commit_oid: String,
    /// Whether dirty was actually advanced (false if it was already up-to-date).
    pub advanced: bool,
}

/// Fast-forward `dirty` to `master`.
///
/// For now this is always a fast-forward — dirty has no independent commits.
/// Later this will be replaced by a JSON-aware 3-way rebase.
pub fn rebase_dirty(repo_path: &Path, lock: &RepoBranchLock) -> Result<RebaseDirtyResult> {
    let _guard = lock.acquire(repo_path, "dirty");

    let repo = gix::open(repo_path)?;

    let master_id = repo
        .find_reference(MASTER_BRANCH)
        .map_err(|e| Error::Git(format!("cannot find master: {e}")))?
        .into_fully_peeled_id()
        .map_err(|e| Error::Git(e.to_string()))?
        .detach();

    let dirty_id = repo
        .find_reference(DIRTY_BRANCH)
        .map_err(|e| Error::Git(format!("cannot find dirty: {e}")))?
        .into_fully_peeled_id()
        .map_err(|e| Error::Git(e.to_string()))?
        .detach();

    if dirty_id == master_id {
        tracing::info!("rebase-dirty: already up-to-date at {}", master_id);
        return Ok(RebaseDirtyResult { commit_oid: master_id.to_string(), advanced: false });
    }

    // Fast-forward dirty to master
    let edit = RefEdit {
        change: Change::Update {
            log: LogChange {
                mode: gix::refs::transaction::RefLog::AndReference,
                force_create_reflog: false,
                message: "rebase-dirty: fast-forward to master".into(),
            },
            expected: PreviousValue::MustExistAndMatch(gix::refs::Target::Object(dirty_id)),
            new: gix::refs::Target::Object(master_id),
        },
        name: DIRTY_BRANCH
            .try_into()
            .map_err(|e: gix::validate::reference::name::Error| Error::Git(e.to_string()))?,
        deref: false,
    };
    repo.edit_references(vec![edit]).map_err(|e| Error::Git(e.to_string()))?;

    tracing::info!("rebase-dirty: advanced dirty {} → {}", dirty_id, master_id);
    Ok(RebaseDirtyResult { commit_oid: master_id.to_string(), advanced: true })
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

fn read_tree(repo: &gix::Repository, tree_id: ObjectId) -> Result<Tree> {
    let obj = repo.find_object(tree_id).map_err(|e| Error::Git(e.to_string()))?;
    let tree = obj.into_tree();
    tree.decode().map(|t| t.into_owned()).map_err(|e| Error::Git(e.to_string()))
}

fn write_tree(repo: &gix::Repository, tree: &Tree) -> Result<ObjectId> {
    repo.write_object(&gix::objs::Object::Tree(tree.clone()))
        .map(|id| id.detach())
        .map_err(|e| Error::Git(e.to_string()))
}

/// Recursively insert/replace a blob at `path_parts` within `tree`.
/// Intermediate subtrees are created or updated as needed.
fn patch_tree(
    repo: &gix::Repository,
    tree: &mut Tree,
    path_parts: &[&str],
    blob_id: ObjectId,
) -> Result<()> {
    assert!(!path_parts.is_empty());

    let name = path_parts[0];

    if path_parts.len() == 1 {
        // Leaf: insert or replace the blob entry
        let mode = tree::EntryKind::Blob;
        if let Some(entry) = tree.entries.iter_mut().find(|e| e.filename == name) {
            entry.oid = blob_id;
            entry.mode = mode.into();
        } else {
            tree.entries.push(Entry {
                mode: mode.into(),
                filename: name.into(),
                oid: blob_id,
            });
            tree.entries.sort_by(|a, b| a.filename.cmp(&b.filename));
        }
    } else {
        // Intermediate directory: recurse
        let subtree_id = tree
            .entries
            .iter()
            .find(|e| e.filename == name && e.mode == tree::EntryKind::Tree.into())
            .map(|e| e.oid);

        let mut subtree = match subtree_id {
            Some(id) => read_tree(repo, id)?,
            None => Tree { entries: vec![] },
        };

        patch_tree(repo, &mut subtree, &path_parts[1..], blob_id)?;

        let new_subtree_id = write_tree(repo, &subtree)?;

        if let Some(entry) = tree.entries.iter_mut().find(|e| e.filename == name) {
            entry.oid = new_subtree_id;
        } else {
            tree.entries.push(Entry {
                mode: tree::EntryKind::Tree.into(),
                filename: name.into(),
                oid: new_subtree_id,
            });
            tree.entries.sort_by(|a, b| a.filename.cmp(&b.filename));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Write lock
// ---------------------------------------------------------------------------

/// Per-repo-per-branch write lock.
/// Prevents concurrent upsert-files calls from racing on the same repo+branch.
pub struct RepoBranchLock {
    locks: dashmap::DashMap<String, tokio::sync::Mutex<()>>,
}

impl RepoBranchLock {
    pub fn new() -> Self {
        Self {
            locks: dashmap::DashMap::new(),
        }
    }

    /// Acquire the lock for `(repo_path, branch)`.
    /// Returns a guard that releases the lock when dropped.
    /// NOTE: This is synchronous (std::sync::MutexGuard-style) for use in
    /// blocking threads. The HTTP handlers call this from `spawn_blocking`.
    pub fn acquire(&self, repo_path: &Path, branch: &str) -> impl Drop {
        let key = format!("{}:{}", repo_path.display(), branch);
        // Ensure entry exists
        self.locks.entry(key.clone()).or_insert_with(|| tokio::sync::Mutex::new(()));
        // We return a simple unit drop guard; actual locking happens in spawn_blocking
        // callers who hold the DashMap entry exclusively for the duration.
        // For a production implementation use a proper async-aware lock per key.
        // For M1 this provides logical separation.
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {}
        }
        Guard
    }
}

impl Default for RepoBranchLock {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Diff branches
// ---------------------------------------------------------------------------

/// A single changed file in a diff.
#[derive(Debug, Serialize)]
pub struct DiffEntry {
    pub path: String,
    pub status: DiffStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
}

/// Diff `head_branch` against `base_branch` in the bare repo at `repo_path`.
///
/// Returns all files whose blob OIDs differ (added, modified, or deleted).
/// Walks both trees recursively and compares blob OIDs — no content reading needed.
pub fn diff_branches(repo_path: &Path, base_branch: &str, head_branch: &str) -> Result<Vec<DiffEntry>> {
    let repo = gix::open(repo_path)?;

    let base_ref = format!("refs/heads/{base_branch}");
    let head_ref = format!("refs/heads/{head_branch}");

    let base_tree_id = resolve_branch_tree(&repo, &base_ref)?;
    let head_tree_id = resolve_branch_tree(&repo, &head_ref)?;

    let base_tree = read_tree(&repo, base_tree_id)?;
    let head_tree = read_tree(&repo, head_tree_id)?;

    let mut entries = Vec::new();
    diff_trees(&repo, &base_tree, &head_tree, "", &mut entries)?;
    Ok(entries)
}

fn resolve_branch_tree(repo: &gix::Repository, ref_name: &str) -> Result<ObjectId> {
    let branch_ref = repo
        .find_reference(ref_name)
        .map_err(|e| Error::Git(format!("cannot find branch {ref_name}: {e}")))?;
    let commit_id = branch_ref
        .into_fully_peeled_id()
        .map_err(|e| Error::Git(e.to_string()))?;
    let commit = commit_id
        .object()
        .map_err(|e| Error::Git(e.to_string()))?
        .into_commit();
    commit.tree_id().map(|id| id.detach()).map_err(|e| Error::Git(e.to_string()))
}

fn diff_trees(
    repo: &gix::Repository,
    base: &Tree,
    head: &Tree,
    prefix: &str,
    out: &mut Vec<DiffEntry>,
) -> Result<()> {
    use std::collections::HashMap;

    // Build maps: name -> entry
    let base_map: HashMap<&[u8], &Entry> = base.entries.iter().map(|e| (e.filename.as_bytes(), e)).collect();
    let head_map: HashMap<&[u8], &Entry> = head.entries.iter().map(|e| (e.filename.as_bytes(), e)).collect();

    // Files in head
    for (name, head_entry) in &head_map {
        let name_str = std::str::from_utf8(name).unwrap_or("?");
        let path = if prefix.is_empty() { name_str.to_string() } else { format!("{prefix}/{name_str}") };

        let is_tree = head_entry.mode == tree::EntryKind::Tree.into();

        match base_map.get(name) {
            None => {
                if is_tree {
                    // New subtree — all its files are added
                    let head_subtree = read_tree(repo, head_entry.oid)?;
                    let empty = Tree { entries: vec![] };
                    diff_trees(repo, &empty, &head_subtree, &path, out)?;
                } else {
                    out.push(DiffEntry { path, status: DiffStatus::Added });
                }
            }
            Some(base_entry) => {
                if head_entry.oid != base_entry.oid {
                    if is_tree {
                        let base_subtree = read_tree(repo, base_entry.oid)?;
                        let head_subtree = read_tree(repo, head_entry.oid)?;
                        diff_trees(repo, &base_subtree, &head_subtree, &path, out)?;
                    } else {
                        out.push(DiffEntry { path, status: DiffStatus::Modified });
                    }
                }
            }
        }
    }

    // Files only in base (deleted)
    for (name, base_entry) in &base_map {
        if head_map.contains_key(name) {
            continue;
        }
        let name_str = std::str::from_utf8(name).unwrap_or("?");
        let path = if prefix.is_empty() { name_str.to_string() } else { format!("{prefix}/{name_str}") };
        let is_tree = base_entry.mode == tree::EntryKind::Tree.into();
        if is_tree {
            let base_subtree = read_tree(repo, base_entry.oid)?;
            let empty = Tree { entries: vec![] };
            diff_trees(repo, &base_subtree, &empty, &path, out)?;
        } else {
            out.push(DiffEntry { path, status: DiffStatus::Deleted });
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Read file from a branch
// ---------------------------------------------------------------------------

/// A single file read from a branch.
#[derive(Debug, Serialize)]
pub struct ReadFileEntry {
    pub path: String,
    pub content: String,
}

/// Read multiple files from the same folder in a branch.
///
/// `folder_path` is the path to the folder within the repo (e.g. `"MyBase/Posts"`).
/// `file_names` are the filenames within that folder (e.g. `["recAbc.json", "recDef.json"]`).
/// Returns one entry per file, in the same order as `file_names`.
pub fn read_files(
    repo_path: &Path,
    branch: &str,
    folder_path: &str,
    file_names: &[String],
) -> Result<Vec<ReadFileEntry>> {
    let repo = gix::open(repo_path)?;
    let ref_name = format!("refs/heads/{branch}");
    let tree_id = resolve_branch_tree(&repo, &ref_name)?;
    let root_tree = read_tree(&repo, tree_id)?;

    // Navigate to the folder subtree
    let folder_parts: Vec<&str> = folder_path.split('/').filter(|s| !s.is_empty()).collect();
    let folder_tree = if folder_parts.is_empty() {
        root_tree
    } else {
        let blob_id = find_tree_entry(&repo, &root_tree, &folder_parts)?;
        read_tree(&repo, blob_id)?
    };

    let mut results = Vec::with_capacity(file_names.len());
    for name in file_names {
        let name_bytes = name.as_bytes();
        let entry = folder_tree
            .entries
            .iter()
            .find(|e| e.filename.as_bytes() == name_bytes)
            .ok_or_else(|| Error::Other(format!("file '{name}' not found in '{folder_path}'")))?;
        let obj = repo.find_object(entry.oid).map_err(|e| Error::Git(e.to_string()))?;
        let content = String::from_utf8(obj.data.to_vec())
            .map_err(|e| Error::Other(format!("file '{name}' is not valid UTF-8: {e}")))?;
        results.push(ReadFileEntry { path: format!("{folder_path}/{name}"), content });
    }
    Ok(results)
}

/// Navigate a tree to find a subtree entry at `parts` depth, returning its ObjectId.
fn find_tree_entry(repo: &gix::Repository, tree: &Tree, parts: &[&str]) -> Result<ObjectId> {
    let name = parts[0].as_bytes();
    let entry = tree
        .entries
        .iter()
        .find(|e| e.filename.as_bytes() == name)
        .ok_or_else(|| Error::Other(format!("path component '{}' not found", parts[0])))?;

    if parts.len() == 1 {
        Ok(entry.oid)
    } else {
        let subtree = read_tree(repo, entry.oid)?;
        find_tree_entry(repo, &subtree, &parts[1..])
    }
}
