//! Pure git read helpers — open the bare repo, resolve a revision, read a
//! tree's blobs into a `FileMap`. Lives in `shared/` so `shared::review_ops`'s
//! public entry points can drive accept/discard end-to-end without depending
//! on `cli/git_ops`. The cli's full git surface (worktree-add, fetch, push,
//! merge-base, ref mutation) stays in `cli/git_ops/` — those are orchestration
//! concerns the napi binding doesn't need.
//!
//! Added in slice H.1.5 to unblock the I/O-bundling public entry points in
//! `shared::review_ops`. See `docs/plans/2026-05-20-slice-h-spec.md`.

// The service binary doesn't reach into these helpers (it has its own service-
// side git surface). Mirrors the same pattern `shared::review_ops` uses.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read as IoRead, Write as IoWrite};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::Context;

/// Map of repo-relative path → file content. Mirrors what `git ls-tree` /
/// `git cat-file --batch` produces for a tree, and what `read_dirty_disk` /
/// `read_scratch_disk` produce for the on-disk working tree. Re-exported by
/// `shared::review_ops::FileMap` for back-compat with the existing callers.
pub type FileMap = HashMap<String, Vec<u8>>;

pub fn open_bare_repo(bare_repo: &Path) -> anyhow::Result<gix::Repository> {
    gix::open(bare_repo.to_path_buf())
        .with_context(|| format!("failed to open git repo {}", bare_repo.display()))
}

/// Resolve `rev` to a hex object id, returning `None` when the revision does
/// not exist (e.g. a branch ref that hasn't been created yet). Errors only
/// when the repo itself can't be opened.
pub fn rev_parse_optional_to_string(bare_repo: &Path, rev: &str) -> anyhow::Result<Option<String>> {
    let repo = open_bare_repo(bare_repo)?;
    match repo.rev_parse_single(rev) {
        Ok(id) => Ok(Some(id.detach().to_string())),
        Err(_) => Ok(None),
    }
}

/// Read all blob contents for a tree using `git ls-tree` piped into
/// `git cat-file --batch`. This is dramatically faster than per-blob lookups
/// via gix for large repos (e.g. 0.5s vs 39s for 23k files).
pub fn read_tree_files(bare_repo: &Path, treeish: &str) -> anyhow::Result<FileMap> {
    read_tree_files_filtered(bare_repo, treeish, |_| true)
}

/// Like [`read_tree_files`] but only reads blobs whose path matches `keep`.
/// `ls-tree` still enumerates the whole tree (cheap — it's just metadata),
/// but `cat-file --batch` only processes the matching subset. For "load 100
/// records out of a 38k-record folder" this is the difference between
/// reading 200 MB and reading 500 KB.
pub fn read_tree_files_filtered<F>(
    bare_repo: &Path,
    treeish: &str,
    keep: F,
) -> anyhow::Result<FileMap>
where
    F: Fn(&str) -> bool,
{
    let git_dir = bare_repo.to_str().unwrap_or_default();

    // Step 1: enumerate (mode, hash, path) entries via ls-tree.
    let ls_output = Command::new("git")
        .args(["--git-dir", git_dir, "ls-tree", "-r", treeish])
        .output()
        .context("failed to run git ls-tree")?;
    if !ls_output.status.success() {
        let stderr = String::from_utf8_lossy(&ls_output.stderr);
        anyhow::bail!("git ls-tree failed: {}", stderr.trim());
    }

    let mut entries: Vec<(String, String)> = Vec::new();
    for line in ls_output.stdout.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let line_str = String::from_utf8_lossy(line);
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
        if !keep(path) {
            continue;
        }
        let hash = parts[2];
        entries.push((hash.to_string(), path.to_string()));
    }

    if entries.is_empty() {
        return Ok(FileMap::new());
    }

    // Step 2: pipe all hashes through `git cat-file --batch`.
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

    // Write hashes from a worker thread so the read side can't deadlock.
    let hashes: Vec<String> = entries.iter().map(|(h, _)| h.clone()).collect();
    let writer_thread = std::thread::spawn(move || -> anyhow::Result<()> {
        for hash in &hashes {
            writeln!(stdin, "{}", hash)?;
        }
        drop(stdin);
        Ok(())
    });

    let mut reader = BufReader::new(stdout);
    let mut out = FileMap::new();
    let mut header_buf = String::new();

    for (_hash, path) in &entries {
        header_buf.clear();
        reader
            .read_line(&mut header_buf)
            .context("failed to read cat-file header")?;
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

        // cat-file emits a trailing newline after each blob.
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
