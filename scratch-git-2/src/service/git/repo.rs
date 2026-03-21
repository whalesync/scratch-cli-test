use std::path::{Path, PathBuf};

use gix::date::Time;
use gix::objs::tree::EntryKind;
use gix::ObjectId;

use crate::service::error::AppError;
use crate::service::types::*;

pub struct GitRepo {
    pub repo: gix::Repository,
    _repo_path: PathBuf,
    _repo_id: String,
}

impl GitRepo {
    /// Open an existing bare git repository.
    pub fn open(repos_dir: &Path, repo_id: &str) -> Result<Self, AppError> {
        let repo_path = repos_dir.join(format!("{}.git", repo_id));
        let repo = gix::open(&repo_path).map_err(|_| {
            AppError::not_found(format!(
                "Repository not found: {}",
                repo_id
            ))
        })?;
        Ok(Self {
            repo,
            _repo_path: repo_path,
            _repo_id: repo_id.to_string(),
        })
    }

    /// Initialize a new bare git repository with main + dirty branches.
    pub fn init(repos_dir: &Path, repo_id: &str) -> Result<Self, AppError> {
        let repo_path = repos_dir.join(format!("{}.git", repo_id));
        std::fs::create_dir_all(&repo_path)
            .map_err(|e| AppError::internal(format!("Failed to create repo dir: {}", e)))?;

        // Check if HEAD exists (already initialized)
        let head_path = repo_path.join("HEAD");
        if !head_path.exists() {
            let repo = gix::init_bare(&repo_path)
                .map_err(|e| AppError::internal(format!("Failed to init bare repo: {}", e)))?;

            let git_repo = Self {
                repo,
                _repo_path: repo_path.clone(),
                _repo_id: repo_id.to_string(),
            };

            // Create initial commit if main doesn't exist
            if git_repo.resolve_ref(MAIN_BRANCH).is_err() {
                let empty_tree = git_repo.write_empty_tree()?;
                let commit_oid = git_repo.write_commit(empty_tree, &[], "Initial commit")?;

                // Point main and dirty to this commit
                git_repo.force_ref(MAIN_BRANCH, commit_oid)?;
                git_repo.create_branch(DIRTY_BRANCH, commit_oid)?;

                // Set merge_base tag
                git_repo.write_tag("merge_base", commit_oid)?;
            }

            Ok(git_repo)
        } else {
            // Already exists, open it and ensure initial commit exists
            let git_repo = Self::open(repos_dir, repo_id)?;

            if git_repo.resolve_ref(MAIN_BRANCH).is_err() {
                let empty_tree = git_repo.write_empty_tree()?;
                let commit_oid = git_repo.write_commit(empty_tree, &[], "Initial commit")?;

                git_repo.force_ref(MAIN_BRANCH, commit_oid)?;
                git_repo.create_branch(DIRTY_BRANCH, commit_oid)?;
                git_repo.write_tag("merge_base", commit_oid)?;
            }

            Ok(git_repo)
        }
    }

    // ── Ref operations ──

    pub fn resolve_ref(&self, ref_name: &str) -> Result<ObjectId, AppError> {
        // Try as-is first (for tags like "merge_base")
        let full_ref = if ref_name.starts_with("refs/") {
            ref_name.to_string()
        } else if ref_name.contains('_') && !["main", "dirty"].contains(&ref_name) {
            // Likely a tag name
            format!("refs/tags/{}", ref_name)
        } else {
            format!("refs/heads/{}", ref_name)
        };

        let reference = self
            .repo
            .find_reference(&full_ref)
            .map_err(|_| AppError::internal(format!("Failed to resolve ref: {}", ref_name)))?;

        let oid = reference
            .into_fully_peeled_id()
            .map_err(|e| AppError::internal(format!("Failed to peel ref: {}", e)))?;

        Ok(oid.detach())
    }

    pub fn force_ref(&self, branch: &str, oid: ObjectId) -> Result<(), AppError> {
        let full_ref = format!("refs/heads/{}", branch);
        self.repo
            .reference(
                full_ref.as_str(),
                oid,
                gix::refs::transaction::PreviousValue::Any,
                "force ref update",
            )
            .map_err(|e| AppError::internal(format!("Failed to update ref: {}", e)))?;
        Ok(())
    }

    pub fn create_branch(&self, branch: &str, oid: ObjectId) -> Result<(), AppError> {
        self.force_ref(branch, oid)
    }

