use std::path::{Path, PathBuf};

use gix::date::Time;
use gix::objs::tree::EntryKind;
use gix::ObjectId;

use crate::error::AppError;
use crate::types::*;

pub struct GitRepo {
    pub repo: gix::Repository,
    _repo_path: PathBuf,
    _repo_id: String,
}

impl GitRepo {
    /// Open an existing bare git repository.
    pub fn open(repos_dir: &Path, repo_id: &str) -> Result<Self, AppError> {
        let repo_path = repos_dir.join(format!("{}.git", repo_id));
        let repo = gix::open(&repo_path)
            .map_err(|e| AppError::internal(format!("Failed to open repo {}: {}", repo_id, e)))?;
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
                    return Ok(vec![]);
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
