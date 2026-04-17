use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;

// Keep local repo/object logic separate from remote transport logic so the CLI
// can evolve those concerns independently. In practice, the local half is
// mostly pure repository manipulation, while the remote half is where auth and
// protocol concerns live.
type FileMap = HashMap<String, Vec<u8>>;

mod local;
mod remote;

pub(crate) use local::{
    commit_file_map_to_ref, diff_name_status, ensure_sparse_worktree,
    materialize_treeish_to_directory, merge_base_to_string, read_tree_files,
    rev_parse_optional_to_string, rev_parse_to_string, setup_sparse_worktree, update_ref,
    worktree_reset_hard, worktree_reset_mixed, worktree_status_entries,
};
pub(crate) use remote::{clone_bare, fetch_origin, force_push_origin_dirty, push_origin_dirty};

fn open_bare_repo(bare_repo: &Path) -> anyhow::Result<gix::Repository> {
    gix::open(bare_repo.to_path_buf())
        .with_context(|| format!("failed to open git repo {}", bare_repo.display()))
}
