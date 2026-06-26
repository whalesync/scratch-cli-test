//! Reads a real Scratch workspace off disk and computes the three-state
//! field-level diffs (published / approved / local-working) that the cockpit
//! renders.
//!
//! Correctness comes from reusing `scratch-git-2`'s own `shared` modules: the
//! published snapshot is the `main` git tree, the approved snapshot is that
//! tree with `accepted-patches.json` applied, and the working snapshot is read
//! straight from the worktree — exactly as the CLI and desktop app see them.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::Result;
use scratch_git_2::shared::accepted_patches;
use scratch_git_2::shared::git_local::{self, FileMap};
use scratch_git_2::shared::layout::WorkspaceLayout;
use scratch_git_2::shared::review_ops::{self, ConnectionPaths};
use serde::Deserialize;

/// The maximum number of changed fields we render per record card before
/// collapsing the rest into a "+N more" note, so a freshly-created record with
/// 40 fields doesn't produce a wall of diff.
const MAX_FIELDS_PER_CARD: usize = 12;

// ---------------------------------------------------------------------------
// Workspace marker (.scratch/.scratchmd) — parsed directly, since the CLI's
// marker module isn't exported by the scratch-git-2 library (only `shared` is).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WorkspaceMarker {
    workbook: WorkbookRef,
    #[serde(default)]
    connections: Vec<ConnectionEntry>,
}

#[derive(Debug, Deserialize)]
struct WorkbookRef {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionEntry {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub service: String,
    #[serde(rename = "repoPath")]
    pub repo_path: String,
    #[serde(rename = "dirName")]
    pub dir_name: String,
}

/// Reads just the connection list from the workspace marker. Used by the review
/// endpoint to resolve a connection by its on-disk directory name.
pub fn read_connections(workspace_dir: &Path) -> Result<Vec<ConnectionEntry>> {
    let marker_text = std::fs::read_to_string(workspace_dir.join(".scratch/.scratchmd"))?;
    let marker: WorkspaceMarker = serde_yaml::from_str(&marker_text)?;
    Ok(marker.connections)
}

/// Builds the `scratch-git-2` path bundle for a connection — the same shape its
/// review ops expect.
pub fn connection_paths(
    layout: &WorkspaceLayout,
    workspace_dir: &Path,
    entry: &ConnectionEntry,
) -> ConnectionPaths {
    ConnectionPaths {
        conn_dir_name: entry.dir_name.clone(),
        workspace_dir: workspace_dir.to_path_buf(),
        worktree_dir: layout.worktree_path(&entry.dir_name),
        bare_repo: layout.bare_repo_path(&entry.repo_path),
        scratch_dir: layout.connection_scratch_path(&entry.dir_name),
    }
}

// ---------------------------------------------------------------------------
// What the cockpit renders
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeState {
    /// Working differs from approved — a local edit nobody has accepted yet.
    Unreviewed,
    /// Working equals approved but approved differs from published — accepted,
    /// staged to publish, not yet live.
    Unpublished,
    /// New record present locally but not on `main`.
    Added,
    /// Record on `main` but deleted locally.
    Deleted,
    /// No local difference from published — surfaced only for browsing.
    Unchanged,
}

impl ChangeState {
    pub fn label(self) -> &'static str {
        match self {
            ChangeState::Unreviewed => "unreviewed",
            ChangeState::Unpublished => "unpublished",
            ChangeState::Added => "added",
            ChangeState::Deleted => "deleted",
            ChangeState::Unchanged => "unchanged",
        }
    }

    pub fn css_class(self) -> &'static str {
        match self {
            ChangeState::Unreviewed => "state-unreviewed",
            ChangeState::Unpublished => "state-unpublished",
            ChangeState::Added => "state-added",
            ChangeState::Deleted => "state-deleted",
            ChangeState::Unchanged => "state-unchanged",
        }
    }

    pub fn is_changed(self) -> bool {
        !matches!(self, ChangeState::Unchanged)
    }
}

