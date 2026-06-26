//! Reads a real Scratch workspace off disk and computes, for every record, its
//! published / approved / local-working states and the field-level diff between
//! published and working.
//!
//! Correctness comes from reusing `scratch-git-2`'s own `shared` modules — the
//! published snapshot is the `main` git tree, the approved snapshot is that tree
//! with `accepted-patches.json` applied, and the working snapshot is read
//! straight from the worktree — exactly as the CLI and desktop app see them.
//! The CLI's marker module isn't exported by the library, so (like `rad`) we
//! parse `.scratch/.scratchmd` directly.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use scratch_git_2::shared::accepted_patches;
use scratch_git_2::shared::git_local::{self, FileMap};
use scratch_git_2::shared::layout::WorkspaceLayout;
use scratch_git_2::shared::review_ops::{self, ConnectionPaths};
use serde::Deserialize;
use serde_json::Value;

/// A flattened leaf value longer than this is truncated before it goes into the
/// search blob, so one giant rich-text field can't bloat every row.
const MAX_SEARCH_VALUE_LEN: usize = 240;

// ---------------------------------------------------------------------------
// Workspace marker (.scratch/.scratchmd)
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
struct ConnectionEntry {
    #[serde(rename = "displayName")]
    display_name: String,
    service: String,
    #[serde(rename = "repoPath")]
    repo_path: String,
    #[serde(rename = "dirName")]
    dir_name: String,
}

// ---------------------------------------------------------------------------
// What `proof` renders
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
pub struct Record {
    pub connection_display_name: String,
    pub connection_dir_name: String,
    pub service: String,
    pub folder: String,
    /// The record filename without its `.json` extension.
    pub record_file_stem: String,
    /// Connection-relative path, e.g. `Products/foo.json`.
    pub path: String,
    /// Best-effort human title (a title/name field if present, else the stem).
    pub display_title: String,
    pub state: ChangeState,
    pub field_changes: Vec<FieldChange>,
    /// The full working record (or published, for a deleted record), handed to
    /// templates as `data` so they can address arbitrary fields verbatim. Held
    /// behind an `Arc` so the lookup index can share it without copying.
    pub data: Option<Arc<Value>>,
    /// The published record (the `main` git tree's version), handed to templates
    /// as `published` so `mark()` can highlight a field's word-level edits.
    pub published_data: Option<Arc<Value>>,
    /// Every leaf of the record flattened to `(dotted.path, stringified value)`,
    /// in stable order. The default card renders these so unchanged records still
    /// show their values; per-folder templates can ignore it and address `data`.
    pub flat_fields: Vec<(String, String)>,
    /// A best-effort one-line prose snippet for the row (the first field value
    /// that reads like a sentence), so rows aren't bare titles.
    pub summary: Option<String>,
    /// Lowercased haystack for client-side instant search (title, metadata, and
    /// every flattened field name + value in the record).
    pub search_blob: String,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub name: String,
    pub records: Vec<Record>,
    /// Resolves foreign-key references for templates: "find this id in this
    /// folder, return this field". Shared (`Arc`) so it can be handed to each
    /// render pass cheaply.
    pub lookup_index: Arc<LookupIndex>,
}

/// A per-connection `id → record` index that lets a template resolve a related
/// record by its identifier and read a field off it — e.g. a Shopify product's
/// `featuredMedia.id` → the media record in `Product Media` → its `image.url`.
/// Records are keyed by their own top-level `id` field (Shopify gids, Webflow
/// ids, Airtable record ids all live there), scoped to the connection, with the
/// owning folder retained so lookups can be folder-filtered.
/// Groups records by `(connection, folder)` so a template can do an explicit,
/// literal lookup. The renderer holds no opinion about which field identifies a
/// record or how folders are named — the template spells out the folder, the
/// field to match, the value, and the field to return.
#[derive(Debug, Default)]
pub struct LookupIndex {
    records_by_connection_and_folder: HashMap<(String, String), Vec<Arc<Value>>>,
}

impl LookupIndex {
    fn build(records: &[Record]) -> LookupIndex {
        let mut records_by_connection_and_folder: HashMap<(String, String), Vec<Arc<Value>>> =
            HashMap::new();
        for record in records {
            let Some(data) = &record.data else { continue };
            records_by_connection_and_folder
                .entry((record.connection_dir_name.clone(), record.folder.clone()))
                .or_default()
                .push(Arc::clone(data));
        }
        LookupIndex {
            records_by_connection_and_folder,
        }
    }

    /// In `connection_dir_name`/`folder`, finds the first record whose
    /// `match_field` (a dotted path) stringifies to `match_value`, and returns
    /// its `return_field` (a dotted path). A literal scan — no special handling
    /// of any field, no fuzzy folder matching.
    pub fn resolve(
        &self,
        connection_dir_name: &str,
        folder: &str,
        match_field: &str,
        match_value: &str,
        return_field: &str,
    ) -> Option<Value> {
        let records = self
            .records_by_connection_and_folder
            .get(&(connection_dir_name.to_string(), folder.to_string()))?;
        for record in records {
            if nested_json_value(record, match_field)
                .and_then(scalar_to_string)
                .as_deref()
                == Some(match_value)
            {
                return nested_json_value(record, return_field).cloned();
            }
        }
        None
    }
}

