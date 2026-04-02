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
    commit_file_map_to_ref, materialize_treeish_to_directory, read_tree_files,
    rev_parse_optional_to_string, rev_parse_to_string, update_ref,
};
pub(crate) use remote::{clone_bare, fetch_origin, force_push_origin_dirty, push_origin_dirty};

fn open_bare_repo(bare_repo: &Path) -> anyhow::Result<gix::Repository> {
    gix::open(bare_repo.to_path_buf())
        .with_context(|| format!("failed to open git repo {}", bare_repo.display()))
}
