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

pub(crate) use crate::shared::git_local::rev_parse_optional_to_string;
pub(crate) use crate::shared::git_local::{
    open_bare_repo, read_tree_files, read_tree_files_filtered,
};
#[cfg(test)]
pub(crate) use local::commit_file_map_to_ref;
#[cfg(test)]
pub(crate) use local::rev_parse_to_string;
pub(crate) use local::{
    diff_name_status, diff_name_status_without_rename_detection, ensure_full_worktree,
    setup_sparse_worktree, update_ref, worktree_checkout_path, worktree_reset_mixed,
    worktree_status_porcelain,
};
pub(crate) use remote::{clone_bare, fetch_origin};
