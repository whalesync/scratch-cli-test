use std::path::Path;

use anyhow::Context;

use crate::shared::git_exec::git_command;

// Local Git helpers only deal with repository contents already on disk:
// resolving refs, reading trees, materializing files, and writing commits.
// Pure read helpers (open_bare_repo, read_tree_files, rev_parse_optional_to_string,
// FileMap) moved to `shared::git_local` in slice H.1.5 so shared::review_ops
// can use them without depending on cli/.
use super::open_bare_repo;
#[cfg(test)]
use crate::shared::git_local::FileMap;
#[cfg(test)]
use std::collections::BTreeMap;

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

// ── Test-only fixture builder ───────────────────────────────────────────────
//
// Slice F.5 deleted the production `commit_file_map_to_ref` along with the
// `force_upload_single_repo` + `commit_file_map_to_dirty_ref` chain that
// called it. Several download/discard tests in `cli/commands/tests/files.rs`
// still need to seed known trees into the bare repo's `dirty` ref to set up
// state for testing other paths (those tests don't exercise the production
// commit-to-dirty path; they use the helper as a fixture builder). Restored
// here under `#[cfg(test)]` so it never appears in the production binary.

#[cfg(test)]
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

#[cfg(test)]
#[derive(Debug, Clone)]
enum TreeNode {
    Blob(gix::ObjectId),
    Dir(BTreeMap<String, TreeNode>),
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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
    let output = git_command()
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

/// Returns `(status, path)` pairs for working-tree files under `path_prefix` that differ from
/// `HEAD` in `worktree_dir` — i.e. uncommitted local edits, which `diff_name_status` (which only
/// diffs two committed tree-ish refs) cannot see. Runs `git -C <worktree> status --porcelain
/// --untracked-files=all -- <prefix>`. Status is normalized to `"added"` (new/untracked),
/// `"deleted"`, or `"modified"`. Paths are repo-relative (e.g. `routines/foo.yaml`); `.scratch/`
/// is excluded for safety even though the pathspec already scopes the result.
///
/// `--untracked-files=all` is required: without it git collapses an entirely-new untracked
/// directory to a single `?? routines/` entry instead of listing each file, which would break the
/// "create the first routine in a fresh workspace" case.
pub(crate) fn worktree_status_porcelain(
    worktree_dir: &Path,
    path_prefix: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let worktree = worktree_dir.to_str().unwrap_or_default();
    let output = git_command()
        .args([
            "-C",
            worktree,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            path_prefix,
        ])
        .output()
        .context("failed to spawn git status --porcelain")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git status --porcelain failed: {}", stderr.trim());
    }

    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        // Porcelain v1 lines are `XY <path>` (2 status chars, a space, then the path). Untracked
        // files use `??`; renames look like `R  old -> new`.
        if line.len() < 4 {
            continue;
        }
        let status_code = &line[0..2];
        let mut path = &line[3..];

        // For a rename/copy, the porcelain path is `old -> new`; report the new path.
        if let Some(arrow) = path.find(" -> ") {
            path = &path[arrow + 4..];
        }

        if path.starts_with(".scratch/") {
            continue;
        }

        // Classify on either status column: a deletion in either, otherwise an add (untracked or
        // staged-new), otherwise a modification.
        let status = if status_code.contains('D') {
            "deleted"
        } else if status_code == "??" || status_code.contains('A') {
            "added"
        } else {
            "modified"
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
    let _ = git_command()
        .args(["--git-dir", git_dir, "worktree", "prune"])
        .output();

    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .with_context(|| format!("failed to remove {}", worktree_path.display()))?;
    }

    let output = git_command()
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
    let output = git_command()
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

