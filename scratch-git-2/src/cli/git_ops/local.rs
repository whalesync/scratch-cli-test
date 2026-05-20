use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use anyhow::Context;

// Local Git helpers only deal with repository contents already on disk:
// resolving refs, reading trees, materializing files, and writing commits.
// Pure read helpers (open_bare_repo, read_tree_files, rev_parse_optional_to_string,
// FileMap) moved to `shared::git_local` in slice H.1.5 so shared::review_ops
// can use them without depending on cli/.
use super::{open_bare_repo, FileMap};

#[cfg(test)]
pub(crate) fn rev_parse_to_string(bare_repo: &Path, rev: &str) -> anyhow::Result<String> {
    let repo = open_bare_repo(bare_repo)?;
    let id = repo.rev_parse_single(rev).with_context(|| {
        format!(
            "failed to resolve revision {rev} in {}",
            bare_repo.display()
        )
    })?;
    Ok(id.detach().to_string())
}

pub(crate) fn merge_base_to_string(
    bare_repo: &Path,
    rev_a: &str,
    rev_b: &str,
) -> anyhow::Result<Option<String>> {
    let git_dir = bare_repo.to_str().unwrap_or_default();
    let output = Command::new("git")
        .args(["--git-dir", git_dir, "merge-base", rev_a, rev_b])
        .output()
        .context("failed to run git merge-base")?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok(None);
        }
        return Ok(Some(stdout));
    }

    // `git merge-base` exits 1 when there is no merge base.
    if output.status.code() == Some(1) {
        return Ok(None);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("git merge-base failed: {}", stderr.trim());
}

pub(crate) fn update_ref(bare_repo: &Path, refname: &str, object: &str) -> anyhow::Result<()> {
    let repo = open_bare_repo(bare_repo)?;
    let oid = gix::ObjectId::from_hex(object.as_bytes())
        .with_context(|| format!("invalid object id {object} for {refname}"))?;
    repo.reference(
        refname,
        oid,
        gix::refs::transaction::PreviousValue::Any,
        "scratchmd update-ref",
    )
    .with_context(|| format!("failed to update ref {refname} in {}", bare_repo.display()))?;
    Ok(())
}

