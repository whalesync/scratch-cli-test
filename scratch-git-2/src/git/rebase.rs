use crate::error::AppError;
use crate::git::merge::merge_file_contents;
use crate::git::repo::GitRepo;
use crate::types::*;

impl GitRepo {
    /// Full rebase of dirty branch onto main.
    pub fn rebase_dirty(&self, strategy: &str) -> Result<(bool, Vec<String>), AppError> {
        // 1. Ensure dirty exists (create from main if missing)
        let main_oid = self.resolve_ref(MAIN_BRANCH)?;
        let dirty_oid = match self.resolve_ref(DIRTY_BRANCH) {
            Ok(oid) => oid,
            Err(_) => {
                // Create dirty from main
                self.create_branch(DIRTY_BRANCH, main_oid)?;
                self.write_tag("merge_base", main_oid)?;
                return Ok((true, vec![]));
            }
        };

        // 2. Fast path: dirty == merge_base means user has no edits.
        //    Just advance dirty and merge_base to main.
        let merge_base_oid = self.resolve_merge_base_or_main()?;
        if dirty_oid == merge_base_oid {
            self.force_ref(DIRTY_BRANCH, main_oid)?;
            self.write_tag("merge_base", main_oid)?;
            return Ok((true, vec![]));
        }

        // 3. User has edits (dirty != merge_base). Perform 3-way merge rebase.
        //    Get user changes (compare merge_base → dirty)
        let user_changes = self.compare_commits(merge_base_oid, dirty_oid)?;
        if user_changes.is_empty() {
            // No actual file changes — fast-forward
            self.force_ref(DIRTY_BRANCH, main_oid)?;
            self.write_tag("merge_base", main_oid)?;
            return Ok((true, vec![]));
        }

        // 4. Read content for each change (batch 50)
        let mut edits: Vec<EditInfo> = Vec::new();
        let batch_size = 50;
        for chunk in user_changes.chunks(batch_size) {
            for change in chunk {
                if change.status == "deleted" {
                    edits.push(EditInfo {
                        path: change.path.clone(),
                        status: "deleted".to_string(),
                        content: None,
                        base_content: None,
                    });
                } else {
                    let content = self.get_file_content(DIRTY_BRANCH, &change.path)?;
                    let base_content = if strategy == "diff3" && change.status == "modified" {
                        self.get_file_content_by_commit(merge_base_oid, &change.path)
                            .ok()
                            .flatten()
                    } else {
                        None
                    };
                    edits.push(EditInfo {
                        path: change.path.clone(),
                        status: change.status.clone(),
                        content,
                        base_content,
                    });
                }
            }
        }

        // 5. Force dirty ref to main
        self.force_ref(DIRTY_BRANCH, main_oid)?;

        // 6. Process edits
        let conflicts: Vec<String> = Vec::new();
        let mut changes_to_commit: Vec<FileChange> = Vec::new();

        for edit in &edits {
            if edit.status == "deleted" {
                if self.get_file_content(MAIN_BRANCH, &edit.path)?.is_some() {
                    changes_to_commit.push(FileChange {
                        path: edit.path.clone(),
                        content: None,
                        oid: None,
                        change_type: ChangeType::Delete,
                    });
                }
            } else if let Some(content) = &edit.content {
                let main_content = self.get_file_content(MAIN_BRANCH, &edit.path)?;

                let final_content = if strategy == "diff3" && edit.status == "modified" {
                    if let (Some(base), Some(main_c)) = (&edit.base_content, &main_content) {
                        if base != main_c {
                            merge_file_contents(base, content, main_c)?
                        } else {
                            content.clone()
                        }
                    } else {
                        content.clone()
                    }
                } else {
                    content.clone()
                };

                if main_content.as_deref() != Some(&final_content) {
                    changes_to_commit.push(FileChange {
                        path: edit.path.clone(),
                        content: Some(final_content),
                        oid: None,
                        change_type: ChangeType::Modify,
                    });
                }
            }
        }

        // 7. Commit changes on dirty
        if !changes_to_commit.is_empty() {
            self.commit_changes_to_ref(DIRTY_BRANCH, &changes_to_commit, "Rebase dirty on main")?;
        }

        // 8. Write merge_base tag
        self.write_tag("merge_base", main_oid)?;

        Ok((true, conflicts))
    }
}

struct EditInfo {
    path: String,
    status: String,
    content: Option<String>,
    base_content: Option<String>,
}
