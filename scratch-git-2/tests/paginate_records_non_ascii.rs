//! DEV-10402 end-to-end regression test through the real `scratchmd` binary.
//!
//! A workbook whose external data uses non-ASCII folder/file names rendered
//! incorrectly because git's default `core.quotePath=on` octal-escaped the
//! paths in `ls-tree` output and downstream parsing then mangled them
//! (`Pakkamælingar` → `Pakkam/303/246lingar`). The desktop FolderTree split the
//! corrupted path into phantom nested folders and the real folder read empty.
//!
//! `paginate-records --reindex` rebuilds a folder's index from the bare repo's
//! `refs/heads/main` tree via `read_tree_files_filtered` (→ `git ls-tree`). The
//! compiled binary does NOT include the in-crate `#[cfg(test)]` escape hatch in
//! `folder_index.rs`, so this genuinely exercises the `ls-tree` parsing path —
//! the same code the desktop's napi binding uses. With the bug, the records
//! under the non-ASCII folder never make it into `filenames` (the folder reads
//! empty); with the fix they round-trip verbatim.

use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

const REPO_ID: &str = "conn1";
const CONN_DIR: &str = "Conn";
const NON_ASCII_FILE: &str = "skýrsla.json";
const SPACE_FILE: &str = "has space.json";
/// A working-tree-only record. Its presence makes the index's incremental
/// refresh take the "slow path" that reads `refs/heads/main` — without it,
/// a fresh `--reindex` over an empty working tree never touches `ls-tree`.
const WORKING_FILE: &str = "working-only.json";

fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .unwrap_or_else(|err| panic!("failed to spawn git {args:?}: {err}"));
    assert!(status.success(), "git {args:?} failed in {}", cwd.display());
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, contents).unwrap();
}

/// Build a workspace on disk that `paginate-records` can resolve:
///   <ws>/.repos/conn1.git                      bare repo, `main` carries the
///                                              non-ASCII records (main-only)
///   <ws>/.scratch/.scratchmd                   workspace marker (Conn → conn1)
///   <ws>/Conn/Pakkamælingar/working-only.json  a working-tree record
/// The bare repo's tree is rooted at the connection content, so the records
/// live at `Pakkamælingar/<file>` (folder arg is `Conn/Pakkamælingar`).
///
/// The non-ASCII records exist ONLY in `main`, so they reach `filenames` solely
/// via the `git ls-tree` read (`read_tree_files_filtered`). With the DEV-10402
/// bug their main-tree key came back mangled (`Pakkam/303/246lingar/...`), failed
/// the `Pakkamælingar/` prefix match, and the folder read empty. The
/// working-only record is what makes the index take the main-reading slow path.
fn build_workspace() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let workspace = tmp.path().to_path_buf();

    // Source worktree → commit non-ASCII records on `main`.
    let source = workspace.join("source");
    std::fs::create_dir_all(&source).unwrap();
    run_git(&source, &["init", "-b", "main"]);
    write_file(
        &source.join("Pakkamælingar").join(NON_ASCII_FILE),
        "{\"r\":1}",
    );
    write_file(&source.join("Pakkamælingar").join(SPACE_FILE), "{\"r\":2}");
    run_git(&source, &["add", "-A"]);
    run_git(
        &source,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@t",
            "commit",
            "-m",
            "seed non-ascii records",
        ],
    );

    // Clone into the layout `WorkspaceLayout::for_cli` resolves:
    // <ws>/.repos/<repoPath>.git.
    let bare = workspace.join(".repos").join(format!("{REPO_ID}.git"));
    std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
    run_git(
        &workspace,
        &[
            "clone",
            "--bare",
            source.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );

    // Workspace marker mapping the connection dir name to the bare repo id.
    let marker = format!(
        "version: \"3\"\n\
         workbook:\n  id: wkb_test\n  name: Test\n  orgId: org_test\n  serverUrl: http://localhost\n  initializedAt: 2026-01-01T00:00:00Z\n\
         connections:\n  - id: conn_test\n    displayName: Conn\n    service: AIRTABLE\n    repoPath: {REPO_ID}\n    dirName: {CONN_DIR}\n"
    );
    let scratch_dir = workspace.join(".scratch");
    std::fs::create_dir_all(&scratch_dir).unwrap();
    std::fs::write(scratch_dir.join(".scratchmd"), marker).unwrap();

    // A working-tree record so the index's refresh takes the main-reading path.
    write_file(
        &workspace
            .join(CONN_DIR)
            .join("Pakkamælingar")
            .join(WORKING_FILE),
        "{\"r\":4}",
    );

    (tmp, workspace)
}

fn run_paginate_records(
    workspace: &Path,
    db_path: &Path,
) -> (std::process::ExitStatus, String, String) {
    let binary = env!("CARGO_BIN_EXE_scratchmd");
    let output = Command::new(binary)
        .args([
            "paginate-records",
            "--workspace",
            workspace.to_str().unwrap(),
            "--folder",
            &format!("{CONN_DIR}/Pakkamælingar"),
            "--limit",
            "100",
            "--offset",
            "0",
            "--reindex",
            "--db-path",
            db_path.to_str().unwrap(),
        ])
        .output()
        .unwrap_or_else(|e| panic!("failed to run scratchmd: {e}"));
    (
        output.status,
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn paginate_records_lists_non_ascii_folder_records() {
    if !git_available() {
        eprintln!("skipping git-dependent test: git executable not available");
        return;
    }

    let (_tmp, workspace) = build_workspace();
    let db_path = workspace.join("index.db");
    let (status, stdout, stderr) = run_paginate_records(&workspace, &db_path);

    assert!(
        status.success(),
        "paginate-records failed: status={status:?}\nstdout={stdout}\nstderr={stderr}"
    );

    let result: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("stdout was not JSON ({e}): {stdout}"));
    let filenames: Vec<String> = result["filenames"]
        .as_array()
        .unwrap_or_else(|| panic!("missing filenames array in {stdout}"))
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    // The main-only, non-ASCII records reach `filenames` only through the
    // `git ls-tree` read, so their presence proves the path round-tripped
    // verbatim (no octal escapes, no phantom nesting, folder not empty).
    assert!(
        filenames.contains(&NON_ASCII_FILE.to_string()),
        "expected main-only {NON_ASCII_FILE:?} in {filenames:?}"
    );
    assert!(
        filenames.contains(&SPACE_FILE.to_string()),
        "expected main-only {SPACE_FILE:?} in {filenames:?}"
    );
    // Sanity: the working-tree record that triggered the slow path is there too.
    assert!(
        filenames.contains(&WORKING_FILE.to_string()),
        "expected working {WORKING_FILE:?} in {filenames:?}"
    );
    assert!(
        result["filtered_total"].as_i64().unwrap_or(0) >= 3,
        "filtered_total should be >= 3: {stdout}"
    );
    for filename in &filenames {
        assert!(
            !filename.contains('\\') && !filename.contains("303") && !filename.contains("246"),
            "filename looks octal-escaped/mangled: {filename:?}"
        );
    }
}
