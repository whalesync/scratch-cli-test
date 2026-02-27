use std::collections::HashMap;

use gix::ObjectId;

use crate::error::AppError;
use crate::git::repo::GitRepo;
use crate::types::DirtyFile;

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
        let files_a = self.get_tree_files(oid_a)?;
        let files_b = self.get_tree_files(oid_b)?;

        let mut dirty = Vec::new();

        for (path, oid) in &files_b {
            match files_a.get(path) {
                None => dirty.push(DirtyFile {
                    path: path.clone(),
                    status: "added".to_string(),
                    oid: Some(oid.clone()),
                }),
                Some(hash_a) if hash_a != oid => dirty.push(DirtyFile {
                    path: path.clone(),
                    status: "modified".to_string(),
                    oid: Some(oid.clone()),
                }),
                _ => {}
            }
        }

        for path in files_a.keys() {
            if !files_b.contains_key(path) {
                dirty.push(DirtyFile {
                    path: path.clone(),
                    status: "deleted".to_string(),
                    oid: None,
                });
            }
        }

        Ok(dirty)
    }
}
