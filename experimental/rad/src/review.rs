//! Accept / reject / discard for a single record.
//!
//! Mirrors the CLI's whole-record review handlers (`run_accept` / `run_reject`
//! / `run_discard`) but reuses `scratch-git-2`'s shared functions directly, so
//! the published → approved → local ladder stays correct by construction:
//!
//! - **accept**  — recompute the published→working patch and upsert it into
//!   `accepted-patches.json`. The working file is untouched; the record moves
//!   from *unreviewed* to *unpublished*.
//! - **reject**  — restore the working file to its approved bytes. The patch
//!   file is untouched; only the unreviewed delta is undone.
//! - **discard** — drop the record's accepted-patches entry *and* restore the
//!   working file to published, walking it all the way back.
//!
//! Not yet mirrored from the CLI: the workspace lock and the folder-index
//! refresh. Fine for single-user review; worth adding before this writes
//! alongside a running desktop app.

use std::path::Path;

use anyhow::{anyhow, Result};
use scratch_git_2::shared::layout::WorkspaceLayout;
use scratch_git_2::shared::{accepted_patches, git_local, re_anchor, review_ops};

use crate::workspace;

#[derive(Clone, Copy)]
pub enum ReviewAction {
    Accept,
    Reject,
    Discard,
}

impl ReviewAction {
    pub fn parse(raw: &str) -> Option<ReviewAction> {
        match raw {
            "accept" => Some(ReviewAction::Accept),
            "reject" => Some(ReviewAction::Reject),
            "discard" => Some(ReviewAction::Discard),
            _ => None,
        }
    }
}

pub fn apply(
    workspace_dir: &Path,
    connection_dir_name: &str,
    rel_path: &str,
    action: ReviewAction,
) -> Result<()> {
    let entry = workspace::read_connections(workspace_dir)?
        .into_iter()
        .find(|connection| connection.dir_name == connection_dir_name)
        .ok_or_else(|| anyhow!("unknown connection: {connection_dir_name}"))?;

    let layout = WorkspaceLayout::for_cli(workspace_dir);
    let paths = workspace::connection_paths(&layout, workspace_dir, &entry);
    let connection_root = layout.connection_root_path(&entry.dir_name);

    let published_files =
        git_local::read_tree_files(&paths.bare_repo, "refs/heads/main").unwrap_or_default();
    let mut accepted_file = accepted_patches::load(&connection_root)?;

    match action {
        ReviewAction::Accept => {
            let working_files = review_ops::read_worktree_files_and_scratch_state(&paths)?;
            let published_value =
                review_ops::parse_json_value_at(&published_files, rel_path, "refs/heads/main")?;
            let working_value =
                review_ops::parse_json_value_at(&working_files, rel_path, "working tree")?;
            match re_anchor::compute_entry(
                rel_path,
                published_value.as_ref(),
                working_value.as_ref(),
            ) {
                Some(patch_entry) => {
                    accepted_patches::upsert_entry(&mut accepted_file, patch_entry)
                }
                None => accepted_patches::remove_entry(&mut accepted_file, rel_path),
            }
            accepted_patches::save_atomic(&connection_root, &accepted_file)?;
        }
        ReviewAction::Reject => {
            let approved_files =
                review_ops::compute_accepted_state(&published_files, &accepted_file)?;
            let approved_bytes = approved_files.get(rel_path).cloned();
            review_ops::write_or_remove_working_file(&paths, rel_path, approved_bytes.as_deref())?;
        }
        ReviewAction::Discard => {
            accepted_patches::remove_entry(&mut accepted_file, rel_path);
            accepted_patches::save_atomic(&connection_root, &accepted_file)?;
            let published_bytes = published_files.get(rel_path).cloned();
            review_ops::write_or_remove_working_file(&paths, rel_path, published_bytes.as_deref())?;
        }
    }

    Ok(())
}
