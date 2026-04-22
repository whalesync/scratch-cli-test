use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read as IoRead, Write as IoWrite};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::Context;

// Local Git helpers only deal with repository contents already on disk:
// resolving refs, reading trees, materializing files, and writing commits.
use super::{open_bare_repo, FileMap};

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

pub(crate) fn rev_parse_optional_to_string(
    bare_repo: &Path,
    rev: &str,
) -> anyhow::Result<Option<String>> {
    let repo = open_bare_repo(bare_repo)?;
    match repo.rev_parse_single(rev) {
        Ok(id) => Ok(Some(id.detach().to_string())),
        Err(_) => Ok(None),
    }
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

pub(crate) fn read_tree_files(bare_repo: &Path, treeish: &str) -> anyhow::Result<FileMap> {
    read_tree_files_batched(bare_repo, treeish)
}

/// Read all blob contents for a tree using `git ls-tree` piped into
/// `git cat-file --batch`. This is dramatically faster than per-blob
/// lookups via gix for large repos (e.g. 0.5s vs 39s for 23k files).
fn read_tree_files_batched(bare_repo: &Path, treeish: &str) -> anyhow::Result<FileMap> {
    let git_dir = bare_repo.to_str().unwrap_or_default();

    // Step 1: Get the list of (mode, hash, path) entries via ls-tree.
    let ls_output = Command::new("git")
        .args(["--git-dir", git_dir, "ls-tree", "-r", treeish])
        .output()
        .context("failed to run git ls-tree")?;
    if !ls_output.status.success() {
        let stderr = String::from_utf8_lossy(&ls_output.stderr);
        anyhow::bail!("git ls-tree failed: {}", stderr.trim());
    }

    // Parse ls-tree output: "<mode> <type> <hash>\t<path>\n"
    let mut entries: Vec<(String, String)> = Vec::new(); // (hash, path)
    for line in ls_output.stdout.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let line_str = String::from_utf8_lossy(line);
        // Format: "100644 blob <hash>\t<path>"
        let Some(tab_pos) = line_str.find('\t') else {
            continue;
        };
        let meta = &line_str[..tab_pos];
        let path = &line_str[tab_pos + 1..];

        let parts: Vec<&str> = meta.split(' ').collect();
        if parts.len() < 3 {
            continue;
        }
        let obj_type = parts[1];
        if obj_type != "blob" {
            continue;
        }
        let hash = parts[2];
        entries.push((hash.to_string(), path.to_string()));
    }

    if entries.is_empty() {
        return Ok(FileMap::new());
    }

    // Step 2: Feed all hashes into `git cat-file --batch` to read blob contents.
    let mut cat_file = Command::new("git")
        .args(["--git-dir", git_dir, "cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .context("failed to spawn git cat-file --batch")?;

    let mut stdin = cat_file
        .stdin
        .take()
        .context("failed to open cat-file stdin")?;
    let stdout = cat_file
        .stdout
        .take()
        .context("failed to open cat-file stdout")?;

    // Write all hashes to stdin in a separate thread to avoid deadlock.
    let hashes: Vec<String> = entries.iter().map(|(h, _)| h.clone()).collect();
    let writer_thread = std::thread::spawn(move || -> anyhow::Result<()> {
        for hash in &hashes {
            writeln!(stdin, "{}", hash)?;
        }
        drop(stdin); // Close stdin to signal EOF
        Ok(())
    });

    // Read responses from stdout.
    let mut reader = BufReader::new(stdout);
    let mut out = FileMap::new();
    let mut header_buf = String::new();

    for (_hash, path) in &entries {
        header_buf.clear();
        reader
            .read_line(&mut header_buf)
            .context("failed to read cat-file header")?;
        // Header format: "<hash> <type> <size>\n"
        let header = header_buf.trim_end();
        let size: usize = header
            .rsplit(' ')
            .next()
            .and_then(|s| s.parse().ok())
            .with_context(|| format!("failed to parse cat-file header: {header}"))?;

        let mut blob = vec![0u8; size];
        reader
            .read_exact(&mut blob)
            .context("failed to read cat-file blob data")?;

        // cat-file emits a trailing newline after each blob
        let mut trailing = [0u8; 1];
        reader.read_exact(&mut trailing).ok();

        out.insert(path.replace('\\', "/"), normalize_crlf(blob));
    }

    writer_thread
        .join()
        .map_err(|_| anyhow::anyhow!("cat-file writer thread panicked"))??;

    let status = cat_file.wait().context("failed to wait for cat-file")?;
    if !status.success() {
        anyhow::bail!("git cat-file --batch exited with status {}", status);
    }

    Ok(out)
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

/// Set up a sparse worktree only if one does not already exist at `worktree_path`.
pub(crate) fn ensure_sparse_worktree(
    bare_repo: &Path,
    worktree_path: &Path,
    refname: &str,
) -> anyhow::Result<()> {
    if worktree_path.join(".git").is_file() {
        return Ok(());
    }
    setup_sparse_worktree(bare_repo, worktree_path, refname)
}

/// `git reset --hard <hash>` in a worktree (updates HEAD, index, and working tree).
pub(crate) fn worktree_reset_hard(worktree_path: &Path, hash: &str) -> anyhow::Result<()> {
    let output = Command::new("git")
        .args([
            "-C",
            worktree_path.to_str().unwrap_or_default(),
            "reset",
            "--hard",
            hash,
        ])
        .output()
        .context("failed to spawn git reset --hard")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git reset --hard failed: {}", stderr.trim());
    }
    Ok(())
}

/// `git reset --mixed <hash>` in a worktree (updates HEAD and index; leaves working tree intact).
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

pub(crate) struct WorktreeStatusEntry {
    pub(crate) x: u8,
    pub(crate) y: u8,
    pub(crate) path: String,
}

/// Returns git status entries for the worktree using `--porcelain=v1 -z`.
/// Returns an empty list if `worktree_path` is not a git worktree.
pub(crate) fn worktree_status_entries(
    worktree_path: &Path,
) -> anyhow::Result<Vec<WorktreeStatusEntry>> {
    if !worktree_path.join(".git").is_file() {
        return Ok(vec![]);
    }

    let output = Command::new("git")
        .args([
            "-C",
            worktree_path.to_str().unwrap_or_default(),
            "status",
            "--porcelain=v1",
            "-z",
        ])
        .output()
        .context("failed to spawn git status")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git status failed: {}", stderr.trim());
    }

    let mut entries = Vec::new();
    let bytes = &output.stdout;
    let mut i = 0;

    while i < bytes.len() {
        if i + 3 > bytes.len() {
            break;
        }
        let x = bytes[i];
        let y = bytes[i + 1];
        // bytes[i+2] is a space separator
        let path_start = i + 3;
        let Some(nul_offset) = bytes[path_start..].iter().position(|&b| b == 0) else {
            break;
        };
        let path =
            String::from_utf8_lossy(&bytes[path_start..path_start + nul_offset]).into_owned();
        i = path_start + nul_offset + 1;

        // Renames / copies have a second NUL-terminated original path — consume it
        if x == b'R' || x == b'C' {
            if let Some(nul2) = bytes[i..].iter().position(|&b| b == 0) {
                i += nul2 + 1;
            }
        }

        entries.push(WorktreeStatusEntry { x, y, path });
    }

    Ok(entries)
}

fn normalize_crlf(mut bytes: Vec<u8>) -> Vec<u8> {
    if bytes.windows(2).any(|window| window == b"\r\n") {
        let mut normalized = Vec::with_capacity(bytes.len());
        let mut idx = 0usize;
        while idx < bytes.len() {
            if idx + 1 < bytes.len() && bytes[idx] == b'\r' && bytes[idx + 1] == b'\n' {
                normalized.push(b'\n');
                idx += 2;
            } else {
                normalized.push(bytes[idx]);
                idx += 1;
            }
        }
        bytes = normalized;
    }
    bytes
}
