use crate::service::error::AppError;
use crate::service::git::merge::merge_file_contents;
use crate::service::git::repo::GitRepo;
use crate::service::types::*;
use std::collections::HashSet;

impl GitRepo {
    /// Full rebase of dirty branch onto main, re-applying every user edit.
    pub fn rebase_dirty(&self, strategy: &str) -> Result<(bool, Vec<String>), AppError> {
        self.rebase_dirty_excluding(strategy, &[])
    }

    /// Rebase dirty onto main, re-applying the user's edits EXCEPT for paths in
    /// `exclude_paths`, which are left converged to `main` (their edit is dropped
    /// from `dirty`). The publish reconcile (DEV-10048) passes the set of paths it
    /// published / treated as no-ops / (for a desktop publish) failed, so those
    /// drop off `dirty` while every edit it didn't touch is preserved.
    /// `exclude_paths` empty ⇒ identical to the legacy "re-apply everything" rebase.
    pub fn rebase_dirty_excluding(
        &self,
        strategy: &str,
        exclude_paths: &[String],
    ) -> Result<(bool, Vec<String>), AppError> {
        let exclude_set: HashSet<&str> = exclude_paths.iter().map(String::as_str).collect();

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
            // Converge-to-main: skip re-applying this edit so it stays at the
            // (already force-reset) `main` content. Used by the publish reconcile
            // to drop published / no-op / desktop-failed edits from `dirty`.
            if exclude_set.contains(edit.path.as_str()) {
                continue;
            }
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
            self.commit_changes_to_ref(DIRTY_BRANCH, &changes_to_commit, "Rebase dirty on main")?
                .0;
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
    fn rebase_no_user_edits_fast_forwards() {
        let (_tmp, repo) = setup_repo();

        // Add a file to main (simulating a pull)
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "from-main.txt".to_string(),
                content: Some("main content".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "main commit",
        )
        .unwrap();

        // Rebase — dirty has no edits, so it should fast-forward
        let (success, conflicts) = repo.rebase_dirty("ours").unwrap();
        assert!(success);
        assert!(conflicts.is_empty());

        // dirty should now see the file from main
        let content = repo
            .get_file_content(DIRTY_BRANCH, "from-main.txt")
            .unwrap();
        assert_eq!(content.as_deref(), Some("main content"));
    }

    #[test]
    fn rebase_preserves_user_edits() {
        let (_tmp, repo) = setup_repo();

        // User edits a file on dirty
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[FileChange {
                path: "user-file.txt".to_string(),
                content: Some("user content".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "user edit",
        )
        .unwrap();

        // Meanwhile, main gets a different file
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "main-file.txt".to_string(),
                content: Some("main content".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "main commit",
        )
        .unwrap();

        let (success, conflicts) = repo.rebase_dirty("ours").unwrap();
        assert!(success);
        assert!(conflicts.is_empty());

        // dirty should have both files
        assert_eq!(
            repo.get_file_content(DIRTY_BRANCH, "user-file.txt")
                .unwrap()
                .as_deref(),
            Some("user content")
        );
        assert_eq!(
            repo.get_file_content(DIRTY_BRANCH, "main-file.txt")
                .unwrap()
                .as_deref(),
            Some("main content")
        );
    }

    #[test]
    fn rebase_user_delete_is_preserved() {
        let (_tmp, repo) = setup_repo();

        // Add a file on both branches via main
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "to-delete.txt".to_string(),
                content: Some("content".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "add file",
        )
        .unwrap();

        // Sync dirty to main
        let (success, _) = repo.rebase_dirty("ours").unwrap();
        assert!(success);

        // User deletes the file on dirty
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[FileChange {
                path: "to-delete.txt".to_string(),
                content: None,
                oid: None,
                change_type: ChangeType::Delete,
            }],
            "user delete",
        )
        .unwrap();

        // Rebase again — the deletion should be preserved
        let (success, _) = repo.rebase_dirty("ours").unwrap();
        assert!(success);

        assert!(repo
            .get_file_content(DIRTY_BRANCH, "to-delete.txt")
            .unwrap()
            .is_none());
    }

    #[test]
    fn rebase_diff3_merges_non_conflicting_edits() {
        let (_tmp, repo) = setup_repo();

        // Start with a multi-line file
        let initial_content = "line1\nline2\nline3\nline4\nline5\n";
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "shared.txt".to_string(),
                content: Some(initial_content.to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "initial",
        )
        .unwrap();

        // Sync dirty
        repo.rebase_dirty("ours").unwrap();

        // User edits line 1 on dirty
        let user_content = "USER\nline2\nline3\nline4\nline5\n";
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[FileChange {
                path: "shared.txt".to_string(),
                content: Some(user_content.to_string()),
                oid: None,
                change_type: ChangeType::Modify,
            }],
            "user edit",
        )
        .unwrap();

        // Main edits line 5
        let main_content = "line1\nline2\nline3\nline4\nMAIN\n";
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "shared.txt".to_string(),
                content: Some(main_content.to_string()),
                oid: None,
                change_type: ChangeType::Modify,
            }],
            "main edit",
        )
        .unwrap();

        // Rebase with diff3 strategy
        let (success, _) = repo.rebase_dirty("diff3").unwrap();
        assert!(success);

        let result = repo
            .get_file_content(DIRTY_BRANCH, "shared.txt")
            .unwrap()
            .unwrap();
        // Both edits should be merged
        assert!(result.contains("USER"), "user edit should be preserved");
        assert!(result.contains("MAIN"), "main edit should be preserved");
    }

    #[test]
    fn rebase_creates_dirty_if_missing() {
        let (_tmp, _repo) = setup_repo();

        // Create a repo with only a main branch (no dirty)
        let tmp2 = TempDir::new().unwrap();
        let repo_path = tmp2.path().join("test2.git");
        std::fs::create_dir_all(&repo_path).unwrap();
        let gix_repo = gix::init_bare(&repo_path).unwrap();

        // Create just a main branch
        let tree = gix::objs::Tree::empty();
        let tree_oid: gix::ObjectId = gix_repo.write_object(&tree).unwrap().into();
        let time = gix::date::Time::now_local_or_utc();
        let author = gix::actor::SignatureRef {
            name: "Test".into(),
            email: "test@test.com".into(),
            time,
        };
        let commit = gix::objs::Commit {
            tree: tree_oid,
            parents: vec![].into(),
            author: author.to_owned(),
            committer: author.to_owned(),
            encoding: None,
            message: "init".into(),
            extra_headers: vec![],
        };
        let commit_oid: gix::ObjectId = gix_repo.write_object(&commit).unwrap().into();
        gix_repo
            .reference(
                "refs/heads/main",
                commit_oid,
                gix::refs::transaction::PreviousValue::Any,
                "init",
            )
            .unwrap();
        drop(gix_repo);

        // Open via GitRepo (which doesn't auto-create dirty)
        let repo2 = GitRepo::open(tmp2.path(), "test2").unwrap();

        // rebase_dirty should create the dirty branch
        let (success, conflicts) = repo2.rebase_dirty("ours").unwrap();
        assert!(success);
        assert!(conflicts.is_empty());

        // dirty should now exist and point to main
        let dirty_oid = repo2.resolve_ref(DIRTY_BRANCH).unwrap();
        let main_oid = repo2.resolve_ref(MAIN_BRANCH).unwrap();
        assert_eq!(dirty_oid, main_oid);
    }

    // ── rebase_dirty_excluding (publish reconcile, DEV-10048) ───────────────

    /// The no-op / removed-key case the publish redesign fixes: the user's edit
    /// is a publish no-op (here, a removed key), so the publish skipped it and
    /// `main` never advanced. Excluding the path during reconcile converges it
    /// back to `main` instead of re-accumulating the edit on `dirty` as a phantom.
    #[test]
    fn rebase_excluding_converges_excluded_path_to_main() {
        let (_tmp, repo) = setup_repo();

        // main has the published record with two keys.
        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[FileChange {
                path: "rec.json".to_string(),
                content: Some("{\"a\":1,\"b\":2}".to_string()),
                oid: None,
                change_type: ChangeType::Add,
            }],
            "seed main",
        )
        .unwrap();
        repo.rebase_dirty("diff3").unwrap(); // dirty == merge_base == main

        // User removes key `b` on dirty (a publish no-op — main does NOT advance).
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[FileChange {
                path: "rec.json".to_string(),
                content: Some("{\"a\":1}".to_string()),
                oid: None,
                change_type: ChangeType::Modify,
            }],
            "user removes key b",
        )
        .unwrap();

        // Reconcile excluding the no-op path → it converges to main, removal dropped.
        let (success, conflicts) = repo
            .rebase_dirty_excluding("diff3", &["rec.json".to_string()])
            .unwrap();
        assert!(success);
        assert!(conflicts.is_empty());

        assert_eq!(
            repo.get_file_content(DIRTY_BRANCH, "rec.json")
                .unwrap()
                .as_deref(),
            Some("{\"a\":1,\"b\":2}"),
            "excluded path must converge to main (phantom removal dropped)"
        );
    }

    /// A non-excluded edit (e.g. a web-origin failure that stays on `dirty`) is
    /// still re-applied, while a sibling excluded path converges to `main`.
    #[test]
    fn rebase_excluding_keeps_non_excluded_edit() {
        let (_tmp, repo) = setup_repo();

        repo.commit_changes_to_ref(
            MAIN_BRANCH,
            &[
                FileChange {
                    path: "r1.json".to_string(),
                    content: Some("{\"v\":1}".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
                FileChange {
                    path: "r2.json".to_string(),
                    content: Some("{\"v\":1}".to_string()),
                    oid: None,
                    change_type: ChangeType::Add,
                },
            ],
            "seed main",
        )
        .unwrap();
        repo.rebase_dirty("diff3").unwrap();

        // User edits both records on dirty.
        repo.commit_changes_to_ref(
            DIRTY_BRANCH,
            &[
                FileChange {
                    path: "r1.json".to_string(),
                    content: Some("{\"v\":\"user1\"}".to_string()),
                    oid: None,
                    change_type: ChangeType::Modify,
                },
                FileChange {
                    path: "r2.json".to_string(),
                    content: Some("{\"v\":\"user2\"}".to_string()),
                    oid: None,
                    change_type: ChangeType::Modify,
                },
            ],
            "user edits both",
        )
        .unwrap();

        // Exclude only r1 (it published / was a no-op); r2 stays pending on dirty.
        let (success, _) = repo
            .rebase_dirty_excluding("diff3", &["r1.json".to_string()])
            .unwrap();
        assert!(success);

        assert_eq!(
            repo.get_file_content(DIRTY_BRANCH, "r1.json")
                .unwrap()
                .as_deref(),
            Some("{\"v\":1}"),
            "excluded r1 converges to main"
        );
        assert_eq!(
            repo.get_file_content(DIRTY_BRANCH, "r2.json")
                .unwrap()
                .as_deref(),
            Some("{\"v\":\"user2\"}"),
            "non-excluded r2 keeps the user edit"
        );
    }
}