    pub fn write_tag(&self, tag_name: &str, oid: ObjectId) -> Result<(), AppError> {
        let full_ref = format!("refs/tags/{}", tag_name);
        self.repo
            .reference(
                full_ref.as_str(),
                oid,
                gix::refs::transaction::PreviousValue::Any,
                "write tag",
            )
            .map_err(|e| AppError::internal(format!("Failed to write tag: {}", e)))?;
        Ok(())
    }

    /// Resolves the merge_base tag, falling back to main for repos that predate the tag.
    pub fn resolve_merge_base_or_main(&self) -> Result<ObjectId, AppError> {
        match self.resolve_ref("merge_base") {
            Ok(oid) => Ok(oid),
            Err(_) => self.resolve_ref(MAIN_BRANCH),
        }
    }

    pub fn delete_tag(&self, tag_name: &str) -> Result<(), AppError> {
        let full_ref = format!("refs/tags/{}", tag_name);
        match self.repo.find_reference(&full_ref) {
            Ok(r) => {
                r.delete()
                    .map_err(|e| AppError::internal(format!("Failed to delete tag: {}", e)))?;
            }
            Err(_) => {
                // Tag doesn't exist, ignore
            }
        }
        Ok(())
    }

    // ── Object operations ──

    pub fn write_blob(&self, content: &[u8]) -> Result<ObjectId, AppError> {
        let oid = self
            .repo
            .write_blob(content)
            .map_err(|e| AppError::internal(format!("Failed to write blob: {}", e)))?;
        Ok(oid.into())
    }

    pub fn read_blob(&self, oid: ObjectId) -> Result<Vec<u8>, AppError> {
        let obj = self
            .repo
            .find_object(oid)
            .map_err(|e| AppError::internal(format!("Failed to find blob: {}", e)))?;
        Ok(obj.data.to_vec())
    }

    pub fn read_blob_to_string(&self, oid: ObjectId) -> Result<String, AppError> {
        let data = self.read_blob(oid)?;
        String::from_utf8(data)
            .map_err(|e| AppError::internal(format!("Blob not valid UTF-8: {}", e)))
    }

    pub fn write_empty_tree(&self) -> Result<ObjectId, AppError> {
        let tree = gix::objs::Tree::empty();
        let oid = self
            .repo
            .write_object(&tree)
            .map_err(|e| AppError::internal(format!("Failed to write empty tree: {}", e)))?;
        Ok(oid.into())
    }

    pub fn write_tree_from_entries(
        &self,
        entries: &[(String, EntryKind, ObjectId)],
    ) -> Result<ObjectId, AppError> {
        let mut tree = gix::objs::Tree::empty();
        for (name, kind, oid) in entries {
            tree.entries.push(gix::objs::tree::Entry {
                mode: (*kind).into(),
                filename: name.as_str().into(),
                oid: *oid,
            });
        }
        let oid = self
            .repo
            .write_object(&tree)
            .map_err(|e| AppError::internal(format!("Failed to write tree: {}", e)))?;
        Ok(oid.into())
    }

    pub fn write_commit(
        &self,
        tree_oid: ObjectId,
        parents: &[ObjectId],
        message: &str,
    ) -> Result<ObjectId, AppError> {
        let time = Time::now_local_or_utc();
        let author = gix::actor::SignatureRef {
            name: DEFAULT_AUTHOR_NAME.into(),
            email: DEFAULT_AUTHOR_EMAIL.into(),
            time,
        };

        let commit = gix::objs::Commit {
            tree: tree_oid,
            parents: parents.iter().copied().collect(),
            author: author.to_owned(),
            committer: author.to_owned(),
            encoding: None,
            message: message.into(),
            extra_headers: vec![],
        };

        let oid = self
            .repo
            .write_object(&commit)
            .map_err(|e| AppError::internal(format!("Failed to write commit: {}", e)))?;
        Ok(oid.into())
    }

    /// Commit changes to a ref (read current tree, apply changes, write commit, update ref).
    /// Returns the new commit OID and stats about what files were created/updated/unchanged.
    pub fn commit_changes_to_ref(
        &self,
        ref_name: &str,
        changes: &[FileChange],
        message: &str,
    ) -> Result<(ObjectId, CommitStats), AppError> {
        let parent_oid = self.resolve_ref(ref_name)?;
        let parent_commit = self
            .repo
            .find_commit(parent_oid)
            .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
        let current_tree_oid: ObjectId = parent_commit
            .tree_id()
            .map_err(|e| AppError::internal(format!("Failed to get tree from commit: {}", e)))?
            .into();

        let (new_tree_oid, stats) = self.apply_changes_to_tree(current_tree_oid, changes, "")?;

        // Skip creating a commit if the tree is identical (nothing actually changed)
        if new_tree_oid == current_tree_oid {
            return Ok((parent_oid, stats));
        }

        let new_commit_oid = self.write_commit(new_tree_oid, &[parent_oid], message)?;
        self.force_ref(ref_name, new_commit_oid)?;

        Ok((new_commit_oid, stats))
    }

