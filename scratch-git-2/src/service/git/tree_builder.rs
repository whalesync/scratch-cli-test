use std::collections::HashMap;

use gix::ObjectId;

use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::types::{ChangeType, CommitStats, FileChange};

impl GitRepo {
    /// Apply a set of file changes to a tree, returning the new tree OID and stats
    /// about what actually changed. This is the recursive tree construction algorithm.
    pub fn apply_changes_to_tree(
        &self,
        current_tree_oid: ObjectId,
        changes: &[FileChange],
        prefix: &str,
    ) -> Result<(ObjectId, CommitStats), AppError> {
        // Partition changes into direct (this level) vs subtree (nested)
        let mut direct_changes: HashMap<String, &FileChange> = HashMap::new();
        let mut subtree_changes: HashMap<String, Vec<&FileChange>> = HashMap::new();

        for change in changes {
            let relative_path = if prefix.is_empty() {
                change.path.clone()
            } else {
                change.path[prefix.len() + 1..].to_string()
            };

            match relative_path.find('/') {
                None => {
                    direct_changes.insert(relative_path, change);
                }
                Some(slash_idx) => {
                    let subtree_name = relative_path[..slash_idx].to_string();
                    subtree_changes
                        .entry(subtree_name)
                        .or_default()
                        .push(change);
                }
            }
        }

        // Read current tree entries
        let tree_obj = self
            .repo
            .find_object(current_tree_oid)
            .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?;
        let tree = tree_obj
            .try_into_tree()
            .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;

        let mut new_entries: Vec<(String, gix::objs::tree::EntryKind, ObjectId)> = Vec::new();
        let mut stats = CommitStats::default();

        for entry_ref in tree.iter() {
            let entry = entry_ref
                .map_err(|e| AppError::internal(format!("Failed to read tree entry: {}", e)))?;
            let name = std::str::from_utf8(entry.filename())
                .map_err(|e| AppError::internal(format!("Invalid UTF-8: {}", e)))?
                .to_string();
            let mode = entry.mode();
            let oid = entry.object_id();

            if let Some(direct) = direct_changes.remove(&name) {
                if direct.change_type == ChangeType::Delete {
                    // Skip (delete)
                    continue;
                }
                // Modify or add over existing — compare blob OIDs
                let new_oid = self.write_blob_for_change(direct)?;
                let full_path = direct.path.clone();
                let existing_oid: ObjectId = oid.into();
                if new_oid == existing_oid {
                    stats.unchanged.push(full_path);
                } else {
                    stats.updated.push(full_path);
                }
                new_entries.push((name, gix::objs::tree::EntryKind::Blob, new_oid));
            } else if let Some(sub_changes) = subtree_changes.remove(&name) {
                if mode.is_tree() {
                    let (new_subtree_oid, sub_stats) = self.apply_changes_to_tree(
                        oid.into(),
                        &sub_changes.iter().map(|c| (*c).clone()).collect::<Vec<_>>(),
                        &if prefix.is_empty() {
                            name.clone()
                        } else {
                            format!("{}/{}", prefix, name)
                        },
                    )?;
                    stats.created.extend(sub_stats.created);
                    stats.updated.extend(sub_stats.updated);
                    stats.unchanged.extend(sub_stats.unchanged);
                    new_entries.push((
                        name.clone(),
                        gix::objs::tree::EntryKind::Tree,
                        new_subtree_oid,
                    ));
                } else {
                    // Entry is not a tree but we have subtree changes - keep as-is
                    new_entries.push((name, entry_kind_from_mode(mode), oid.into()));
                }
            } else {
                // No change, keep entry
                new_entries.push((name, entry_kind_from_mode(mode), oid.into()));
            }
        }

        // Add new direct entries (not already in tree)
        for (name, change) in &direct_changes {
            if change.change_type == ChangeType::Add || change.change_type == ChangeType::Modify {
                let new_oid = self.write_blob_for_change(change)?;
                stats.created.push(change.path.clone());
                new_entries.push((name.clone(), gix::objs::tree::EntryKind::Blob, new_oid));
            }
        }

        // Add new subtrees (not already in tree)
        for (name, sub_changes) in &subtree_changes {
            let empty_tree = self.write_empty_tree()?;
            let (new_subtree_oid, sub_stats) = self.apply_changes_to_tree(
                empty_tree,
                &sub_changes.iter().map(|c| (*c).clone()).collect::<Vec<_>>(),
                &if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", prefix, name)
                },
            )?;
            stats.created.extend(sub_stats.created);
            stats.updated.extend(sub_stats.updated);
            stats.unchanged.extend(sub_stats.unchanged);
            new_entries.push((
                name.clone(),
                gix::objs::tree::EntryKind::Tree,
                new_subtree_oid,
            ));
        }