#[derive(Debug, Clone)]
pub struct FieldChange {
    pub field: String,
    pub published_value: Option<String>,
    pub working_value: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RecordChange {
    pub connection_display_name: String,
    pub connection_dir_name: String,
    pub service: String,
    pub folder: String,
    pub record: String,
    /// A human display name for the record (its title/name field if present,
    /// else the filename) — used as the card headline.
    pub display_title: String,
    pub state: ChangeState,
    pub fields: Vec<FieldChange>,
    pub hidden_field_count: usize,
    /// The full working record, for rendering a near-published content preview.
    pub working_record: Option<serde_json::Value>,
}

impl RecordChange {
    /// The connection-relative path of this record, e.g. `Products/foo.json`.
    pub fn rel_path(&self) -> String {
        format!("{}/{}.json", self.folder, self.record)
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceView {
    pub workspace_name: String,
    pub changes: Vec<RecordChange>,
    pub templates: Vec<crate::cards::CardTemplate>,
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

pub fn load(workspace_dir: &Path) -> Result<WorkspaceView> {
    let marker_text = std::fs::read_to_string(workspace_dir.join(".scratch/.scratchmd"))?;
    let marker: WorkspaceMarker = serde_yaml::from_str(&marker_text)?;
    let layout = WorkspaceLayout::for_cli(workspace_dir);

    let mut all_changes: Vec<RecordChange> = Vec::new();

    for entry in &marker.connections {
        let paths = connection_paths(&layout, workspace_dir, entry);

        // Published: the `main` git tree. Missing/empty repo → no published state.
        let published_files =
            git_local::read_tree_files(&paths.bare_repo, "refs/heads/main").unwrap_or_default();

        // Working: the on-disk worktree files.
        let working_files =
            review_ops::read_worktree_files_and_scratch_state(&paths).unwrap_or_default();

        // Approved: published + accepted-patches.json.
        let accepted_patches_file =
            accepted_patches::load(&layout.connection_root_path(&entry.dir_name))
                .unwrap_or_default();
        let approved_files =
            review_ops::compute_accepted_state(&published_files, &accepted_patches_file)
                .unwrap_or_else(|_| published_files.clone());

        let connection_changes =
            diff_connection(entry, &published_files, &approved_files, &working_files);
        all_changes.extend(connection_changes);
    }

    Ok(WorkspaceView {
        workspace_name: marker.workbook.name,
        changes: all_changes,
        templates: crate::cards::load_templates(workspace_dir),
    })
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/// A record file lives at `<folder>/<file>.json` inside the connection repo.
/// Everything under `.scratch/` (schemas, views) and any non-JSON file is not
/// a user record.
fn is_record_path(repo_relative_path: &str) -> bool {
    repo_relative_path.ends_with(".json")
        && !repo_relative_path.starts_with(".scratch/")
        && repo_relative_path.contains('/')
}

fn diff_connection(
    entry: &ConnectionEntry,
    published_files: &FileMap,
    approved_files: &FileMap,
    working_files: &FileMap,
) -> Vec<RecordChange> {
    let mut record_paths: BTreeSet<&String> = BTreeSet::new();
    for key in published_files.keys().chain(working_files.keys()) {
        if is_record_path(key) {
            record_paths.insert(key);
        }
    }

    let mut changes = Vec::new();
    for path in record_paths {
        let published_json = published_files
            .get(path)
            .and_then(|bytes| parse_json(bytes));
        let approved_json = approved_files.get(path).and_then(|bytes| parse_json(bytes));
        let working_json = working_files.get(path).and_then(|bytes| parse_json(bytes));

        let exists_published = published_files.contains_key(path);
        let exists_working = working_files.contains_key(path);

        let mut field_changes = diff_fields(published_json.as_ref(), working_json.as_ref());
        let is_added = !exists_published && exists_working;
        let is_deleted = exists_published && !exists_working;

        // Every record on disk gets an entry now (so the workspace is fully
        // browsable); unchanged ones simply carry no field diffs.
        let state = if is_added {
            ChangeState::Added
        } else if is_deleted {
            ChangeState::Deleted
        } else if field_changes.is_empty() {
            ChangeState::Unchanged
        } else if working_json != approved_json {
            ChangeState::Unreviewed
        } else {
            ChangeState::Unpublished
        };

        let hidden_field_count = field_changes.len().saturating_sub(MAX_FIELDS_PER_CARD);
        field_changes.truncate(MAX_FIELDS_PER_CARD);

        let (folder, file) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        let record = file.strip_suffix(".json").unwrap_or(file).to_string();
        let display_title =
            derive_display_title(&record, working_json.as_ref(), published_json.as_ref());

        changes.push(RecordChange {
            connection_display_name: entry.display_name.clone(),
            connection_dir_name: entry.dir_name.clone(),
            service: entry.service.clone(),
            folder: folder.to_string(),
            record,
            display_title,
            state,
            fields: field_changes,
            hidden_field_count,
            working_record: working_json.clone(),
        });
    }

    changes
}

fn diff_fields(
    published: Option<&serde_json::Value>,
    working: Option<&serde_json::Value>,
) -> Vec<FieldChange> {
    let mut published_leaves = BTreeMap::new();
    let mut working_leaves = BTreeMap::new();
    if let Some(value) = published {
        flatten_into("", value, &mut published_leaves);
    }
    if let Some(value) = working {
        flatten_into("", value, &mut working_leaves);
    }

    let mut paths: BTreeSet<&String> = BTreeSet::new();
    paths.extend(published_leaves.keys());
    paths.extend(working_leaves.keys());

    let mut out = Vec::new();
    for field in paths {
        let published_value = published_leaves.get(field);
        let working_value = working_leaves.get(field);
        if published_value != working_value {
            out.push(FieldChange {
                field: field.clone(),
                published_value: published_value.cloned(),
                working_value: working_value.cloned(),
            });
        }
    }
    out
}

/// Flattens a record into `dotted.path -> stringified leaf`. Objects recurse;
/// arrays are treated as a single leaf (compact JSON) so a tags/options array
/// reads as one field rather than churning indices.
fn flatten_into(prefix: &str, value: &serde_json::Value, out: &mut BTreeMap<String, String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_into(&path, child, out);
            }
        }
        serde_json::Value::Array(_) => {
            out.insert(prefix.to_string(), value.to_string());
        }
        serde_json::Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        other => {
            out.insert(prefix.to_string(), other.to_string());
        }
    }
}

fn parse_json(bytes: &[u8]) -> Option<serde_json::Value> {
    serde_json::from_slice(bytes).ok()
}

/// Best-effort human title for a record: the first present of `title`,
/// `title.rendered`/`title.raw`, `name`, `handle`, or `slug` — else the
/// filename. Lets a card lead with "Krill Your Thirst" instead of a slug.
fn derive_display_title(
    record_file_stem: &str,
    working: Option<&serde_json::Value>,
    published: Option<&serde_json::Value>,
) -> String {
    if let Some(serde_json::Value::Object(map)) = working.or(published) {
        for key in ["title", "name", "headline", "handle", "slug"] {
            match map.get(key) {
                Some(serde_json::Value::String(s)) if !s.trim().is_empty() => {
                    return decode_html_entities(s);
                }
                Some(serde_json::Value::Object(nested)) => {
                    for sub in ["rendered", "raw"] {
                        if let Some(serde_json::Value::String(s)) = nested.get(sub) {
                            if !s.trim().is_empty() {
                                return decode_html_entities(s);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    record_file_stem.to_string()
}

/// Decodes the handful of HTML entities that show up in CMS-rendered text
/// (WordPress titles arrive as `Lover&#8217;s Guide`), so headlines read as
/// they'd publish rather than leaking markup.
fn decode_html_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        if let Some(semi) = after.find(';').filter(|&i| i <= 12) {
            if let Some(decoded) = decode_one_entity(&after[1..semi]) {
                out.push_str(&decoded);
                rest = &after[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &after[1..];
    }
    out.push_str(rest);
    out
}

fn decode_one_entity(entity: &str) -> Option<String> {
    if let Some(num) = entity.strip_prefix('#') {
        let code = if num.starts_with('x') || num.starts_with('X') {
            u32::from_str_radix(&num[1..], 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        return char::from_u32(code).map(|c| c.to_string());
    }
    let decoded = match entity {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "rsquo" => "\u{2019}",
        "lsquo" => "\u{2018}",
        "ldquo" => "\u{201C}",
        "rdquo" => "\u{201D}",
        _ => return None,
    };
    Some(decoded.to_string())
}