/// Stringifies a scalar JSON value so a template's `match_value` (which arrives
/// as text) can be compared against it — strings verbatim, numbers and booleans
/// rendered. Non-scalars don't compare.
fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(string) => Some(string.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

/// Walks a dotted path (`image.url`) into a JSON object.
fn nested_json_value<'a>(value: &'a Value, dot_path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in dot_path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

// ---------------------------------------------------------------------------
// Filtering (server-side search)
// ---------------------------------------------------------------------------

/// Filters records by a search string with the same grammar the UI offers:
/// free terms must all appear in the record's search blob, and `key:value`
/// modifiers (`folder:`, `service:`, `conn:`/`connection:`, `is:<state>`)
/// constrain structured fields. Runs in Rust against the in-memory records —
/// fast even across the whole workspace, and the single source of truth.
pub fn filter_records<'a>(records: &'a [Record], query: &str) -> Vec<&'a Record> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return records.iter().collect();
    }

    let mut terms: Vec<String> = Vec::new();
    let mut modifiers: Vec<(String, String)> = Vec::new();
    for token in query.split_whitespace() {
        match token.split_once(':') {
            Some((key, value)) => modifiers.push((key.to_string(), value.to_string())),
            None => terms.push(token.to_string()),
        }
    }

    records
        .iter()
        .filter(|record| record_matches(record, &terms, &modifiers))
        .collect()
}

