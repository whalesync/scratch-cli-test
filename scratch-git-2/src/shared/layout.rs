#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Shared path layout for CLI workspaces and service-side temporary materialization.
///
/// The layout is parameterized by two relative path roots:
/// - `reposdir`: where bare repos and index DBs live
/// - `loculdir`: where files are materialized for shared logic
#[derive(Debug, Clone)]
pub struct WorkspaceLayout {
    root_dir: PathBuf,
    reposdir: PathBuf,
    loculdir: PathBuf,
}

impl WorkspaceLayout {
    fn new(root_dir: &Path, reposdir: impl Into<PathBuf>, loculdir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.to_path_buf(),
            reposdir: reposdir.into(),
            loculdir: loculdir.into(),
        }
    }

    /// CLI layout rooted at a workspace directory.
    ///
    /// - `reposdir = .repos`
    /// - `loculdir = .`
    pub fn for_cli(workspace_dir: &Path) -> Self {
        Self::new(workspace_dir, ".repos", ".")
    }

    /// Service layout rooted at a single workbook directory inside `REPOS_DIR`.
    ///
    /// - `reposdir = .`
    /// - `loculdir = .temp`
    pub fn for_service(workbook_dir: &Path) -> Self {
        Self::new(workbook_dir, ".", ".temp")
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    pub fn repos_dir(&self) -> PathBuf {
        resolve_under(&self.root_dir, &self.reposdir)
    }

    pub fn locul_dir(&self) -> PathBuf {
        resolve_under(&self.root_dir, &self.loculdir)
    }

    pub fn scratch_root(&self) -> PathBuf {
        self.locul_dir().join(".scratch")
    }

    pub fn bare_repo_path(&self, repo_id: &str) -> PathBuf {
        self.repos_dir()
            .join(format!("{}.git", repo_basename(repo_id)))
    }

    pub fn index_db_path(&self, repo_id: &str) -> PathBuf {
        self.repos_dir()
            .join(format!("{}.db", repo_basename(repo_id)))
    }

    pub fn dirty_checkout_path(&self, connector_name: &str) -> PathBuf {
        self.locul_dir().join(connector_name)
    }

    pub fn connection_scratch_path(&self, connector_name: &str) -> PathBuf {
        self.scratch_root()
            .join("connections")
            .join("scratch")
            .join(connector_name)
    }

    /// Per-connection directory for state files that live alongside the
    /// connection (not under any of the worktree subroots). Today this
    /// hosts `accepted-patches.json`; future per-connection state files
    /// belong here too.
    pub fn connection_root_path(&self, connector_name: &str) -> PathBuf {
        self.scratch_root().join("connections").join(connector_name)
    }

    pub fn master_worktree_path(&self, connector_name: &str) -> PathBuf {
        self.scratch_root()
            .join("connections")
            .join("master")
            .join(connector_name)
    }

    pub fn reviewed_dirty_checkout_path(&self, connector_name: &str) -> PathBuf {
        self.scratch_root()
            .join("connections")
            .join("dirty")
            .join(connector_name)
    }

    pub fn workbook_materialization_path(&self) -> PathBuf {
        self.scratch_root().join("workspace")
    }
}

fn repo_basename(repo_id: &str) -> &str {
    repo_id.rsplit('/').next().unwrap_or(repo_id)
}

fn resolve_under(root: &Path, relative: &Path) -> PathBuf {
    if relative == Path::new(".") {
        root.to_path_buf()
    } else {
        root.join(relative)
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceLayout;
    use std::path::PathBuf;

    #[test]
    fn cli_layout_uses_workspace_roots() {
        let root = PathBuf::from("/tmp/workspace");
        let layout = WorkspaceLayout::for_cli(&root);

        assert_eq!(layout.root_dir(), root.as_path());
        assert_eq!(layout.repos_dir(), root.join(".repos"));
        assert_eq!(layout.locul_dir(), root);
        assert_eq!(layout.scratch_root(), root.join(".scratch"));
        assert_eq!(
            layout.bare_repo_path("org123/wkb456/ca789"),
            PathBuf::from("/tmp/workspace/.repos/ca789.git")
        );
        assert_eq!(
            layout.index_db_path("org123/wkb456/ca789"),
            PathBuf::from("/tmp/workspace/.repos/ca789.db")
        );
        assert_eq!(
            layout.dirty_checkout_path("Airtable - My Base"),
            PathBuf::from("/tmp/workspace/Airtable - My Base")
        );
        assert_eq!(
            layout.connection_scratch_path("Airtable - My Base"),
            PathBuf::from("/tmp/workspace/.scratch/connections/scratch/Airtable - My Base")
        );
        assert_eq!(
            layout.connection_root_path("Airtable - My Base"),
            PathBuf::from("/tmp/workspace/.scratch/connections/Airtable - My Base")
        );
        assert_eq!(
            layout.master_worktree_path("Airtable - My Base"),
            PathBuf::from("/tmp/workspace/.scratch/connections/master/Airtable - My Base")
        );
        assert_eq!(
            layout.reviewed_dirty_checkout_path("Airtable - My Base"),
            PathBuf::from("/tmp/workspace/.scratch/connections/dirty/Airtable - My Base")
        );
        assert_eq!(
            layout.workbook_materialization_path(),
            PathBuf::from("/tmp/workspace/.scratch/workspace")
        );
    }

    #[test]
    fn service_layout_uses_temp_materialization_root() {
        let root = PathBuf::from("/tmp/repos/org123/wkb456");
        let layout = WorkspaceLayout::for_service(&root);

        assert_eq!(layout.root_dir(), root.as_path());
        assert_eq!(layout.repos_dir(), root);
        assert_eq!(
            layout.locul_dir(),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp")
        );
        assert_eq!(
            layout.scratch_root(),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch")
        );
        assert_eq!(
            layout.bare_repo_path("org123/wkb456/ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/ca789.git")
        );
        assert_eq!(
            layout.index_db_path("org123/wkb456/ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/ca789.db")
        );
        assert_eq!(
            layout.dirty_checkout_path("ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/ca789")
        );
        assert_eq!(
            layout.connection_scratch_path("ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/connections/scratch/ca789")
        );
        assert_eq!(
            layout.connection_root_path("ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/connections/ca789")
        );
        assert_eq!(
            layout.master_worktree_path("ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/connections/master/ca789")
        );
        assert_eq!(
            layout.reviewed_dirty_checkout_path("ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/connections/dirty/ca789")
        );
        assert_eq!(
            layout.workbook_materialization_path(),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/workspace")
        );
    }
}
