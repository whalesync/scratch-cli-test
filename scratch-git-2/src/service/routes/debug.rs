use std::collections::{HashMap, HashSet, VecDeque};

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::service::envelope::{envelope_error, envelope_result};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;

/// Debug endpoint that sleeps for 30 seconds. Use this to test graceful shutdown:
/// send a request, then send SIGINT/SIGTERM and verify the server waits for it to complete.
pub async fn slow_request() -> impl IntoResponse {
    tracing::info!("[debug] slow_request: starting 30s sleep");
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    tracing::info!("[debug] slow_request: done");
    axum::Json(json!({ "ok": true, "slept_seconds": 30 }))
}

pub async fn graph(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking({
        let repos_dir = state.repos_dir.clone();
        let id = id.clone();
        move || {
            let git_repo = GitRepo::open(&repos_dir, &id)?;

            let mut refs = Vec::new();

            // List branches
            let branches = git_repo.list_branches()?;
            for (name, oid) in &branches {
                refs.push(json!({
                    "name": name,
                    "oid": oid.to_string(),
                    "type": "branch",
                }));
            }

            // List tags
            let tags = git_repo.list_tags()?;
            for (name, oid) in &tags {
                refs.push(json!({
                    "name": name,
                    "oid": oid.to_string(),
                    "type": "tag",
                }));
            }

            // Collect unique heads
            let mut unique_heads: HashSet<gix::ObjectId> = HashSet::new();
            for (_, oid) in branches.iter().chain(tags.iter()) {
                unique_heads.insert(*oid);
            }

            // Walk commit history from each head (depth 50)
            let mut commits_map: HashMap<String, serde_json::Value> = HashMap::new();

            for head_oid in &unique_heads {
                let mut queue = VecDeque::new();
                let mut visited = HashSet::new();
                queue.push_back((*head_oid, 0u32));

                while let Some((oid, depth)) = queue.pop_front() {
                    if depth >= 50 || !visited.insert(oid) {
                        continue;
                    }

                    let oid_str = oid.to_string();
                    if commits_map.contains_key(&oid_str) {
                        // Still walk parents for graph completeness
                        if let Ok(info) = git_repo.read_commit_info(oid) {
                            for parent in &info.parents {
                                queue.push_back((*parent, depth + 1));
                            }
                        }
                        continue;
                    }

                    if let Ok(info) = git_repo.read_commit_info(oid) {
                        let parent_strs: Vec<String> =
                            info.parents.iter().map(|p| p.to_string()).collect();
                        for parent in &info.parents {
                            queue.push_back((*parent, depth + 1));
                        }
                        commits_map.insert(
                            oid_str.clone(),
                            json!({
                                "oid": oid_str,
                                "message": info.message,
                                "parents": parent_strs,
                                "timestamp": info.timestamp,
                                "author": {
                                    "name": info.author_name,
                                    "email": info.author_email,
                                },
                            }),
                        );
                    }
                }
            }

            // Sort by timestamp desc
            let mut commits: Vec<_> = commits_map.into_values().collect();
            commits.sort_by(|a, b| {
                let ts_a = a["timestamp"].as_i64().unwrap_or(0);
                let ts_b = b["timestamp"].as_i64().unwrap_or(0);
                ts_b.cmp(&ts_a)
            });

            Ok::<_, AppError>(json!({
                "commits": commits,
                "refs": refs,
            }))
        }
    })
    .await;

    match result {
        Ok(inner) => envelope_result(&state, &id, inner),
        Err(e) => envelope_error(&state, Some(&id), AppError::internal(e.to_string())),
    }
}
