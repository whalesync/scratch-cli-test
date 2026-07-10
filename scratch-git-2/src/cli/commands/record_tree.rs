//! `scratchmd record-tree` — derive the parent/child tree of a folder's
//! records from the parent pointer stored inside each record file.
//!
//! Fully generic: the folder's `schema.json` declares WHERE the parent pointer
//! lives (`recordTree.parentIdPath`, optional `recordTree.parentKindPath`, plus
//! the existing `idPath`), and this command only follows those declared
//! dot-paths — it has no connector knowledge. A folder whose schema declares no
//! `recordTree` is simply not tree-shaped and the command fails with a clear
//! message. Today the Notion "Page Tree" table is the only declaring table.
//!
//! Node names come from the record FILENAME stem (already human-named by the
//! pull's title-based file naming), so no value-shape knowledge is needed for
//! labels either.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::Serialize;
use serde_json::Value;

use crate::shared::json_path::{get_by_dot_path, read_record_id_as_string, DEFAULT_ID_PATH};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordTreeNode {
    /// Filename stem of the record file, or the sibling folder's name for
    /// `kind == "folder"` nodes (both human-named by the pull).
    pub name: String,
    /// Record file name (with extension) for record nodes; the workspace-
    /// relative folder path for folder nodes.
    pub file: String,
    /// `"record"` (a record file of this folder) or `"folder"` (a sibling data
    /// folder embedded inside one of this folder's records — e.g. a synced
    /// Notion database living inside a page).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// The node's own URL in the external service — for record nodes, the
    /// value at the schema-declared `recordTree.recordUrlPath`; for folder
    /// nodes, the sibling schema's `remoteWebUrl`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub children: Vec<RecordTreeNode>,
}

const NODE_KIND_RECORD: &str = "record";
const NODE_KIND_FOLDER: &str = "folder";

/// A sibling data folder of the same connection, as a candidate for embedding
/// into the tree (matched by its remote table ids appearing inside records).
struct SiblingFolderRef {
    /// Workspace-relative `<connection>/<sub>` path.
    folder_path: String,
    /// Last path segment — the name the user sees in the sidebar.
    display_name: String,
    /// The folder's remote table ids (`schema.id.remoteId`).
    remote_id_values: Vec<String>,
    /// The folder's deep link in the external service (`schema.remoteWebUrl`).
    remote_web_url: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordTreeResult {
    pub folder: String,
    pub total_records: usize,
    /// Files that could not be read/parsed, as "<file>: <error>" strings.
    pub parse_errors: Vec<String>,
    pub roots: Vec<RecordTreeNode>,
}

/// One record's extracted tree fields before assembly.
struct FlatRecordEntry {
    name: String,
    file: String,
    id: Option<String>,
    parent_id: Option<String>,
    parent_kind: Option<String>,
    url: Option<String>,
}

pub fn run(workspace: &Path, folder: &str) -> anyhow::Result<()> {
    let workspace_dir = super::index::resolve_workspace(workspace)?;
    let result = build_record_tree(&workspace_dir, folder)?;
    println!(
        "{}",
        serde_json::to_string(&result).context("serialization error")?
    );
    Ok(())
}

/// Build the record tree for `folder` (workspace-relative
/// `<connection>/<subfolder>`). Public for the inline tests, which call it with
/// a fixture directory instead of a marker-discovered workspace.
pub fn build_record_tree(workspace_dir: &Path, folder: &str) -> anyhow::Result<RecordTreeResult> {
    let schema = load_folder_schema(workspace_dir, folder).with_context(|| {
        format!("no readable schema.json for folder {folder:?} — has the folder been pulled?")
    })?;

    let Some(record_tree_decl) = schema.get("recordTree").and_then(Value::as_object) else {
        bail!(
            "folder {folder:?} does not declare a record tree — its schema.json has no `recordTree` \
             (only tables whose records carry a parent pointer support a tree view)"
        );
    };
    let parent_id_path = record_tree_decl
        .get("parentIdPath")
        .and_then(Value::as_str)
        .context("schema `recordTree` is missing `parentIdPath`")?;
    let parent_kind_path = record_tree_decl
        .get("parentKindPath")
        .and_then(Value::as_str);
    let record_url_path = record_tree_decl
        .get("recordUrlPath")
        .and_then(Value::as_str);
    let id_path = schema
        .get("idPath")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_ID_PATH);

    let working_dir = resolve_folder_working_dir(workspace_dir, folder);
    let mut record_file_names = list_record_json_file_names(&working_dir)?;
    record_file_names.sort();