fn record_matches(record: &Record, terms: &[String], modifiers: &[(String, String)]) -> bool {
    for term in terms {
        if !record.search_blob.contains(term) {
            return false;
        }
    }
    for (key, value) in modifiers {
        let matches = match key.as_str() {
            "folder" => record.folder.to_lowercase().contains(value),
            "service" => record.service.to_lowercase().contains(value),
            "conn" | "connection" => record
                .connection_display_name
                .to_lowercase()
                .contains(value),
            "is" => match value.as_str() {
                "changed" => record.state.is_changed(),
                "unchanged" => !record.state.is_changed(),
                other => record.state.label() == other,
            },
            // An unknown key is treated as a literal `key:value` term.
            _ => record.search_blob.contains(&format!("{key}:{value}")),
        };
        if !matches {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

pub fn load(workspace_dir: &Path) -> Result<Workspace> {
    let marker_text = std::fs::read_to_string(workspace_dir.join(".scratch/.scratchmd"))
        .with_context(|| format!("reading workspace marker in {}", workspace_dir.display()))?;
    let marker: WorkspaceMarker = serde_yaml::from_str(&marker_text)?;
    let layout = WorkspaceLayout::for_cli(workspace_dir);

    let mut records: Vec<Record> = Vec::new();

    for entry in &marker.connections {
        let paths = ConnectionPaths {
            conn_dir_name: entry.dir_name.clone(),
            workspace_dir: workspace_dir.to_path_buf(),
            worktree_dir: layout.worktree_path(&entry.dir_name),
            bare_repo: layout.bare_repo_path(&entry.repo_path),
            scratch_dir: layout.connection_scratch_path(&entry.dir_name),
        };

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

        records.extend(records_for_connection(
            entry,
            &published_files,
            &approved_files,
            &working_files,
        ));
    }

    // Stable, browsable order: connection, then folder, then title.
    records.sort_by(|a, b| {
        a.connection_display_name
            .cmp(&b.connection_display_name)
            .then(a.folder.cmp(&b.folder))
            .then(
                a.display_title
                    .to_lowercase()
                    .cmp(&b.display_title.to_lowercase()),
            )
    });

    let lookup_index = Arc::new(LookupIndex::build(&records));

    Ok(Workspace {
        name: marker.workbook.name,
        records,
        lookup_index,
    })
}

/// A record file lives at `<folder>/<file>.json` inside the connection repo.
/// Everything under `.scratch/` (schemas, views) and any non-JSON file is not a
/// user record.
fn is_record_path(repo_relative_path: &str) -> bool {
    repo_relative_path.ends_with(".json")
        && !repo_relative_path.starts_with(".scratch/")
        && repo_relative_path.contains('/')
}

fn records_for_connection(
    entry: &ConnectionEntry,
    published_files: &FileMap,
    approved_files: &FileMap,
    working_files: &FileMap,
) -> Vec<Record> {
    let mut record_paths: BTreeSet<&String> = BTreeSet::new();
    for key in published_files.keys().chain(working_files.keys()) {
        if is_record_path(key) {
            record_paths.insert(key);
        }
    }

    let mut records = Vec::new();
    for path in record_paths {
        let published_json = published_files.get(path).and_then(parse_json);
        let approved_json = approved_files.get(path).and_then(parse_json);
        let working_json = working_files.get(path).and_then(parse_json);

        let exists_published = published_files.contains_key(path);
        let exists_working = working_files.contains_key(path);

        let field_changes = diff_fields(published_json.as_ref(), working_json.as_ref());

        let state = if !exists_published && exists_working {
            ChangeState::Added
        } else if exists_published && !exists_working {
            ChangeState::Deleted
        } else if field_changes.is_empty() {
            ChangeState::Unchanged
        } else if working_json != approved_json {
            ChangeState::Unreviewed
        } else {
            ChangeState::Unpublished
        };

        let (folder, file) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        let record_file_stem = file.strip_suffix(".json").unwrap_or(file).to_string();
        let display_title = derive_display_title(
            &record_file_stem,
            working_json.as_ref(),
            published_json.as_ref(),
        );

        let data = working_json
            .clone()
            .or_else(|| published_json.clone())
            .map(Arc::new);
        let published_data = published_json.clone().map(Arc::new);
        let mut leaves = BTreeMap::new();
        if let Some(value) = data.as_deref() {
            flatten_into("", value, &mut leaves);
        }
        let flat_fields: Vec<(String, String)> = leaves.into_iter().collect();
        let summary = derive_summary(&flat_fields, &display_title);
        let search_blob = build_search_blob(
            &display_title,
            &entry.service,
            folder,
            &entry.display_name,
            &flat_fields,
        );

        records.push(Record {
            connection_display_name: entry.display_name.clone(),
            connection_dir_name: entry.dir_name.clone(),
            service: entry.service.clone(),
            folder: folder.to_string(),
            record_file_stem,
            path: path.clone(),
            display_title,
            state,
            field_changes,
            data,
            published_data,
            flat_fields,
            summary,
            search_blob,
        });
    }

    records
}

fn diff_fields(published: Option<&Value>, working: Option<&Value>) -> Vec<FieldChange> {
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
fn flatten_into(prefix: &str, value: &Value, out: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_into(&path, child, out);
            }
        }
        Value::Array(_) => {
            out.insert(prefix.to_string(), value.to_string());
        }
        Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        other => {
            out.insert(prefix.to_string(), other.to_string());
        }
    }
}

fn build_search_blob(
    display_title: &str,
    service: &str,
    folder: &str,
    connection_display_name: &str,
    flat_fields: &[(String, String)],
) -> String {
    let mut blob = String::new();
    let mut push = |text: &str| {
        blob.push_str(text);
        blob.push(' ');
    };
    push(display_title);
    push(service);
    push(folder);
    push(connection_display_name);

    for (field, value) in flat_fields {
        push(field);
        let truncated: String = value.chars().take(MAX_SEARCH_VALUE_LEN).collect();
        push(&truncated);
    }

    blob.to_lowercase()
}

/// Picks a one-line prose snippet for a row: the first flattened value that
/// reads like a sentence — long enough, has a space, and isn't a URL, an array,
/// an object, or a repeat of the title. Type-agnostic, so it stays connector-
/// neutral; a per-folder template can always do better.
fn derive_summary(flat_fields: &[(String, String)], display_title: &str) -> Option<String> {
    for (_field, value) in flat_fields {
        let candidate = value.trim();
        if candidate.len() < 12 || candidate == display_title {
            continue;
        }
        if candidate.starts_with('[') || candidate.starts_with('{') || candidate.starts_with("http")
        {
            continue;
        }
        if !candidate.contains(' ') {
            continue;
        }
        return Some(candidate.chars().take(200).collect());
    }
    None
}

fn parse_json(bytes: &Vec<u8>) -> Option<Value> {
    serde_json::from_slice(bytes).ok()
}

/// Best-effort human title for a record: the first present of `title`,
/// `title.rendered`/`title.raw`, `name`, `headline`, `handle`, or `slug` — else
/// the filename.
fn derive_display_title(
    record_file_stem: &str,
    working: Option<&Value>,
    published: Option<&Value>,
) -> String {
    if let Some(Value::Object(map)) = working.or(published) {
        for key in ["title", "name", "headline", "handle", "slug"] {
            match map.get(key) {
                Some(Value::String(s)) if !s.trim().is_empty() => {
                    return decode_html_entities(s);
                }
                Some(Value::Object(nested)) => {
                    for sub in ["rendered", "raw"] {
                        if let Some(Value::String(s)) = nested.get(sub) {
                            if !s.trim().is_empty() {
                                return decode_html_entities(s);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        // Many services nest the editable fields one level down (Airtable's
        // `fields`, Webflow's `fieldData`). Look in there for a name/title before
        // giving up and showing the filename.
        for container in ["fields", "fieldData"] {
            if let Some(Value::Object(nested)) = map.get(container) {
                for key in ["Name", "name", "Title", "title", "headline"] {
                    if let Some(Value::String(s)) = nested.get(key) {
                        if !s.trim().is_empty() {
                            return decode_html_entities(s);
                        }
                    }
                }
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
