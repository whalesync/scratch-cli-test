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

    pub fn worktree_path(&self, connector_name: &str) -> PathBuf {
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

    pub fn reviewed_worktree_path(&self, connector_name: &str) -> PathBuf {
        self.scratch_root()
            .join("connections")
            .join("dirty")
            .join(connector_name)
    }

    pub fn workbook_materialization_path(&self) -> PathBuf {
        self.scratch_root().join("workspace")
    }

    /// Detects whether the workspace at this layout was initialized under the
    /// pre-slice-F multi-worktree model.
    ///
    /// The old layout had two worktrees per connection: a sparse `dirty`
    /// checkout at `<workspace>/<connector>/` (with `.git/info/sparse-checkout`
    /// configured) and a `master` worktree at
    /// `<workspace>/.scratch/connections/master/<connector>/`. The new layout
    /// has neither — one non-sparse `main` worktree per connection. Either
    /// artifact appearing on disk means the workspace was created before slice
    /// F shipped and needs to be re-initialized.
    ///
    /// `connection_dir_names` is the list of connection directory names from
    /// the workspace marker. The detection is cheap (≤ 2 stat calls per
    /// connection) so callers can run it on every CLI op.
    pub fn detect_old_layout(&self, connection_dir_names: &[&str]) -> OldLayoutDetection {
        let mut connections_with_master_worktree = Vec::new();
        let mut connections_with_sparse_checkout = Vec::new();

        for dir_name in connection_dir_names {
            if self.master_worktree_path(dir_name).exists() {
                connections_with_master_worktree.push((*dir_name).to_string());
            }
            let sparse = self
                .worktree_path(dir_name)
                .join(".git")
                .join("info")
                .join("sparse-checkout");
            if sparse.exists() {
                connections_with_sparse_checkout.push((*dir_name).to_string());
            }
        }

        OldLayoutDetection {
            connections_with_master_worktree,
            connections_with_sparse_checkout,
        }
    }
}

/// Result of [`WorkspaceLayout::detect_old_layout`]. Each vec lists the
/// connection directory names that exhibit the corresponding stale artifact.
/// Empty vecs everywhere means the workspace is on the new layout.
#[derive(Debug, Clone, Default)]
pub struct OldLayoutDetection {
    pub connections_with_master_worktree: Vec<String>,
    pub connections_with_sparse_checkout: Vec<String>,
}

impl OldLayoutDetection {
    pub fn is_old_layout(&self) -> bool {
        !self.connections_with_master_worktree.is_empty()
            || !self.connections_with_sparse_checkout.is_empty()
    }

    /// Union of all connections with any old-layout artifact, sorted +
    /// deduplicated. Useful for printing the structured error payload.
    pub fn affected_connections(&self) -> Vec<String> {
        let mut all: Vec<String> = self
            .connections_with_master_worktree
            .iter()
            .chain(self.connections_with_sparse_checkout.iter())
            .cloned()
            .collect();
        all.sort();
        all.dedup();
        all
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
    use super::{OldLayoutDetection, WorkspaceLayout};
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
            layout.worktree_path("Airtable - My Base"),
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
            layout.reviewed_worktree_path("Airtable - My Base"),
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
            layout.worktree_path("ca789"),
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
            layout.reviewed_worktree_path("ca789"),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/connections/dirty/ca789")
        );
        assert_eq!(
            layout.workbook_materialization_path(),
            PathBuf::from("/tmp/repos/org123/wkb456/.temp/.scratch/workspace")
        );
    }

    #[test]
    fn detect_old_layout_returns_empty_on_fresh_new_layout() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let layout = WorkspaceLayout::for_cli(tmp.path());
        // Only the user-facing worktree dir + a .git gitlink (no
        // sparse-checkout config, no master worktree). Represents the post-F
        // layout.
        let conn_dir = tmp.path().join("HubSpot");
        std::fs::create_dir_all(conn_dir.join(".git").join("info")).unwrap();

        let detection = layout.detect_old_layout(&["HubSpot"]);
        assert!(!detection.is_old_layout());
        assert!(detection.connections_with_master_worktree.is_empty());
        assert!(detection.connections_with_sparse_checkout.is_empty());
    }

    #[test]
    fn detect_old_layout_flags_connections_with_master_worktree() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let layout = WorkspaceLayout::for_cli(tmp.path());
        // Old layout: master worktree present.
        std::fs::create_dir_all(layout.master_worktree_path("HubSpot")).unwrap();

        let detection = layout.detect_old_layout(&["HubSpot", "Stripe"]);
        assert!(detection.is_old_layout());
        assert_eq!(detection.connections_with_master_worktree, vec!["HubSpot"]);
        assert!(detection.connections_with_sparse_checkout.is_empty());
    }

    #[test]
    fn detect_old_layout_flags_connections_with_sparse_checkout_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let layout = WorkspaceLayout::for_cli(tmp.path());
        // Old layout: sparse-checkout config inside the user-facing worktree.
        let info_dir = layout.worktree_path("Stripe").join(".git").join("info");
        std::fs::create_dir_all(&info_dir).unwrap();
        std::fs::write(info_dir.join("sparse-checkout"), "/*\n!.scratch/\n").unwrap();

        let detection = layout.detect_old_layout(&["HubSpot", "Stripe"]);
        assert!(detection.is_old_layout());
        assert!(detection.connections_with_master_worktree.is_empty());
        assert_eq!(detection.connections_with_sparse_checkout, vec!["Stripe"]);
    }

    #[test]
    fn detect_old_layout_affected_connections_dedupes_across_both_artifacts() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let layout = WorkspaceLayout::for_cli(tmp.path());
        // Same connection has both stale artifacts.
        std::fs::create_dir_all(layout.master_worktree_path("HubSpot")).unwrap();
        let info_dir = layout.worktree_path("HubSpot").join(".git").join("info");
        std::fs::create_dir_all(&info_dir).unwrap();
        std::fs::write(info_dir.join("sparse-checkout"), "/*\n").unwrap();

        let detection = layout.detect_old_layout(&["HubSpot"]);
        assert_eq!(detection.affected_connections(), vec!["HubSpot"]);
    }

    #[test]
    fn old_layout_detection_default_is_new_layout() {
        let detection = OldLayoutDetection::default();
        assert!(!detection.is_old_layout());
        assert!(detection.affected_connections().is_empty());
    }
}