    // ── File operations ──

    /// Get file content from a branch.
    pub fn get_file_content(
        &self,
        branch: &str,
        file_path: &str,
    ) -> Result<Option<String>, AppError> {
        let file_path = file_path.strip_prefix('/').unwrap_or(file_path);
        let commit_oid = self.resolve_ref(branch)?;
        self.get_file_content_by_commit(commit_oid, file_path)
    }

    pub fn get_file_content_by_commit(
        &self,
        commit_oid: ObjectId,
        file_path: &str,
    ) -> Result<Option<String>, AppError> {
        let file_path = file_path.strip_prefix('/').unwrap_or(file_path);
        let commit = self
            .repo
            .find_commit(commit_oid)
            .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
        let tree = commit
            .tree()
            .map_err(|e| AppError::internal(format!("Failed to get tree: {}", e)))?;

        // Navigate the tree path
        let parts: Vec<&str> = file_path.split('/').collect();
        let mut current_tree_oid: ObjectId = tree.id().into();

        for (i, part) in parts.iter().enumerate() {
            let tree_obj = self
                .repo
                .find_object(current_tree_oid)
                .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?;
            let tree = tree_obj
                .try_into_tree()
                .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;

            let part_bytes = part.as_bytes();
            let mut found = false;

            for entry_ref in tree.iter() {
                let entry = entry_ref.ok();
                if let Some(entry) = entry {
                    if entry.filename() == part_bytes {
                        let is_blob = entry.mode().is_blob();
                        let is_tree = entry.mode().is_tree();
                        let oid = entry.object_id().into();

                        if i == parts.len() - 1 && is_blob {
                            let blob = self.read_blob(oid)?;
                            return Ok(Some(String::from_utf8(blob).map_err(|e| {
                                AppError::internal(format!("Blob not UTF-8: {}", e))
                            })?));
                        } else if i < parts.len() - 1 && is_tree {
                            current_tree_oid = oid;
                            found = true;
                            break;
                        }
                    }
                }
            }

            if !found && i < parts.len() - 1 {
                return Ok(None);
            }
        }

        Ok(None)
    }

    // ── Merge base ──

    #[allow(dead_code)]
    pub fn find_merge_base(
        &self,
        oid_a: ObjectId,
        oid_b: ObjectId,
    ) -> Result<Option<ObjectId>, AppError> {
        // Walk ancestors of both commits to find common ancestor
        let mut ancestors_a = std::collections::HashSet::new();
        let mut queue_a = std::collections::VecDeque::new();
        queue_a.push_back(oid_a);

        while let Some(oid) = queue_a.pop_front() {
            if !ancestors_a.insert(oid) {
                continue;
            }
            if let Ok(commit) = self.repo.find_commit(oid) {
                for parent in commit.parent_ids() {
                    queue_a.push_back(parent.detach());
                }
            }
        }

        // BFS from oid_b, first hit in ancestors_a is the merge base
        let mut queue_b = std::collections::VecDeque::new();
        let mut visited_b = std::collections::HashSet::new();
        queue_b.push_back(oid_b);

        while let Some(oid) = queue_b.pop_front() {
            if !visited_b.insert(oid) {
                continue;
            }
            if ancestors_a.contains(&oid) {
                return Ok(Some(oid));
            }
            if let Ok(commit) = self.repo.find_commit(oid) {
                for parent in commit.parent_ids() {
                    queue_b.push_back(parent.detach());
                }
            }
        }

        Ok(None)
    }

    // ── Branch/Tag listing ──

