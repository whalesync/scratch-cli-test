use std::collections::HashMap;

use gix::ObjectId;

use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::types::DirtyFile;

impl GitRepo {
    /// Walk a commit's tree and return a map of path → blob OID (hex string).
    /// Skips dotfiles (paths where any component starts with '.').
    pub fn get_tree_files(&self, commit_oid: ObjectId) -> Result<HashMap<String, String>, AppError> {
        let repo = &self.repo;
        let commit = repo
            .find_commit(commit_oid)
            .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
        let tree = commit
            .tree()
            .map_err(|e| AppError::internal(format!("Failed to get tree: {}", e)))?;

        let mut files = HashMap::new();
        self.walk_tree(&tree, String::new(), &mut files)?;
        Ok(files)
    }

    fn walk_tree(
        &self,
        tree: &gix::Tree<'_>,
        prefix: String,
        files: &mut HashMap<String, String>,
    ) -> Result<(), AppError> {
        for entry_ref in tree.iter() {
            let entry = entry_ref
                .map_err(|e| AppError::internal(format!("Failed to read tree entry: {}", e)))?;
            let name = std::str::from_utf8(entry.filename())
                .map_err(|e| AppError::internal(format!("Invalid UTF-8 in filename: {}", e)))?
                .to_string();

            // Skip dotfiles
            if name.starts_with('.') {
                continue;
            }

            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", prefix, name)
            };

            let mode = entry.mode();
            let oid = entry.object_id();

            if mode.is_tree() {
                let obj = self
                    .repo
                    .find_object(oid)
                    .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?;
                let sub_tree = obj
                    .try_into_tree()
                    .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                self.walk_tree(&sub_tree, path, files)?;
            } else if mode.is_blob() {
                files.insert(path, oid.to_string());
            }
        }
        Ok(())
    }

    /// Compare two commits and return the list of dirty files.
    pub fn compare_commits(
        &self,
        oid_a: ObjectId,
        oid_b: ObjectId,
    ) -> Result<Vec<DirtyFile>, AppError> {
        let repo = &self.repo;
        let commit_a = repo
            .find_commit(oid_a)
            .map_err(|e| AppError::internal(format!("Failed to find commit a: {}", e)))?;
        let tree_a = commit_a
            .tree()
            .map_err(|e| AppError::internal(format!("Failed to get tree a: {}", e)))?;

        let commit_b = repo
            .find_commit(oid_b)
            .map_err(|e| AppError::internal(format!("Failed to find commit b: {}", e)))?;
        let tree_b = commit_b
            .tree()
            .map_err(|e| AppError::internal(format!("Failed to get tree b: {}", e)))?;

        let mut dirty = Vec::new();
        self.compare_trees_recursive(&tree_a, &tree_b, String::new(), &mut dirty)?;
        Ok(dirty)
    }

    fn compare_trees_recursive(
        &self,
        tree_a: &gix::Tree<'_>,
        tree_b: &gix::Tree<'_>,
        prefix: String,
        dirty: &mut Vec<DirtyFile>,
    ) -> Result<(), AppError> {
        if tree_a.id() == tree_b.id() {
            return Ok(());
        }

        let mut map_a = std::collections::HashMap::new();
        for entry_ref in tree_a.iter() {
            let e = entry_ref.map_err(|e| AppError::internal(format!("tree read a err: {}", e)))?;
            map_a.insert(e.filename().to_vec(), (e.mode(), e.object_id()));
        }

        let mut entries_b = Vec::new();
        for entry_ref in tree_b.iter() {
            let e = entry_ref.map_err(|e| AppError::internal(format!("tree read b err: {}", e)))?;
            entries_b.push((e.filename().to_vec(), e.mode(), e.object_id()));
        }

        // Compare entries from B against A
        for (name, mode_b, oid_b) in entries_b {
            let name_str = std::str::from_utf8(&name).unwrap_or("").to_string();
            if name_str.starts_with('.') {
                continue;
            }
            let path = if prefix.is_empty() {
                name_str.clone()
            } else {
                format!("{}/{}", prefix, name_str)
            };

            match map_a.remove(&name) {
                Some((mode_a, oid_a)) => {
                    if oid_a != oid_b {
                        if mode_a.is_tree() && mode_b.is_tree() {
                            let sub_tree_a = self.repo.find_object(oid_a)
                                .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                                .try_into_tree()
                                .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                            let sub_tree_b = self.repo.find_object(oid_b)
                                .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                                .try_into_tree()
                                .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                            self.compare_trees_recursive(&sub_tree_a, &sub_tree_b, path, dirty)?;
                        } else if mode_a.is_blob() && mode_b.is_blob() {
                            dirty.push(DirtyFile {
                                path,
                                status: "modified".to_string(),
                                oid: Some(oid_b.to_string()),
                            });
                        } else {
                            // Type fundamentally changed
                            if mode_a.is_tree() {
                                let sub_tree_a = self.repo.find_object(oid_a)
                                    .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                                    .try_into_tree()
                                    .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                                self.add_all_from_tree(&sub_tree_a, path.clone(), "deleted", dirty)?;
                            } else {
                                dirty.push(DirtyFile {
                                    path: path.clone(),
                                    status: "deleted".to_string(),
                                    oid: None,
                                });
                            }

                            if mode_b.is_tree() {
                                let sub_tree_b = self.repo.find_object(oid_b)
                                    .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                                    .try_into_tree()
                                    .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                                self.add_all_from_tree(&sub_tree_b, path, "added", dirty)?;
                            } else {
                                dirty.push(DirtyFile {
                                    path,
                                    status: "added".to_string(),
                                    oid: Some(oid_b.to_string()),
                                });
                            }
                        }
                    }
                }
                None => {
                    // Added in B
                    if mode_b.is_tree() {
                        let sub_tree_b = self.repo.find_object(oid_b)
                            .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                            .try_into_tree()
                            .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                        self.add_all_from_tree(&sub_tree_b, path, "added", dirty)?;
                    } else if mode_b.is_blob() {
                        dirty.push(DirtyFile {
                            path,
                            status: "added".to_string(),
                            oid: Some(oid_b.to_string()),
                        });
                    }
                }
            }
        }

        // Remaining entries in A were deleted in B
        for (name, (mode_a, oid_a)) in map_a {
            let name_str = std::str::from_utf8(&name).unwrap_or("").to_string();
            if name_str.starts_with('.') {
                continue;
            }
            let path = if prefix.is_empty() {
                name_str.clone()
            } else {
                format!("{}/{}", prefix, name_str)
            };

            if mode_a.is_tree() {
                let sub_tree_a = self.repo.find_object(oid_a)
                    .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                    .try_into_tree()
                    .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                self.add_all_from_tree(&sub_tree_a, path, "deleted", dirty)?;
            } else if mode_a.is_blob() {
                dirty.push(DirtyFile {
                    path,
                    status: "deleted".to_string(),
                    oid: None,
                });
            }
        }

        Ok(())
    }

    fn add_all_from_tree(
        &self,
        tree: &gix::Tree<'_>,
        prefix: String,
        status: &str,
        dirty: &mut Vec<DirtyFile>,
    ) -> Result<(), AppError> {
        for entry_ref in tree.iter() {
            let e = entry_ref.map_err(|e| AppError::internal(format!("read error: {}", e)))?;
            let name_str = std::str::from_utf8(e.filename()).unwrap_or("").to_string();
            if name_str.starts_with('.') {
                continue;
            }
            let path = if prefix.is_empty() {
                name_str.clone()
            } else {
                format!("{}/{}", prefix, name_str)
            };

            if e.mode().is_tree() {
                let sub_tree = self.repo.find_object(e.object_id())
                    .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?
                    .try_into_tree()
                    .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;
                self.add_all_from_tree(&sub_tree, path, status, dirty)?;
            } else if e.mode().is_blob() {
                dirty.push(DirtyFile {
                    path,
                    status: status.to_string(),
                    oid: if status == "deleted" {
                        None
                    } else {
                        Some(e.object_id().to_string())
                    },
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::service::git::repo::GitRepo;
    use crate::service::types::*;
    use tempfile::TempDir;

    fn setup_repo() -> (TempDir, GitRepo) {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "test").unwrap();
        (tmp, repo)
    }

    /// Helper: commit a set of file changes to main and return the commit OID.
    fn commit_files(
        repo: &GitRepo,
        changes: &[FileChange],
        message: &str,
    ) -> gix::ObjectId {
        repo.commit_changes_to_ref(MAIN_BRANCH, changes, message).unwrap().0
    }

    #[test]
    fn identical_commits_have_no_diff() {
        let (_tmp, repo) = setup_repo();
        let oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let diff = repo.compare_commits(oid, oid).unwrap();
        assert!(diff.is_empty());
    }

    #[test]
    fn detect_added_file() {
        let (_tmp, repo) = setup_repo();
        let oid_a = repo.resolve_ref(MAIN_BRANCH).unwrap();

        let oid_b = commit_files(
            &repo,
            &[FileChange {
                path: "new.txt".to_string(),
                content: Some("content".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "add file",
        );

        let diff = repo.compare_commits(oid_a, oid_b).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].path, "new.txt");
        assert_eq!(diff[0].status, "added");
    }

    #[test]
    fn detect_modified_file() {
        let (_tmp, repo) = setup_repo();

        let oid_a = commit_files(
            &repo,
            &[FileChange {
                path: "file.txt".to_string(),
                content: Some("v1".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "v1",
        );

        let oid_b = commit_files(
            &repo,
            &[FileChange {
                path: "file.txt".to_string(),
                content: Some("v2".to_string()),
                oid: None,
                change_type: ChangeType::Modify,
            }],
            "v2",
        );

        let diff = repo.compare_commits(oid_a, oid_b).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].path, "file.txt");
        assert_eq!(diff[0].status, "modified");
    }

    #[test]
    fn detect_deleted_file() {
        let (_tmp, repo) = setup_repo();

        let oid_a = commit_files(
            &repo,
            &[FileChange {
                path: "file.txt".to_string(),
                content: Some("content".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "add",
        );

        let oid_b = commit_files(
            &repo,
            &[FileChange {
                path: "file.txt".to_string(),
                content: None,
                oid: None,
                change_type: ChangeType::Delete,
            }],
            "delete",
        );

        let diff = repo.compare_commits(oid_a, oid_b).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].path, "file.txt");
        assert_eq!(diff[0].status, "deleted");
    }

    #[test]
    fn detect_nested_changes() {
        let (_tmp, repo) = setup_repo();
        let oid_a = repo.resolve_ref(MAIN_BRANCH).unwrap();

        let oid_b = commit_files(
            &repo,
            &[
                FileChange {
                    path: "dir/a.txt".to_string(),
                    content: Some("aaa".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
                FileChange {
                    path: "dir/sub/b.txt".to_string(),
                    content: Some("bbb".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
            ],
            "add nested",
        );

        let diff = repo.compare_commits(oid_a, oid_b).unwrap();
        assert_eq!(diff.len(), 2);
        let paths: Vec<&str> = diff.iter().map(|d| d.path.as_str()).collect();
        assert!(paths.contains(&"dir/a.txt"));
        assert!(paths.contains(&"dir/sub/b.txt"));
    }

    #[test]
    fn dotfiles_are_skipped() {
        let (_tmp, repo) = setup_repo();
        let oid_a = repo.resolve_ref(MAIN_BRANCH).unwrap();

        let oid_b = commit_files(
            &repo,
            &[
                FileChange {
                    path: ".hidden".to_string(),
                    content: Some("secret".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
                FileChange {
                    path: "visible.txt".to_string(),
                    content: Some("hello".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
            ],
            "add files",
        );

        let diff = repo.compare_commits(oid_a, oid_b).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].path, "visible.txt");
    }

    #[test]
    fn get_tree_files_returns_all_blobs() {
        let (_tmp, repo) = setup_repo();

        let oid = commit_files(
            &repo,
            &[
                FileChange {
                    path: "a.txt".to_string(),
                    content: Some("aaa".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
                FileChange {
                    path: "dir/b.txt".to_string(),
                    content: Some("bbb".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
            ],
            "add files",
        );

        let files = repo.get_tree_files(oid).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.contains_key("a.txt"));
        assert!(files.contains_key("dir/b.txt"));
    }

    #[test]
    fn get_tree_files_skips_dotfiles() {
        let (_tmp, repo) = setup_repo();

        let oid = commit_files(
            &repo,
            &[
                FileChange {
                    path: ".gitignore".to_string(),
                    content: Some("*.log".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
                FileChange {
                    path: "readme.txt".to_string(),
                    content: Some("hi".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
            ],
            "add files",
        );

        let files = repo.get_tree_files(oid).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files.contains_key("readme.txt"));
    }
}