pub(crate) fn commit_file_map_to_ref(
    bare_repo: &Path,
    refname: &str,
    parent_hash: Option<&str>,
    files: &FileMap,
    message: &str,
) -> anyhow::Result<String> {
    let repo = open_bare_repo(bare_repo)?;
    let tree_id = write_tree_from_file_map(&repo, files)?;
    let parents = parent_hash
        .into_iter()
        .map(|hash| {
            gix::ObjectId::from_hex(hash.as_bytes())
                .with_context(|| format!("invalid parent hash {hash} for {refname}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let time = gix::date::Time::now_local_or_utc();
    let author = gix::actor::SignatureRef {
        name: "Scratch CLI".into(),
        email: "cli@scratch.md".into(),
        time,
    };
    let commit = gix::objs::Commit {
        tree: tree_id,
        parents: parents.into(),
        author: author.to_owned(),
        committer: author.to_owned(),
        encoding: None,
        message: message.into(),
        extra_headers: vec![],
    };

    let commit_id = repo
        .write_object(&commit)
        .with_context(|| format!("failed to write commit for {refname}"))?;

    repo.reference(
        refname,
        commit_id.detach(),
        gix::refs::transaction::PreviousValue::Any,
        "scratchmd commit",
    )
    .with_context(|| format!("failed to update ref {refname} in {}", bare_repo.display()))?;

    Ok(commit_id.detach().to_string())
}

#[derive(Debug, Clone)]
enum TreeNode {
    Blob(gix::ObjectId),
    Dir(BTreeMap<String, TreeNode>),
}

fn write_tree_from_file_map(
    repo: &gix::Repository,
    files: &FileMap,
) -> anyhow::Result<gix::ObjectId> {
    let mut root = BTreeMap::new();
    for (path, content) in files {
        let blob_id = repo
            .write_blob(content)
            .with_context(|| format!("failed to write blob for {path}"))?
            .detach();
        insert_path(&mut root, path, blob_id)?;
    }
    write_tree_entries(repo, &root)
}

fn insert_path(
    entries: &mut BTreeMap<String, TreeNode>,
    path: &str,
    blob_id: gix::ObjectId,
) -> anyhow::Result<()> {
    let normalized = crate::shared::git_path::normalize_logical_git_path(path)
        .map_err(|e| anyhow::anyhow!(e))?;
    let parts: Vec<&str> = normalized.split('/').collect();
    insert_path_parts(entries, &parts, path, blob_id)
}

fn insert_path_parts(
    entries: &mut BTreeMap<String, TreeNode>,
    parts: &[&str],
    original_path: &str,
    blob_id: gix::ObjectId,
) -> anyhow::Result<()> {
    let part = parts[0];
    if matches!(part, "." | "..") {
        anyhow::bail!("invalid git path component {part} in {original_path}");
    }

    if parts.len() == 1 {
        match entries.insert(part.to_string(), TreeNode::Blob(blob_id)) {
            Some(TreeNode::Dir(_)) => {
                anyhow::bail!("path conflict inserting file {original_path}");
            }
            _ => Ok(()),
        }
    } else {
        let child = entries
            .entry(part.to_string())
            .or_insert_with(|| TreeNode::Dir(BTreeMap::new()));
        match child {
            TreeNode::Dir(children) => {
                insert_path_parts(children, &parts[1..], original_path, blob_id)
            }
            TreeNode::Blob(_) => anyhow::bail!("path conflict inserting file {original_path}"),
        }
    }
}

fn write_tree_entries(
    repo: &gix::Repository,
    entries: &BTreeMap<String, TreeNode>,
) -> anyhow::Result<gix::ObjectId> {
    let mut git_entries = Vec::with_capacity(entries.len());
    for (name, node) in entries {
        match node {
            TreeNode::Blob(oid) => {
                git_entries.push((name.clone(), gix::objs::tree::EntryKind::Blob, *oid));
            }
            TreeNode::Dir(children) => {
                let tree_id = write_tree_entries(repo, children)?;
                git_entries.push((name.clone(), gix::objs::tree::EntryKind::Tree, tree_id));
            }
        }
    }

    git_entries.sort_by(|a, b| {
        let a_name = if a.1 == gix::objs::tree::EntryKind::Tree {
            format!("{}/", a.0)
        } else {
            a.0.clone()
        };
        let b_name = if b.1 == gix::objs::tree::EntryKind::Tree {
            format!("{}/", b.0)
        } else {
            b.0.clone()
        };
        a_name.cmp(&b_name)
    });

    let mut tree = gix::objs::Tree::empty();
    for (name, kind, oid) in git_entries {
        tree.entries.push(gix::objs::tree::Entry {
            mode: kind.into(),
            filename: name.as_str().into(),
            oid,
        });
    }

    repo.write_object(&tree)
        .map(|id| id.detach())
        .with_context(|| "failed to write tree object")
}

/// Returns `(status, path)` pairs for files that differ between `from_treeish` and `to_treeish`.
/// Status is one of: `"added"`, `"deleted"`, `"modified"`, `"renamed"`.
/// Paths starting with `.scratch/` are excluded.
pub(crate) fn diff_name_status(
    bare_repo: &Path,
    from_treeish: &str,
    to_treeish: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let git_dir = bare_repo.to_str().unwrap_or_default();
    let output = Command::new("git")
        .args([
            "--git-dir",
            git_dir,
            "diff",
            "--name-status",
            from_treeish,
            to_treeish,
        ])
        .output()
        .context("failed to spawn git diff --name-status")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git diff --name-status failed: {}", stderr.trim());
    }

    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let Some(status_code) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else { continue };

        if path.starts_with(".scratch/") {
            continue;
        }

        // Renames look like "R100\told_path\tnew_path" — use the new path
        let path = if status_code.starts_with('R') || status_code.starts_with('C') {
            match parts.next() {
                Some(new_path) => new_path,
                None => path,
            }
        } else {
            path
        };

        let status = match status_code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('M') => "modified",
            Some('R') => "renamed",
            Some('C') => "modified",
            _ => continue,
        };

        entries.push((status.to_string(), path.to_string()));
    }

    Ok(entries)
}

/// Create a sparse git worktree at `worktree_path` tracking `refname`.
/// Excludes `.scratch/**` from checkout (data files only).
/// Removes and recreates the directory if it already exists.
pub(crate) fn setup_sparse_worktree(
    bare_repo: &Path,
    worktree_path: &Path,
    refname: &str,
) -> anyhow::Result<()> {
    let git_dir = bare_repo.to_str().unwrap_or_default();

    // Prune stale entries first so the path can be reused
    let _ = Command::new("git")
        .args(["--git-dir", git_dir, "worktree", "prune"])
        .output();

    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .with_context(|| format!("failed to remove {}", worktree_path.display()))?;
    }

    let output = Command::new("git")
        .args([
            "--git-dir",
            git_dir,
            "worktree",
            "add",
            "--no-checkout",
            "--force",
            worktree_path.to_str().unwrap_or_default(),
            refname,
        ])
        .output()
        .context("failed to spawn git worktree add")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree add failed: {}", stderr.trim());
    }

    // Configure sparse checkout (no-cone): include everything except .scratch/
    let output = Command::new("git")
        .args([
            "-C",
            worktree_path.to_str().unwrap_or_default(),
            "sparse-checkout",
            "init",
            "--no-cone",
        ])
        .output()
        .context("failed to spawn git sparse-checkout init")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git sparse-checkout init failed: {}", stderr.trim());
    }

    let output = Command::new("git")
        .args([
            "-C",
            worktree_path.to_str().unwrap_or_default(),
            "sparse-checkout",
            "set",
            "--no-cone",
            "/*",
            "!.scratch",
        ])
        .output()
        .context("failed to spawn git sparse-checkout set")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git sparse-checkout set failed: {}", stderr.trim());
    }

    // Initial checkout
    let output = Command::new("git")
        .args(["-C", worktree_path.to_str().unwrap_or_default(), "checkout"])
        .output()
        .context("failed to spawn git checkout")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git checkout failed: {}", stderr.trim());
    }

    Ok(())
}