    pub fn list_branches(&self) -> Result<Vec<(String, ObjectId)>, AppError> {
        let mut branches = Vec::new();
        let refs = self
            .repo
            .references()
            .map_err(|e| AppError::internal(format!("Failed to list refs: {}", e)))?;
        let branch_refs = refs
            .prefixed("refs/heads/")
            .map_err(|e| AppError::internal(format!("Failed to filter branches: {}", e)))?;
        for r in branch_refs {
            let r = r.map_err(|e| AppError::internal(format!("Failed to read ref: {}", e)))?;
            let name = r
                .name()
                .as_bstr()
                .to_string()
                .strip_prefix("refs/heads/")
                .unwrap_or("")
                .to_string();
            let oid = r
                .into_fully_peeled_id()
                .map_err(|e| AppError::internal(format!("Failed to peel ref: {}", e)))?;
            branches.push((name, oid.detach()));
        }
        Ok(branches)
    }

    pub fn list_tags(&self) -> Result<Vec<(String, ObjectId)>, AppError> {
        let mut tags = Vec::new();
        let refs = self
            .repo
            .references()
            .map_err(|e| AppError::internal(format!("Failed to list refs: {}", e)))?;
        let tag_refs = refs
            .prefixed("refs/tags/")
            .map_err(|e| AppError::internal(format!("Failed to filter tags: {}", e)))?;
        for r in tag_refs {
            let r = r.map_err(|e| AppError::internal(format!("Failed to read ref: {}", e)))?;
            let name = r
                .name()
                .as_bstr()
                .to_string()
                .strip_prefix("refs/tags/")
                .unwrap_or("")
                .to_string();
            let oid = r
                .into_fully_peeled_id()
                .map_err(|e| AppError::internal(format!("Failed to peel ref: {}", e)))?;
            tags.push((name, oid.detach()));
        }
        Ok(tags)
    }

    /// Get commit tree OID directly without loading the full tree.
    pub fn get_commit_tree_oid(&self, commit_oid: ObjectId) -> Result<ObjectId, AppError> {
        let commit = self
            .repo
            .find_commit(commit_oid)
            .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
        let tree_id = commit
            .tree_id()
            .map_err(|e| AppError::internal(format!("Failed to get tree: {}", e)))?;
        Ok(tree_id.into())
    }

    /// Read a tree entry at a given folder path and return tree entries.
    pub fn read_tree_at_path(
        &self,
        commit_oid: ObjectId,
        folder_path: &str,
    ) -> Result<Vec<(String, ObjectId, bool)>, AppError> {
        let commit = self
            .repo
            .find_commit(commit_oid)
            .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
        let tree = commit
            .tree()
            .map_err(|e| AppError::internal(format!("Failed to get tree: {}", e)))?;

        let target_tree_oid: ObjectId = if folder_path.is_empty() {
            tree.id().into()
        } else {
            let parts: Vec<&str> = folder_path.split('/').collect();
            let mut current_oid: ObjectId = tree.id().into();
            for part in parts {
                let obj = self
                    .repo
                    .find_object(current_oid)
                    .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?;
                let t = obj
                    .try_into_tree()
                    .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;

                let part_bytes = part.as_bytes();
                let mut found = false;

                for entry_ref in t.iter() {
                    if let Ok(entry) = entry_ref {
                        if entry.filename() == part_bytes && entry.mode().is_tree() {
                            current_oid = entry.object_id().into();
                            found = true;
                            break;
                        }
                    }
                }

                if !found {
                    return Err(AppError::not_found(format!(
                        "Folder not found in tree: {}",
                        folder_path
                    )));
                }
            }
            current_oid
        };

        let obj = self
            .repo
            .find_object(target_tree_oid)
            .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?;
        let target_tree = obj
            .try_into_tree()
            .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;

        let mut entries = Vec::new();
        for entry_ref in target_tree.iter() {
            let entry = entry_ref
                .map_err(|e| AppError::internal(format!("Failed to read entry: {}", e)))?;
            let name = std::str::from_utf8(entry.filename())
                .map_err(|e| AppError::internal(format!("Invalid UTF-8: {}", e)))?
                .to_string();
            let is_tree = entry.mode().is_tree();
            entries.push((name, entry.object_id().into(), is_tree));
        }
        Ok(entries)
    }