    // Sibling data folders of the same connection, matched inside records by
    // their remote table ids (e.g. a synced Notion database's `child_database`
    // block carries the database id as its own block id).
    let sibling_folder_refs = discover_sibling_folder_refs(workspace_dir, folder);
    let mut sibling_index_by_remote_id: HashMap<&str, usize> = HashMap::new();
    for (sibling_index, sibling) in sibling_folder_refs.iter().enumerate() {
        for remote_id_value in &sibling.remote_id_values {
            sibling_index_by_remote_id
                .entry(remote_id_value.as_str())
                .or_insert(sibling_index);
        }
    }

    let mut flat_record_entries: Vec<FlatRecordEntry> = Vec::new();
    let mut parse_errors: Vec<String> = Vec::new();
    // (sibling folder, containing record id) pairs. A set because deep child
    // recursion duplicates blocks (a page's blocks reappear nested inside its
    // ancestors' content) — every copy names the same containing page.
    let mut embedded_folder_parent_edges: HashSet<(usize, String)> = HashSet::new();
    for file_name in &record_file_names {
        let record = match read_record_json(&working_dir.join(file_name)) {
            Ok(value) => value,
            Err(error) => {
                parse_errors.push(format!("{file_name}: {error}"));
                continue;
            }
        };
        let name = file_name
            .strip_suffix(".json")
            .unwrap_or(file_name)
            .to_string();
        if !sibling_index_by_remote_id.is_empty() {
            collect_embedded_folder_parent_edges(
                &record,
                &sibling_index_by_remote_id,
                &mut embedded_folder_parent_edges,
            );
        }
        flat_record_entries.push(FlatRecordEntry {
            name,
            file: file_name.clone(),
            id: read_record_id_as_string(&record, id_path),
            // The parent id gets the same string/number coercion as record ids.
            parent_id: read_record_id_as_string(&record, parent_id_path),
            parent_kind: parent_kind_path
                .and_then(|path| get_by_dot_path(&record, path))
                .and_then(Value::as_str)
                .map(str::to_string),
            url: record_url_path
                .and_then(|path| get_by_dot_path(&record, path))
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }

    let mut folder_nodes_by_parent_record_id =
        build_folder_nodes_by_parent_record_id(&sibling_folder_refs, &embedded_folder_parent_edges);
    let roots = assemble_forest(&flat_record_entries, &mut folder_nodes_by_parent_record_id);

    Ok(RecordTreeResult {
        folder: folder.to_string(),
        total_records: flat_record_entries.len(),
        parse_errors,
        roots,
    })
}

/// Walk a record's JSON for embedded references to sibling folders: any nested
/// object whose `id` equals a sibling folder's remote table id AND that carries
/// a `parent.page_id` marks that folder as living inside the page named by
/// `parent.page_id`. Value-driven — no service-specific key names beyond the
/// generic `id`/`parent` envelope every tree-declaring table already relies on.
fn collect_embedded_folder_parent_edges(
    value: &Value,
    sibling_index_by_remote_id: &HashMap<&str, usize>,
    embedded_folder_parent_edges: &mut HashSet<(usize, String)>,
) {
    match value {
        Value::Object(map) => {
            if let Some(object_id) = map.get("id").and_then(Value::as_str) {
                if let Some(sibling_index) = sibling_index_by_remote_id.get(object_id) {
                    let containing_page_id = map
                        .get("parent")
                        .and_then(|parent| parent.get("page_id"))
                        .and_then(Value::as_str);
                    if let Some(containing_page_id) = containing_page_id {
                        embedded_folder_parent_edges
                            .insert((*sibling_index, containing_page_id.to_string()));
                    }
                }
            }
            for nested_value in map.values() {
                collect_embedded_folder_parent_edges(
                    nested_value,
                    sibling_index_by_remote_id,
                    embedded_folder_parent_edges,
                );
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_embedded_folder_parent_edges(
                    item,
                    sibling_index_by_remote_id,
                    embedded_folder_parent_edges,
                );
            }
        }
        _ => {}
    }
}

/// Materialize the discovered edges into folder nodes grouped by the record id
/// of their containing page. Edges whose containing page is not a record of
/// this folder are dropped (the folder still shows in the sidebar; this view is
/// scoped to the target folder's records).
fn build_folder_nodes_by_parent_record_id(
    sibling_folder_refs: &[SiblingFolderRef],
    embedded_folder_parent_edges: &HashSet<(usize, String)>,
) -> HashMap<String, Vec<RecordTreeNode>> {
    let mut folder_nodes_by_parent_record_id: HashMap<String, Vec<RecordTreeNode>> = HashMap::new();
    let mut sorted_edges: Vec<&(usize, String)> = embedded_folder_parent_edges.iter().collect();
    sorted_edges.sort();
    for (sibling_index, containing_page_id) in sorted_edges {
        let sibling = &sibling_folder_refs[*sibling_index];
        folder_nodes_by_parent_record_id
            .entry(containing_page_id.clone())
            .or_default()
            .push(RecordTreeNode {
                name: sibling.display_name.clone(),
                file: sibling.folder_path.clone(),
                kind: NODE_KIND_FOLDER,
                id: sibling.remote_id_values.first().cloned(),
                parent_kind: None,
                parent_id: Some(containing_page_id.clone()),
                url: sibling.remote_web_url.clone(),
                children: Vec::new(),
            });
    }
    folder_nodes_by_parent_record_id
}

/// Every OTHER data folder of the same connection that has a readable cached
/// `schema.json` with remote table ids. Nested folder layouts are walked a few
/// levels deep; unreadable schemas are skipped silently (they simply can't be
/// matched).
fn discover_sibling_folder_refs(workspace_dir: &Path, folder: &str) -> Vec<SiblingFolderRef> {
    let normalized = folder.trim_start_matches('/');
    let (connection_name, target_sub_path) = match normalized.find('/') {
        Some(index) => (&normalized[..index], &normalized[index + 1..]),
        None => (normalized, ""),
    };
    let connection_cache_dir = workspace_dir
        .join(".scratch")
        .join("connections")
        .join("scratch")
        .join(connection_name);

    let mut sibling_folder_refs = Vec::new();
    let mut pending_dirs = vec![(connection_cache_dir.clone(), String::new(), 0usize)];
    while let Some((dir, sub_path, depth)) = pending_dirs.pop() {
        if depth > 4 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(dir_name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let entry_sub_path = if sub_path.is_empty() {
                dir_name.clone()
            } else {
                format!("{sub_path}/{dir_name}")
            };
            if entry_sub_path == target_sub_path {
                continue;
            }
            let schema_path = entry.path().join("schema.json");
            if let Some((remote_id_values, remote_web_url)) = read_sibling_schema_ref(&schema_path)
            {
                if !remote_id_values.is_empty() {
                    sibling_folder_refs.push(SiblingFolderRef {
                        folder_path: format!("{connection_name}/{entry_sub_path}"),
                        display_name: dir_name,
                        remote_id_values,
                        remote_web_url,
                    });
                    continue;
                }
            }
            pending_dirs.push((entry.path(), entry_sub_path, depth + 1));
        }
    }
    sibling_folder_refs.sort_by(|a, b| a.folder_path.cmp(&b.folder_path));
    sibling_folder_refs
}

/// `schema.id.remoteId` string values + `schema.remoteWebUrl` from a folder's
/// cached schema.json, or `None` when the file is absent/unreadable/shapeless.
fn read_sibling_schema_ref(schema_path: &Path) -> Option<(Vec<String>, Option<String>)> {
    let raw = std::fs::read_to_string(schema_path).ok()?;
    let schema: Value = serde_json::from_str(&raw).ok()?;
    let remote_id_values = schema
        .get("id")?
        .get("remoteId")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let remote_web_url = schema
        .get("remoteWebUrl")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((remote_id_values, remote_web_url))
}

/// Group entries under their in-folder parents. An entry is a child when its
/// `parent_id` matches another entry's `id` (self-loops excluded); everything
/// else is a root — including entries whose parent lives outside the folder
/// (their `parent_kind`/`parent_id` stay on the node so a UI can say why).
/// Cycle-safe: entries stuck in a parent cycle are emitted as roots rather
/// than silently dropped. Embedded sibling-folder nodes are appended to the
/// children of the record that contains them.
fn assemble_forest(
    flat_record_entries: &[FlatRecordEntry],
    folder_nodes_by_parent_record_id: &mut HashMap<String, Vec<RecordTreeNode>>,
) -> Vec<RecordTreeNode> {
    let mut entry_index_by_record_id: HashMap<&str, usize> = HashMap::new();
    for (index, entry) in flat_record_entries.iter().enumerate() {
        if let Some(id) = entry.id.as_deref() {
            entry_index_by_record_id.entry(id).or_insert(index);
        }
    }

    let mut child_indexes_by_parent_index: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut root_indexes: Vec<usize> = Vec::new();
    for (index, entry) in flat_record_entries.iter().enumerate() {
        let in_folder_parent_index = entry
            .parent_id
            .as_deref()
            .and_then(|parent_id| entry_index_by_record_id.get(parent_id).copied())
            .filter(|parent_index| *parent_index != index);
        match in_folder_parent_index {
            Some(parent_index) => child_indexes_by_parent_index
                .entry(parent_index)
                .or_default()
                .push(index),
            None => root_indexes.push(index),
        }
    }

    let mut visited_entry_indexes: HashSet<usize> = HashSet::new();
    let mut roots: Vec<RecordTreeNode> = Vec::new();
    for index in root_indexes {
        if let Some(node) = materialize_node(
            index,
            flat_record_entries,
            &child_indexes_by_parent_index,
            &mut visited_entry_indexes,
            folder_nodes_by_parent_record_id,
        ) {
            roots.push(node);
        }
    }
    // Entries unreachable from any root can only be members of a parent cycle;
    // surface them as roots instead of dropping them.
    for index in 0..flat_record_entries.len() {
        if let Some(node) = materialize_node(
            index,
            flat_record_entries,
            &child_indexes_by_parent_index,
            &mut visited_entry_indexes,
            folder_nodes_by_parent_record_id,
        ) {
            roots.push(node);
        }
    }
    roots
}

fn materialize_node(
    entry_index: usize,
    flat_record_entries: &[FlatRecordEntry],
    child_indexes_by_parent_index: &HashMap<usize, Vec<usize>>,
    visited_entry_indexes: &mut HashSet<usize>,
    folder_nodes_by_parent_record_id: &mut HashMap<String, Vec<RecordTreeNode>>,
) -> Option<RecordTreeNode> {
    if !visited_entry_indexes.insert(entry_index) {
        return None;
    }
    let entry = &flat_record_entries[entry_index];
    let mut children: Vec<RecordTreeNode> = child_indexes_by_parent_index
        .get(&entry_index)
        .map(|child_indexes| {
            child_indexes
                .iter()
                .filter_map(|child_index| {
                    materialize_node(
                        *child_index,
                        flat_record_entries,
                        child_indexes_by_parent_index,
                        visited_entry_indexes,
                        folder_nodes_by_parent_record_id,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    // Sibling data folders embedded inside this record (e.g. a synced database
    // living inside this page) render as its children, after the record children.
    if let Some(record_id) = entry.id.as_deref() {
        if let Some(embedded_folder_nodes) = folder_nodes_by_parent_record_id.remove(record_id) {
            children.extend(embedded_folder_nodes);
        }
    }
    Some(RecordTreeNode {
        name: entry.name.clone(),
        file: entry.file.clone(),
        kind: NODE_KIND_RECORD,
        id: entry.id.clone(),
        parent_kind: entry.parent_kind.clone(),
        parent_id: entry.parent_id.clone(),
        url: entry.url.clone(),
        children,
    })
}

/// `<workspace>/<connection>/<subfolder>` — the folder's working files.
/// Mirrors the private `resolve_folder_paths` in `shared/folder_index.rs`.
fn resolve_folder_working_dir(workspace_dir: &Path, folder: &str) -> PathBuf {
    let normalized = folder.trim_start_matches('/');
    match normalized.find('/') {
        Some(index) => workspace_dir
            .join(&normalized[..index])
            .join(&normalized[index + 1..]),
        None => workspace_dir.join(normalized),
    }
}

/// Load the folder's cached `schema.json`
/// (`<workspace>/.scratch/connections/scratch/<conn>/<sub>/schema.json`).
/// Mirrors the private `resolve_folder_schema_path` in `shared/folder_index.rs`.
fn load_folder_schema(workspace_dir: &Path, folder: &str) -> anyhow::Result<Value> {
    let normalized = folder.trim_start_matches('/');
    let (connection_name, sub_path) = match normalized.find('/') {
        Some(index) => (&normalized[..index], &normalized[index + 1..]),
        None => (normalized, ""),
    };
    let mut schema_dir = workspace_dir
        .join(".scratch")
        .join("connections")
        .join("scratch")
        .join(connection_name);
    if !sub_path.is_empty() {
        schema_dir = schema_dir.join(sub_path);
    }
    let schema_path = schema_dir.join("schema.json");
    let raw = std::fs::read_to_string(&schema_path)
        .with_context(|| format!("cannot read {}", schema_path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("cannot parse {}", schema_path.display()))
}

/// Regular non-dot `*.json` files directly in the folder's working dir.
fn list_record_json_file_names(working_dir: &Path) -> anyhow::Result<Vec<String>> {
    let entries = std::fs::read_dir(working_dir)
        .with_context(|| format!("cannot list folder {}", working_dir.display()))?;
    let mut file_names = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.ends_with(".json") && !name.starts_with('.') {
            file_names.push(name);
        }
    }
    Ok(file_names)
}

fn read_record_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("read error: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("parse error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_fixture_workspace(
        records: &[(&str, serde_json::Value)],
        schema: serde_json::Value,
    ) -> tempfile::TempDir {
        let workspace = tempfile::TempDir::new().expect("tempdir");
        let folder_dir = workspace.path().join("my-conn").join("pages");
        fs::create_dir_all(&folder_dir).expect("folder dir");
        let schema_dir = workspace
            .path()
            .join(".scratch")
            .join("connections")
            .join("scratch")
            .join("my-conn")
            .join("pages");
        fs::create_dir_all(&schema_dir).expect("schema dir");
        fs::write(schema_dir.join("schema.json"), schema.to_string()).expect("schema write");
        for (file_name, record) in records {
            fs::write(folder_dir.join(file_name), record.to_string()).expect("record write");
        }
        workspace
    }

    fn tree_declaring_schema() -> serde_json::Value {
        serde_json::json!({
            "idPath": "id",
            "recordTree": { "parentIdPath": "parent.page_id", "parentKindPath": "parent.type" }
        })
    }

    fn write_sibling_folder(workspace: &tempfile::TempDir, folder_name: &str, remote_ids: &[&str]) {
        let schema_dir = workspace
            .path()
            .join(".scratch")
            .join("connections")
            .join("scratch")
            .join("my-conn")
            .join(folder_name);
        fs::create_dir_all(&schema_dir).expect("sibling schema dir");
        let schema = serde_json::json!({ "id": { "wsId": folder_name, "remoteId": remote_ids } });
        fs::write(schema_dir.join("schema.json"), schema.to_string()).expect("sibling schema");
    }

    fn page(id: &str, parent: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "id": id, "parent": parent })
    }

    #[test]
    fn builds_a_forest_from_declared_parent_pointers() {
        let workspace = write_fixture_workspace(
            &[
                (
                    "root-page.json",
                    page(
                        "r1",
                        serde_json::json!({ "type": "workspace", "workspace": true }),
                    ),
                ),
                (
                    "child-a.json",
                    page(
                        "c1",
                        serde_json::json!({ "type": "page_id", "page_id": "r1" }),
                    ),
                ),
                (
                    "grandchild.json",
                    page(
                        "g1",
                        serde_json::json!({ "type": "page_id", "page_id": "c1" }),
                    ),
                ),
                (
                    "orphan.json",
                    page(
                        "o1",
                        serde_json::json!({ "type": "page_id", "page_id": "not-in-folder" }),
                    ),
                ),
            ],
            tree_declaring_schema(),
        );

        let result = build_record_tree(workspace.path(), "my-conn/pages").expect("tree");

        assert_eq!(result.total_records, 4);
        assert!(result.parse_errors.is_empty());
        let root_names: Vec<&str> = result.roots.iter().map(|node| node.name.as_str()).collect();
        // Sorted file order: orphan (unresolvable parent) and the workspace root.
        assert_eq!(root_names, vec!["orphan", "root-page"]);

        let workspace_root = &result.roots[1];
        assert_eq!(workspace_root.parent_kind.as_deref(), Some("workspace"));
        assert_eq!(workspace_root.children.len(), 1);
        assert_eq!(workspace_root.children[0].name, "child-a");
        assert_eq!(workspace_root.children[0].children[0].name, "grandchild");

        let orphan_root = &result.roots[0];
        assert_eq!(orphan_root.parent_id.as_deref(), Some("not-in-folder"));
        assert!(orphan_root.children.is_empty());
    }

    #[test]
    fn embedded_sibling_folders_attach_to_their_containing_page_once() {
        // The sibling database's remote id appears as a nested object id with a
        // parent.page_id — once directly in the containing page's content, and
        // once duplicated inside the ancestor's recursively-fetched content.
        let embedded_database_block = serde_json::json!({
            "object": "block",
            "id": "db-id-1",
            "parent": { "type": "page_id", "page_id": "c1" },
            "type": "child_database",
            "child_database": { "title": "DB1" }
        });
        let workspace = write_fixture_workspace(
            &[
                (
                    "root-page.json",
                    serde_json::json!({
                        "id": "r1",
                        "parent": { "type": "workspace", "workspace": true },
                        "page_content": [
                            { "object": "block", "id": "c1", "type": "child_page",
                              "children": [embedded_database_block.clone()] }
                        ]
                    }),
                ),
                (
                    "child.json",
                    serde_json::json!({
                        "id": "c1",
                        "parent": { "type": "page_id", "page_id": "r1" },
                        "page_content": [embedded_database_block]
                    }),
                ),
                (
                    "mentions-unknown-db.json",
                    serde_json::json!({
                        "id": "m1",
                        "parent": { "type": "workspace", "workspace": true },
                        "page_content": [
                            // References a sibling whose containing page is NOT
                            // a record of this folder — the edge is dropped.
                            { "id": "db-id-2", "parent": { "type": "page_id", "page_id": "not-in-folder" } }
                        ]
                    }),
                ),
            ],
            tree_declaring_schema(),
        );
        write_sibling_folder(&workspace, "db1", &["db-id-1", "ds-id-1"]);
        write_sibling_folder(&workspace, "db2", &["db-id-2"]);

        let result = build_record_tree(workspace.path(), "my-conn/pages").expect("tree");

        let root = result
            .roots
            .iter()
            .find(|node| node.name == "root-page")
            .expect("root page");
        assert_eq!(root.children.len(), 1);
        let child_page = &root.children[0];
        assert_eq!(child_page.name, "child");
        // Exactly one folder node despite the duplicated nested copy.
        assert_eq!(child_page.children.len(), 1);
        let folder_node = &child_page.children[0];
        assert_eq!(folder_node.kind, "folder");
        assert_eq!(folder_node.name, "db1");
        assert_eq!(folder_node.file, "my-conn/db1");
        assert_eq!(folder_node.id.as_deref(), Some("db-id-1"));

        // The unmatched edge (containing page not in this folder) is dropped.
        let mentions_page = result
            .roots
            .iter()
            .find(|node| node.name == "mentions-unknown-db")
            .expect("mentions page");
        assert!(mentions_page.children.is_empty());
        // Record nodes carry the record kind.
        assert_eq!(root.kind, "record");
    }

    #[test]
    fn parent_cycles_surface_as_roots_instead_of_vanishing() {
        let workspace = write_fixture_workspace(
            &[
                (
                    "cycle-a.json",
                    page(
                        "a",
                        serde_json::json!({ "type": "page_id", "page_id": "b" }),
                    ),
                ),
                (
                    "cycle-b.json",
                    page(
                        "b",
                        serde_json::json!({ "type": "page_id", "page_id": "a" }),
                    ),
                ),
            ],
            tree_declaring_schema(),
        );

        let result = build_record_tree(workspace.path(), "my-conn/pages").expect("tree");

        // The first cycle member becomes a root carrying the other as a child.
        assert_eq!(result.roots.len(), 1);
        assert_eq!(result.roots[0].name, "cycle-a");
        assert_eq!(result.roots[0].children[0].name, "cycle-b");
    }

    #[test]
    fn folder_without_record_tree_declaration_fails_with_clear_message() {
        let workspace = write_fixture_workspace(
            &[(
                "row.json",
                page("r1", serde_json::json!({ "type": "workspace" })),
            )],
            serde_json::json!({ "idPath": "id" }),
        );

        let error = build_record_tree(workspace.path(), "my-conn/pages").unwrap_err();
        assert!(error.to_string().contains("does not declare a record tree"));
    }

    #[test]
    fn unparseable_record_files_are_reported_not_fatal() {
        let workspace = write_fixture_workspace(
            &[(
                "good.json",
                page(
                    "r1",
                    serde_json::json!({ "type": "workspace", "workspace": true }),
                ),
            )],
            tree_declaring_schema(),
        );
        fs::write(
            workspace
                .path()
                .join("my-conn")
                .join("pages")
                .join("bad.json"),
            "{ not json",
        )
        .expect("bad file");

        let result = build_record_tree(workspace.path(), "my-conn/pages").expect("tree");

        assert_eq!(result.total_records, 1);
        assert_eq!(result.parse_errors.len(), 1);
        assert!(result.parse_errors[0].starts_with("bad.json:"));
    }
}