/// Create a non-sparse git worktree at `worktree_path` tracking `refname`.
/// All files in the ref's tree get checked out (including `.scratch/`).
/// Removes and recreates the directory if it already exists.
fn setup_full_worktree(
    bare_repo: &Path,
    worktree_path: &Path,
    refname: &str,
) -> anyhow::Result<()> {
    let git_dir = bare_repo.to_str().unwrap_or_default();

    // Prune stale worktree entries first so the path can be reused.
    let _ = Command::new("git")
        .args(["--git-dir", git_dir, "worktree", "prune"])
        .output();

    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .with_context(|| format!("failed to remove {}", worktree_path.display()))?;
    }

    let output = Command::new("git")
        .args([
            "--git-dir",
            git_dir,
            "worktree",
            "add",
            "--force",
            worktree_path.to_str().unwrap_or_default(),
            refname,
        ])
        .output()
        .context("failed to spawn git worktree add")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree add failed: {}", stderr.trim());
    }
    Ok(())
}

/// Idempotent variant of [`setup_full_worktree`]. Returns `Ok(())` without
/// rebuilding when `worktree_path` is already a valid worktree (has a `.git`
/// gitlink and `HEAD` resolves). Fails loudly when the directory exists but
/// is broken — caller should `workspaces unsync` to clear it manually rather
/// than silently nuking user state.
pub(crate) fn ensure_full_worktree(
    bare_repo: &Path,
    worktree_path: &Path,
    refname: &str,
) -> anyhow::Result<()> {
    if worktree_path.exists() {
        let gitlink = worktree_path.join(".git");
        if gitlink.is_file() {
            // Looks like a worktree; verify HEAD resolves before declaring it OK.
            let output = Command::new("git")
                .args([
                    "-C",
                    worktree_path.to_str().unwrap_or_default(),
                    "rev-parse",
                    "HEAD",
                ])
                .output();
            if let Ok(o) = output {
                if o.status.success() {
                    return Ok(());
                }
            }
            anyhow::bail!(
                "{} exists but isn't a valid worktree (HEAD doesn't resolve) — remove it with `scratchmd workspaces unsync` and re-run init",
                worktree_path.display()
            );
        } else if worktree_path
            .read_dir()
            .is_ok_and(|mut e| e.next().is_some())
        {
            anyhow::bail!(
                "{} exists and is non-empty but isn't a git worktree (no .git gitlink) — remove it with `scratchmd workspaces unsync` and re-run init",
                worktree_path.display()
            );
        } else {
            // Empty directory (probably created by an aborted prior init).
            // Remove so `git worktree add` doesn't fail with "destination
            // already exists".
            std::fs::remove_dir(worktree_path).ok();
        }
    }
    setup_full_worktree(bare_repo, worktree_path, refname)
}

/// `git reset --mixed <hash>` in a worktree. Updates HEAD + the index to
/// match the commit, but does NOT touch the working tree. Used to refresh
/// the index after `materialize_local_repo` wrote new working files, so
/// `gix::status` returns accurate results.
pub(crate) fn worktree_reset_mixed(worktree_path: &Path, hash: &str) -> anyhow::Result<()> {
    let output = Command::new("git")
        .args([
            "-C",
            worktree_path.to_str().unwrap_or_default(),
            "reset",
            "--mixed",
            hash,
        ])
        .output()
        .context("failed to spawn git reset --mixed")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git reset --mixed failed: {}", stderr.trim());
    }
    Ok(())
}

/// `git -C <worktree> checkout <refname> -- <pathspec>` — restore the named
/// path(s) in the worktree to whatever the ref has them at, without touching
/// anything else in the working tree. Used post-pull to refresh the worktree's
/// tracked `.scratch/` directory (schemas, views) after `refs/heads/main`
/// advances. Returns `Ok(())` when the pathspec didn't match anything (git
/// exits 0 for an empty pathspec in this mode).
pub(crate) fn worktree_checkout_path(
    worktree_path: &Path,
    refname: &str,
    pathspec: &str,
) -> anyhow::Result<()> {
    let output = Command::new("git")
        .args([
            "-C",
            worktree_path.to_str().unwrap_or_default(),
            "checkout",
            refname,
            "--",
            pathspec,
        ])
        .output()
        .context("failed to spawn git checkout <ref> -- <pathspec>")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "did not match any file(s) known to git" is benign — the worktree
        // simply doesn't have that path on this ref (e.g. fresh workspace
        // with no .scratch/ committed yet). Treat as success.
        if stderr.contains("did not match any file") {
            return Ok(());
        }
        anyhow::bail!("git checkout <ref> -- <pathspec> failed: {}", stderr.trim());
    }
    Ok(())
}
