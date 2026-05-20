// Keep local repo/object logic separate from remote transport logic so the CLI
// can evolve those concerns independently. In practice, the local half is
// mostly pure repository manipulation, while the remote half is where auth and
// protocol concerns live.
//
// As of slice H.1.5, the pure git read helpers (`open_bare_repo`,
// `read_tree_files`, `rev_parse_optional_to_string`, and the shared `FileMap`
// type) live in `shared::git_local` so `shared::review_ops` can drive
// accept/discard end-to-end without depending on cli code. This module
// re-exports them so existing call sites keep compiling.

mod local;
mod remote;

pub(crate) use crate::shared::git_local::{open_bare_repo, read_tree_files, FileMap};

pub(crate) use crate::shared::git_local::rev_parse_optional_to_string;
#[cfg(test)]
pub(crate) use local::rev_parse_to_string;
pub(crate) use local::{
    commit_file_map_to_ref, diff_name_status, ensure_sparse_worktree, merge_base_to_string,
    setup_sparse_worktree, update_ref, worktree_reset_hard,
};
pub(crate) use remote::{clone_bare, fetch_origin, force_push_origin_dirty};