    let output = git_command()
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
    let output = git_command()
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
    let _ = git_command()
        .args(["--git-dir", git_dir, "worktree", "prune"])
        .output();

    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .with_context(|| format!("failed to remove {}", worktree_path.display()))?;
    }

    let output = git_command()
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
            let output = git_command()
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
    let output = git_command()
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
    let output = git_command()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn git_available() -> bool {
        git_command().arg("--version").output().is_ok()
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = git_command()
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap_or_else(|err| panic!("failed to spawn git {args:?}: {err}"));
        assert!(status.success(), "git {args:?} failed in {}", cwd.display());
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn commit_all(cwd: &Path, message: &str) {
        run_git(cwd, &["add", "-A"]);
        run_git(
            cwd,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@t",
                "commit",
                "-m",
                message,
            ],
        );
    }

    fn init_source(tmp: &Path) -> PathBuf {
        let source = tmp.join("source");
        fs::create_dir_all(&source).unwrap();
        run_git(&source, &["init", "-b", "main"]);
        source
    }

    /// Clone the fully-committed source worktree into a bare repo so
    /// `diff_name_status` can resolve both `main~1` and `main`.
    fn clone_bare(tmp: &Path, source: &Path) -> PathBuf {
        let bare = tmp.join("bare.git");
        run_git(
            tmp,
            &[
                "clone",
                "--bare",
                source.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        bare
    }

    const NON_ASCII_PATH: &str = "Pakkamælingar/skýrsla.json";
    const NON_ASCII_RENAMED_PATH: &str = "Pakkamælingar/nýskýrsla.json";

    fn assert_no_octal_escapes(entries: &[(String, String)]) {
        for (_status, path) in entries {
            assert!(
                !path.contains('\\') && !path.contains("303") && !path.contains("246"),
                "path looks octal-escaped: {path:?}"
            );
        }
    }

    #[test]
    fn diff_name_status_added_non_ascii() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join("base.json"), "{}");
        commit_all(&source, "base");
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":1}");
        commit_all(&source, "add non-ascii");
        let bare = clone_bare(tmp.path(), &source);

        let entries = diff_name_status(&bare, "main~1", "main").unwrap();
        assert_eq!(
            entries,
            vec![("added".to_string(), NON_ASCII_PATH.to_string())]
        );
    }

    #[test]
    fn diff_name_status_modified_non_ascii() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":1}");
        commit_all(&source, "base");
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":2}");
        commit_all(&source, "modify non-ascii");
        let bare = clone_bare(tmp.path(), &source);

        let entries = diff_name_status(&bare, "main~1", "main").unwrap();
        assert_eq!(
            entries,
            vec![("modified".to_string(), NON_ASCII_PATH.to_string())]
        );
    }

    #[test]
    fn diff_name_status_deleted_non_ascii() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":1}");
        commit_all(&source, "base");
        fs::remove_file(source.join(NON_ASCII_PATH)).unwrap();
        commit_all(&source, "delete non-ascii");
        let bare = clone_bare(tmp.path(), &source);

        let entries = diff_name_status(&bare, "main~1", "main").unwrap();
        assert_eq!(
            entries,
            vec![("deleted".to_string(), NON_ASCII_PATH.to_string())]
        );
    }

    #[test]
    fn worktree_status_porcelain_classifies_and_scopes_routine_changes() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(
            &source.join("routines/keep.yaml"),
            "name: Keep\nsteps:\n  - action: pull\n",
        );
        write_file(
            &source.join("routines/remove.yaml"),
            "name: Remove\nsteps:\n  - action: pull\n",
        );
        write_file(&source.join("syncs/other.json"), "{}");
        commit_all(&source, "base");

        // Uncommitted local edits: one modified, one new (untracked), one deleted — plus an
        // out-of-scope change under syncs/ that the `routines/` pathspec must exclude.
        write_file(
            &source.join("routines/keep.yaml"),
            "name: Keep edited\nsteps:\n  - action: sync\n",
        );
        write_file(
            &source.join("routines/new.yaml"),
            "name: New\nsteps:\n  - action: pull\n",
        );
        fs::remove_file(source.join("routines/remove.yaml")).unwrap();
        write_file(&source.join("syncs/other.json"), "{\"x\":1}");

        let mut entries = worktree_status_porcelain(&source, "routines/").unwrap();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                ("added".to_string(), "routines/new.yaml".to_string()),
                ("deleted".to_string(), "routines/remove.yaml".to_string()),
                ("modified".to_string(), "routines/keep.yaml".to_string()),
            ]
        );
    }

    #[test]
    fn worktree_status_porcelain_lists_files_in_an_entirely_new_untracked_dir() {
        // Regression: without `--untracked-files=all`, git collapses a wholly-untracked directory
        // to a single `?? routines/` entry. This is the "first routine in a fresh workspace" case.
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join("README.md"), "seed\n");
        commit_all(&source, "base");

        // routines/ does not exist in the repo yet — create two files under it.
        write_file(
            &source.join("routines/a.yaml"),
            "name: A\nsteps:\n  - action: pull\n",
        );
        write_file(
            &source.join("routines/b.yaml"),
            "name: B\nsteps:\n  - action: pull\n",
        );

        let mut entries = worktree_status_porcelain(&source, "routines/").unwrap();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                ("added".to_string(), "routines/a.yaml".to_string()),
                ("added".to_string(), "routines/b.yaml".to_string()),
            ]
        );
    }

    #[test]
    fn worktree_status_porcelain_clean_worktree_is_empty() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(
            &source.join("routines/a.yaml"),
            "name: A\nsteps:\n  - action: pull\n",
        );
        commit_all(&source, "base");

        let entries = worktree_status_porcelain(&source, "routines/").unwrap();
        assert!(
            entries.is_empty(),
            "expected clean worktree, got {entries:?}"
        );
    }

    #[test]
    fn diff_name_status_renamed_non_ascii() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":1}");
        commit_all(&source, "base");
        // Identical content so git scores the rename at 100%.
        run_git(&source, &["mv", NON_ASCII_PATH, NON_ASCII_RENAMED_PATH]);
        commit_all(&source, "rename non-ascii");
        let bare = clone_bare(tmp.path(), &source);

        let entries = diff_name_status(&bare, "main~1", "main").unwrap();
        assert_no_octal_escapes(&entries);
        // The new path must always round-trip as UTF-8, regardless of whether
        // the environment's `diff.renames` is on (single "renamed" entry) or
        // off (delete + add).
        assert!(
            entries.iter().any(|(_, p)| p == NON_ASCII_RENAMED_PATH),
            "renamed-to path missing: {entries:?}"
        );
        // When rename detection fires (git default), it must carry the new path
        // — this exercises the third-tab-field extraction with a UTF-8 name.
        for (status, path) in &entries {
            if status == "renamed" {
                assert_eq!(path, NON_ASCII_RENAMED_PATH);
            }
        }
    }

    #[test]
    fn diff_name_status_strips_scratch_entries() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join("base.json"), "{}");
        commit_all(&source, "base");
        write_file(&source.join(".scratch/foo.json"), "{}");
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":1}");
        commit_all(&source, "add scratch + data");
        let bare = clone_bare(tmp.path(), &source);

        let entries = diff_name_status(&bare, "main~1", "main").unwrap();
        assert_eq!(
            entries,
            vec![("added".to_string(), NON_ASCII_PATH.to_string())],
            ".scratch/ entries must be excluded"
        );
    }

    #[test]
    fn diff_name_status_no_octal_escapes_in_any_path() {
        if !git_available() {
            eprintln!("skipping git-dependent test");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let source = init_source(tmp.path());
        write_file(&source.join("base.json"), "{}");
        commit_all(&source, "base");
        write_file(&source.join(NON_ASCII_PATH), "{\"r\":1}");
        write_file(&source.join("Pakkamælingar/has space.json"), "{\"r\":2}");
        commit_all(&source, "add non-ascii files");
        let bare = clone_bare(tmp.path(), &source);

        let entries = diff_name_status(&bare, "main~1", "main").unwrap();
        assert!(!entries.is_empty(), "expected diff entries");
        assert_no_octal_escapes(&entries);
    }
}