        // Sort entries in git canonical order (dirs get trailing `/` for comparison)
        new_entries.sort_by(|a, b| {
            let a_name = if a.1 == gix::objs::tree::EntryKind::Tree {
                format!("{}/", a.0)
            } else {
                a.0.clone()
            };
            let b_name = if b.1 == gix::objs::tree::EntryKind::Tree {
                format!("{}/", b.0)
            } else {
                b.0.clone()
            };
            a_name.cmp(&b_name)
        });

        // Write tree object
        let tree_oid = self.write_tree_from_entries(&new_entries)?;
        Ok((tree_oid, stats))
    }

    fn write_blob_for_change(&self, change: &FileChange) -> Result<ObjectId, AppError> {
        if let Some(oid_str) = &change.oid {
            // Reuse existing OID
            ObjectId::from_hex(oid_str.as_bytes())
                .map_err(|e| AppError::internal(format!("Invalid OID: {}", e)))
        } else {
            let content = change.content.as_deref().unwrap_or("");
            self.write_blob(content.as_bytes())
        }
    }
}

pub fn entry_kind_from_mode(mode: gix::object::tree::EntryMode) -> gix::objs::tree::EntryKind {
    if mode.is_tree() {
        gix::objs::tree::EntryKind::Tree
    } else if mode.is_link() {
        gix::objs::tree::EntryKind::Link
    } else if mode.is_executable() {
        gix::objs::tree::EntryKind::BlobExecutable
    } else {
        gix::objs::tree::EntryKind::Blob
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

    #[test]
    fn add_single_file_to_empty_tree() {
        let (_tmp, repo) = setup_repo();
        let empty_tree = repo.write_empty_tree().unwrap();

        let changes = vec![FileChange {
            path: "hello.txt".to_string(),
            content: Some("hello world".to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }];

        let (new_tree, stats) = repo
            .apply_changes_to_tree(empty_tree, &changes, "")
            .unwrap();
        assert_ne!(new_tree, empty_tree);
        assert_eq!(stats.created, vec!["hello.txt"]);
        assert!(stats.updated.is_empty());
        assert!(stats.unchanged.is_empty());
    }

    #[test]
    fn add_nested_file_creates_subtree() {
        let (_tmp, repo) = setup_repo();
        let empty_tree = repo.write_empty_tree().unwrap();

        let changes = vec![FileChange {
            path: "folder/sub/file.txt".to_string(),
            content: Some("nested content".to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }];

        let (new_tree, stats) = repo
            .apply_changes_to_tree(empty_tree, &changes, "")
            .unwrap();
        assert_ne!(new_tree, empty_tree);
        assert_eq!(stats.created, vec!["folder/sub/file.txt"]);

        // Verify the file is actually readable via the tree
        let commit_oid = repo.write_commit(new_tree, &[], "test").unwrap();
        let content = repo
            .get_file_content_by_commit(commit_oid, "folder/sub/file.txt")
            .unwrap();
        assert_eq!(content.as_deref(), Some("nested content"));
    }

    #[test]
    fn modify_existing_file() {
        let (_tmp, repo) = setup_repo();

        // Create initial tree with a file
        let empty_tree = repo.write_empty_tree().unwrap();
        let add_changes = vec![FileChange {
            path: "file.txt".to_string(),
            content: Some("original".to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }];
        let (tree_v1, _) = repo
            .apply_changes_to_tree(empty_tree, &add_changes, "")
            .unwrap();

        // Modify the file
        let mod_changes = vec![FileChange {
            path: "file.txt".to_string(),
            content: Some("modified".to_string()),
            oid: None,
            change_type: ChangeType::Modify,
        }];
        let (tree_v2, stats) = repo
            .apply_changes_to_tree(tree_v1, &mod_changes, "")
            .unwrap();

        assert_ne!(tree_v1, tree_v2);
        assert_eq!(stats.updated, vec!["file.txt"]);
        assert!(stats.created.is_empty());
    }

    #[test]
    fn modify_with_same_content_is_unchanged() {
        let (_tmp, repo) = setup_repo();

        let empty_tree = repo.write_empty_tree().unwrap();
        let changes = vec![FileChange {
            path: "file.txt".to_string(),
            content: Some("same".to_string()),
            oid: None,
            change_type: ChangeType::Add,
        }];
        let (tree_v1, _) = repo
            .apply_changes_to_tree(empty_tree, &changes, "")
            .unwrap();

        // "Modify" with identical content
        let mod_changes = vec![FileChange {
            path: "file.txt".to_string(),
            content: Some("same".to_string()),
            oid: None,
            change_type: ChangeType::Modify,
        }];
        let (tree_v2, stats) = repo
            .apply_changes_to_tree(tree_v1, &mod_changes, "")
            .unwrap();

        assert_eq!(tree_v1, tree_v2); // Tree OID unchanged
        assert_eq!(stats.unchanged, vec!["file.txt"]);
    }

    #[test]
    fn delete_file() {
        let (_tmp, repo) = setup_repo();

        // Create tree with two files
        let empty_tree = repo.write_empty_tree().unwrap();
        let add_changes = vec![
            FileChange {
                path: "keep.txt".to_string(),
                content: Some("keep".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            },
            FileChange {
                path: "remove.txt".to_string(),
                content: Some("remove".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            },
        ];
        let (tree_v1, _) = repo
            .apply_changes_to_tree(empty_tree, &add_changes, "")
            .unwrap();

        // Delete one file
        let del_changes = vec![FileChange {
            path: "remove.txt".to_string(),
            content: None,
            oid: None,
            change_type: ChangeType::Delete,
        }];
        let (tree_v2, _) = repo
            .apply_changes_to_tree(tree_v1, &del_changes, "")
            .unwrap();

        assert_ne!(tree_v1, tree_v2);

        // Verify only keep.txt remains
        let commit_oid = repo.write_commit(tree_v2, &[], "test").unwrap();
        assert!(repo
            .get_file_content_by_commit(commit_oid, "keep.txt")
            .unwrap()
            .is_some());
        assert!(repo
            .get_file_content_by_commit(commit_oid, "remove.txt")
            .unwrap()
            .is_none());
    }

    #[test]
    fn multiple_files_in_same_directory() {
        let (_tmp, repo) = setup_repo();
        let empty_tree = repo.write_empty_tree().unwrap();

        let changes = vec![
            FileChange {
                path: "dir/a.txt".to_string(),
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
        ];

        let (new_tree, stats) = repo
            .apply_changes_to_tree(empty_tree, &changes, "")
            .unwrap();
        assert_eq!(stats.created.len(), 2);

        let commit_oid = repo.write_commit(new_tree, &[], "test").unwrap();
        assert_eq!(
            repo.get_file_content_by_commit(commit_oid, "dir/a.txt")
                .unwrap()
                .as_deref(),
            Some("aaa")
        );
        assert_eq!(
            repo.get_file_content_by_commit(commit_oid, "dir/b.txt")
                .unwrap()
                .as_deref(),
            Some("bbb")
        );
    }

    #[test]
    fn add_file_via_oid_reuse() {
        let (_tmp, repo) = setup_repo();
        let empty_tree = repo.write_empty_tree().unwrap();

        // Write a blob manually and reference it by OID
        let blob_oid = repo.write_blob(b"blob content").unwrap();

        let changes = vec![FileChange {
            path: "file.txt".to_string(),
            content: None,
            oid: Some(blob_oid.to_string()),
            change_type: ChangeType::Add,
        }];

        let (new_tree, stats) = repo
            .apply_changes_to_tree(empty_tree, &changes, "")
            .unwrap();
        assert_eq!(stats.created, vec!["file.txt"]);

        let commit_oid = repo.write_commit(new_tree, &[], "test").unwrap();
        assert_eq!(
            repo.get_file_content_by_commit(commit_oid, "file.txt")
                .unwrap()
                .as_deref(),
            Some("blob content")
        );
    }
}