    /// Strip the single top-level directory prefix from every branch/tag in the repo.
    ///
    /// Current layout: `{prefix}/{schema}/{table}/file.json`
    /// New layout:     `{schema}/{table}/file.json`
    ///
    /// Determines the case by comparing main, dirty, and merge_base OIDs:
    ///   A: all three equal → one new orphan commit, update all three refs
    ///   B: main == merge_base, dirty differs → two new orphan commits
    ///   C: all three differ → three new orphan commits
    ///
    /// Returns an error if the root tree does not contain exactly one directory entry,
    /// or if the repo is already stripped (root tree has no subdirectory at position 0).
    pub fn strip_top_level_prefix(&self) -> Result<StripPrefixResult, AppError> {
        let main_oid = self.resolve_ref(MAIN_BRANCH)?;
        let dirty_oid = self.resolve_ref(DIRTY_BRANCH)?;
        let merge_base_oid = self.resolve_merge_base_or_main()?;

        // Helper: given a commit OID, extract the single top-level directory's child tree OID.
        // Returns (prefix_name, child_tree_oid).
        let extract_child_tree = |commit_oid: ObjectId| -> Result<(String, ObjectId), AppError> {
            let commit = self
                .repo
                .find_commit(commit_oid)
                .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
            let root_tree_oid: ObjectId = commit
                .tree_id()
                .map_err(|e| AppError::internal(format!("Failed to get tree: {}", e)))?
                .into();

            let tree_obj = self
                .repo
                .find_object(root_tree_oid)
                .map_err(|e| AppError::internal(format!("Failed to find tree: {}", e)))?;
            let tree = tree_obj
                .try_into_tree()
                .map_err(|e| AppError::internal(format!("Not a tree: {}", e)))?;

            // Collect top-level entries
            let entries: Vec<(String, ObjectId, bool)> = tree
                .iter()
                .map(|e| {
                    let entry = e.map_err(|err| {
                        AppError::internal(format!("Failed to read tree entry: {}", err))
                    })?;
                    let name = std::str::from_utf8(entry.filename())
                        .map_err(|err| AppError::internal(format!("Invalid UTF-8: {}", err)))?
                        .to_string();
                    let is_tree = entry.mode().is_tree();
                    Ok((name, entry.object_id().into(), is_tree))
                })
                .collect::<Result<_, AppError>>()?;

            if entries.is_empty() {
                return Err(AppError::bad_request(
                    "Repo root tree is empty — nothing to strip",
                ));
            }

            // Filter to directory entries only (ignore dotfiles like .schema.json etc.)
            let dir_entries: Vec<_> = entries.iter().filter(|(_, _, is_tree)| *is_tree).collect();

            if dir_entries.len() != 1 {
                let names: Vec<&str> = entries.iter().map(|(n, _, _)| n.as_str()).collect();
                return Err(AppError::bad_request(format!(
                    "Expected exactly one top-level directory but found {}: {:?}",
                    dir_entries.len(),
                    names
                )));
            }

            let (prefix_name, child_tree_oid, _) = &dir_entries[0];
            Ok((prefix_name.clone(), *child_tree_oid))
        };

        // Helper: write an orphan commit (no parents) with a given tree.
        let make_orphan = |tree_oid: ObjectId, message: &str| -> Result<ObjectId, AppError> {
            self.write_commit(tree_oid, &[], message)
        };

        if main_oid == dirty_oid && main_oid == merge_base_oid {
            // Case A: single commit covers all three refs
            let (prefix, child_tree) = extract_child_tree(main_oid)?;
            let new_commit = make_orphan(child_tree, "Strip connection prefix")?;
            self.force_ref(MAIN_BRANCH, new_commit)?;
            self.force_ref(DIRTY_BRANCH, new_commit)?;
            self.write_tag("merge_base", new_commit)?;
            Ok(StripPrefixResult {
                case: "A".to_string(),
                prefix_stripped: prefix,
                new_main: new_commit.to_string(),
                new_dirty: new_commit.to_string(),
                new_merge_base: new_commit.to_string(),
            })
        } else if main_oid == merge_base_oid {
            // Case B: main == merge_base, dirty is ahead
            let (prefix, main_child) = extract_child_tree(main_oid)?;
            let (_, dirty_child) = extract_child_tree(dirty_oid)?;
            let new_main = make_orphan(main_child, "Strip connection prefix")?;
            let new_dirty = self.write_commit(dirty_child, &[new_main], "Strip connection prefix (dirty)")?;
            self.force_ref(MAIN_BRANCH, new_main)?;
            self.force_ref(DIRTY_BRANCH, new_dirty)?;
            self.write_tag("merge_base", new_main)?;
            Ok(StripPrefixResult {
                case: "B".to_string(),
                prefix_stripped: prefix,
                new_main: new_main.to_string(),
                new_dirty: new_dirty.to_string(),
                new_merge_base: new_main.to_string(),
            })
        } else {
            // Case C: all three differ
            let (prefix, main_child) = extract_child_tree(main_oid)?;
            let (_, dirty_child) = extract_child_tree(dirty_oid)?;
            let (_, merge_base_child) = extract_child_tree(merge_base_oid)?;
            let new_merge_base =
                make_orphan(merge_base_child, "Strip connection prefix (merge_base)")?;
            let new_main = self.write_commit(main_child, &[new_merge_base], "Strip connection prefix")?;
            let new_dirty = self.write_commit(dirty_child, &[new_merge_base], "Strip connection prefix (dirty)")?;
            self.force_ref(MAIN_BRANCH, new_main)?;
            self.force_ref(DIRTY_BRANCH, new_dirty)?;
            self.write_tag("merge_base", new_merge_base)?;
            Ok(StripPrefixResult {
                case: "C".to_string(),
                prefix_stripped: prefix,
                new_main: new_main.to_string(),
                new_dirty: new_dirty.to_string(),
                new_merge_base: new_merge_base.to_string(),
            })
        }
    }

