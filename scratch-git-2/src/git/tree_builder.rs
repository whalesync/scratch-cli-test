use std::collections::HashMap;

use gix::ObjectId;

use crate::error::AppError;
use crate::git::repo::GitRepo;
use crate::types::{ChangeType, FileChange};

impl GitRepo {
    /// Apply a set of file changes to a tree, returning the new tree OID.
    /// This is the recursive tree construction algorithm.
    pub fn apply_changes_to_tree(
        &self,
        current_tree_oid: ObjectId,
        changes: &[FileChange],
        prefix: &str,
    ) -> Result<ObjectId, AppError> {
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
                // Modify or add over existing
                let new_oid = self.write_blob_for_change(direct)?;
                new_entries.push((name, gix::objs::tree::EntryKind::Blob, new_oid));
            } else if let Some(sub_changes) = subtree_changes.remove(&name) {
                if mode.is_tree() {
                    let new_subtree_oid = self.apply_changes_to_tree(
                        oid.into(),
                        &sub_changes
                            .iter()
                            .map(|c| (*c).clone())
                            .collect::<Vec<_>>(),
                        &if prefix.is_empty() {
                            name.clone()
                        } else {
                            format!("{}/{}", prefix, name)
                        },
                    )?;
                    new_entries.push((name.clone(), gix::objs::tree::EntryKind::Tree, new_subtree_oid));
                } else {
                    // Entry is not a tree but we have subtree changes - keep as-is
                    new_entries.push((
                        name,
                        entry_kind_from_mode(mode),
                        oid.into(),
                    ));
                }
            } else {
                // No change, keep entry
                new_entries.push((
                    name,
                    entry_kind_from_mode(mode),
                    oid.into(),
                ));
            }
        }

        // Add new direct entries (not already in tree)
        for (name, change) in &direct_changes {
            if change.change_type == ChangeType::Add || change.change_type == ChangeType::Modify {
                let new_oid = self.write_blob_for_change(change)?;
                new_entries.push((name.clone(), gix::objs::tree::EntryKind::Blob, new_oid));
            }
        }

        // Add new subtrees (not already in tree)
        for (name, sub_changes) in &subtree_changes {
            let empty_tree = self.write_empty_tree()?;
            let new_subtree_oid = self.apply_changes_to_tree(
                empty_tree,
                &sub_changes
                    .iter()
                    .map(|c| (*c).clone())
                    .collect::<Vec<_>>(),
                &if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", prefix, name)
                },
            )?;
            new_entries.push((name.clone(), gix::objs::tree::EntryKind::Tree, new_subtree_oid));
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
        self.write_tree_from_entries(&new_entries)
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

fn entry_kind_from_mode(mode: gix::object::tree::EntryMode) -> gix::objs::tree::EntryKind {
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