    /// Read commit info (for graph/checkpoint listing).
    pub fn read_commit_info(&self, oid: ObjectId) -> Result<CommitInfo, AppError> {
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|e| AppError::internal(format!("Failed to find commit: {}", e)))?;
        let message = commit
            .message_raw()
            .map_err(|e| AppError::internal(format!("Failed to read message: {}", e)))?
            .to_string();
        let author_ref = commit
            .author()
            .map_err(|e| AppError::internal(format!("Failed to read author: {}", e)))?;
        let timestamp = author_ref.time.seconds;
        let author_name = author_ref.name.to_string();
        let author_email = author_ref.email.to_string();
        let parents: Vec<ObjectId> = commit.parent_ids().map(|id| id.detach()).collect();

        Ok(CommitInfo {
            _oid: oid,
            message,
            parents,
            timestamp,
            author_name,
            author_email,
        })
    }
}

pub struct CommitInfo {
    pub _oid: ObjectId,
    pub message: String,
    pub parents: Vec<ObjectId>,
    pub timestamp: gix::date::SecondsSinceUnixEpoch,
    pub author_name: String,
    pub author_email: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_repo() -> (TempDir, GitRepo) {
        let tmp = TempDir::new().unwrap();
        let repo = GitRepo::init(tmp.path(), "test").unwrap();
        (tmp, repo)
    }

    #[test]
    fn open_nonexistent_repo_returns_not_found() {
        let tmp = TempDir::new().unwrap();
        let result = GitRepo::open(tmp.path(), "does-not-exist");
        match result {
            Err(err) => assert_eq!(err.status_code(), axum::http::StatusCode::NOT_FOUND),
            Ok(_) => panic!("Expected error for nonexistent repo"),
        }
    }

    #[test]
    fn read_blob_to_string_returns_committed_content() {
        let (_tmp, repo) = setup_repo();

        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "hello.txt".to_string(),
                content: Some("hello world".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "add file",
        )
        .unwrap();

        let commit_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let entries = repo.read_tree_at_path(commit_oid, "").unwrap();
        let (_, blob_oid, _) = entries.iter().find(|(name, _, _)| name == "hello.txt").unwrap();

        let content = repo.read_blob_to_string(*blob_oid).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn read_blob_to_string_returns_error_for_nonexistent_oid() {
        let (_tmp, repo) = setup_repo();

        // Fabricate an OID that doesn't exist in the object store
        let bad_oid = gix::ObjectId::from_hex(b"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
        let result = repo.read_blob_to_string(bad_oid);
        assert!(result.is_err());
    }

    #[test]
    fn read_tree_at_path_returns_error_for_nonexistent_folder() {
        let (_tmp, repo) = setup_repo();

        let commit_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let result = repo.read_tree_at_path(commit_oid, "nonexistent/folder");
        assert!(result.is_err());
    }

    #[test]
    fn read_tree_at_path_lists_files_in_subfolder() {
        let (_tmp, repo) = setup_repo();

        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[
                FileChange {
                    path: "docs/a.txt".to_string(),
                    content: Some("aaa".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
                FileChange {
                    path: "docs/b.txt".to_string(),
                    content: Some("bbb".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
            ],
            "add docs",
        )
        .unwrap();

        let commit_oid = repo.resolve_ref(MAIN_BRANCH).unwrap();
        let entries = repo.read_tree_at_path(commit_oid, "docs").unwrap();
        let names: Vec<&str> = entries.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));
        assert_eq!(names.len(), 2);
    }
}
