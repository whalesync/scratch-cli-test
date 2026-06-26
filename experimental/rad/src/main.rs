//! Rad — a HUD cockpit for reviewing AI-agent edits to Scratch content.
//!
//! Presentation: a dense, keyboard-first command center. A command bar on top,
//! a record list on the left, a diff detail pane on the right, and a keybinding
//! footer. `j/k` (or arrows) move the selection, `a/r/d` act on it, `/` or `⌘K`
//! focus search.

mod cards;
mod review;
mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Form, Query, State};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::Html;
use axum::routing::{get, post};
use axum::Router;
use maud::{html, Markup, PreEscaped, DOCTYPE};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_stream::Stream;

use workspace::{ChangeState, FieldChange, RecordChange, WorkspaceView};

const BIND_ADDR: &str = "127.0.0.1:3210";
const DEFAULT_WORKSPACE: &str = "/Users/joel/My Scratch Folder/My workspace";

const CHAR_DIFF_MAX_LEN: usize = 600;
const LONG_FIELD_LEN: usize = 90;

#[derive(Clone)]
struct AppState {
    workspace_dir: Arc<PathBuf>,
    events: broadcast::Sender<()>,
}

#[tokio::main]
async fn main() {
    let workspace_dir = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("RAD_WORKSPACE").ok())
        .unwrap_or_else(|| DEFAULT_WORKSPACE.to_string());
    let workspace_dir = Arc::new(PathBuf::from(workspace_dir));
    cards::seed_defaults(&workspace_dir);

    let (events, _) = broadcast::channel::<()>(16);
    spawn_workspace_watcher(workspace_dir.as_ref().clone(), events.clone());
    let state = AppState {
        workspace_dir: workspace_dir.clone(),
        events,
    };

    let app = Router::new()
        .route("/", get(cockpit))
        .route("/api/console", get(console_fragment))
        .route("/api/detail", get(detail_fragment))
        .route("/api/templates", get(templates_fragment))
        .route("/api/templates/save", post(template_save))
        .route("/api/events", get(events_stream))
        .route("/api/review", post(review_action))
        .route("/api/review-bulk", post(review_bulk))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(BIND_ADDR)
        .await
        .expect("bind cockpit port");
    println!("\n  ▲ Rad cockpit → http://{BIND_ADDR}");
    println!("    workspace: {}\n", workspace_dir.display());
    axum::serve(listener, app).await.expect("serve");
}

/// Watches the workspace tree and broadcasts a coalesced tick whenever files
/// change, so connected cockpits live-refresh as agents (or the user) edit.
fn spawn_workspace_watcher(workspace_dir: PathBuf, events: broadcast::Sender<()>) {
    use notify::Watcher;
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use std::time::Duration;

    std::thread::spawn(move || {
        let (raw_tx, raw_rx) = channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = raw_tx.send(res);
        }) {
            Ok(watcher) => watcher,
            Err(_) => return,
        };
        if watcher
            .watch(&workspace_dir, notify::RecursiveMode::Recursive)
            .is_err()
        {
            return;
        }
        // Coalesce each burst of filesystem events into a single tick once the
        // dust settles (250ms quiet), so one save isn't a hundred refreshes.
        loop {
            if raw_rx.recv().is_err() {
                break;
            }
            loop {
                match raw_rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(_) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = events.send(());
        }
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async fn cockpit(State(state): State<AppState>) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let load_result = tokio::task::spawn_blocking(move || workspace::load(&workspace_dir)).await;
    let markup = match load_result {
        Ok(Ok(view)) => cockpit_page(&view),
        Ok(Err(err)) => error_page(&format!("Couldn't read the workspace: {err}")),
        Err(err) => error_page(&format!("Loader panicked: {err}")),
    };
    Html(markup.into_string())
}

/// The live-refresh fragment: the console interior (rail + list + detail) plus
/// an out-of-band swap of the header counts. Fetched by the SSE client on each
/// filesystem change.
/// The standard response to any console refresh — the interior plus an
/// out-of-band swap of the header counts, with an optional error banner.
fn console_response(view: &WorkspaceView, error: Option<&str>) -> Markup {
    html! {
        @if let Some(message) = error { div.banner-error { "⚠ " (message) } }
        (console_inner(view))
        div #status-bar hx-swap-oob="innerHTML" { (status_counts(view)) }
    }
}

async fn console_fragment(State(state): State<AppState>) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let loaded = tokio::task::spawn_blocking(move || workspace::load(&workspace_dir)).await;
    let markup = match loaded {
        Ok(Ok(view)) => console_response(&view, None),
        Ok(Err(err)) => html! { div.banner-error { "⚠ " (err.to_string()) } },
        Err(err) => html! { div.banner-error { "⚠ " (err.to_string()) } },
    };
    Html(markup.into_string())
}

#[derive(Deserialize)]
struct DetailQuery {
    conn: String,
    rel: String,
}

/// Lazy-loads one record's full detail (preview / fields / raw). The list
/// renders empty detail placeholders; the client fetches this on selection, so
/// the page — and every live re-render — stays light instead of carrying every
/// record's full body and raw JSON up front.
async fn detail_fragment(
    State(state): State<AppState>,
    Query(query): Query<DetailQuery>,
) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let loaded = tokio::task::spawn_blocking(move || workspace::load(&workspace_dir)).await;
    let markup = match loaded {
        Ok(Ok(view)) => {
            let media_index = build_media_index(&view);
            match view.changes.iter().find(|change| {
                change.connection_dir_name == query.conn && change.rel_path() == query.rel
            }) {
                Some(change) => detail_pane(change, &view.templates, &media_index),
                None => html! { div.dp-empty { "Record not found." } },
            }
        }
        Ok(Err(err)) => html! { div.dp-empty { "⚠ " (err.to_string()) } },
        Err(err) => html! { div.dp-empty { "⚠ " (err.to_string()) } },
    };
    Html(markup.into_string())
}

/// The in-app template studio overlay (read the files fresh each time).
async fn templates_fragment(State(state): State<AppState>) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let markup = tokio::task::spawn_blocking(move || match workspace::load(&workspace_dir) {
        Ok(view) => templates_overlay(&view, &workspace_dir, None),
        Err(err) => html! { div.tmpl-modal { div.dp-empty { "⚠ " (err.to_string()) } } },
    })
    .await
    .unwrap_or_else(|err| html! { div.tmpl-modal { div.dp-empty { (err.to_string()) } } });
    Html(markup.into_string())
}

#[derive(Deserialize)]
struct TemplateSaveRequest {
    filename: String,
    content: String,
}

/// A pending edit that failed validation — carried back so the editor keeps the
/// user's text and shows why, instead of silently reverting to the file.
struct TemplateEdit {
    filename: String,
    content: String,
    error: String,
}

async fn template_save(
    State(state): State<AppState>,
    Form(request): Form<TemplateSaveRequest>,
) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let markup = tokio::task::spawn_blocking(move || {
        let save_error =
            cards::save_template(&workspace_dir, &request.filename, &request.content).err();
        let pending_edit = save_error.map(|error| TemplateEdit {
            filename: request.filename.clone(),
            content: request.content.clone(),
            error,
        });
        match workspace::load(&workspace_dir) {
            Ok(view) => templates_overlay(&view, &workspace_dir, pending_edit.as_ref()),
            Err(err) => html! { div.tmpl-modal { div.dp-empty { "⚠ " (err.to_string()) } } },
        }
    })
    .await
    .unwrap_or_else(|err| html! { div.tmpl-modal { div.dp-empty { (err.to_string()) } } });
    Html(markup.into_string())
}

/// A short description of what a template targets and how many records it hits.
fn template_match_label(template: &cards::CardTemplate, view: &WorkspaceView) -> String {
    let count = view
        .changes
        .iter()
        .filter(|record| template.matches(&record.service, &record.folder))
        .count();
    let scope = match &template.matcher {
        Some(matcher) => {
            let service = matcher.service.as_deref().unwrap_or("any service");
            match &matcher.folder {
                Some(folder) => format!("{service} / {folder}"),
                None => service.to_string(),
            }
        }
        None => "any record".to_string(),
    };
    format!("{scope} · {count} records")
}

/// One template's editor: its JSON on the left, a live sample (the row + the
/// near-published card it produces) on the right.
fn template_panel(
    view: &WorkspaceView,
    source: &cards::TemplateSource,
    media_index: &HashMap<&str, &str>,
    pending_edit: Option<&TemplateEdit>,
) -> Markup {
    let pending = pending_edit.filter(|edit| edit.filename == source.filename);
    let content = pending.map_or(source.raw.as_str(), |edit| edit.content.as_str());
    let error = pending
        .map(|edit| edit.error.as_str())
        .or(source.error.as_deref());
    // Parse what's *shown* (so a still-valid pending edit previews too).
    let parsed = serde_json::from_str::<cards::CardTemplate>(content).ok();

    html! {
        div.tmpl-card {
            div.tmpl-card-head {
                span.tmpl-file { (source.filename) }
                @if let Some(template) = &parsed {
                    span.tmpl-arch { (template.archetype) }
                    span.tmpl-match { (template_match_label(template, view)) }
                }
            }
            div.tmpl-cols {
                form.tmpl-form hx-post="/api/templates/save" hx-target="#tmpl-overlay" hx-swap="innerHTML" {
                    input type="hidden" name="filename" value=(source.filename);
                    textarea.tmpl-json name="content" spellcheck="false" autocomplete="off" autocapitalize="off" { (content) }
                    div.tmpl-formbar {
                        button.tmpl-save type="submit" { "Save & apply" }
                        @if let Some(message) = error {
                            span.tmpl-err { "⚠ " (message) }
                        } @else {
                            span.tmpl-ok { "saved templates apply live" }
                        }
                    }
                }
                div.tmpl-sample {
                    div.tmpl-sample-label { "Live sample" }
                    @if let Some(template) = &parsed {
                        @let single = std::slice::from_ref(template);
                        @if let Some(sample) = view.changes.iter().find(|record| template.matches(&record.service, &record.folder)) {
                            div.tmpl-feed { (feed_card(sample, single, media_index)) }
                            @if let Some(card) = content_preview(sample, single, media_index) {
                                (card)
                            } @else {
                                div.tmpl-sample-empty { "This archetype renders no card preview." }
                            }
                        } @else {
                            div.tmpl-sample-empty { "No records in this workspace match this template." }
                        }
                    } @else {
                        div.tmpl-sample-empty { "Fix the JSON to see the sample." }
                    }
                }
            }
        }
    }
}

/// The template-studio modal: every template, editable, with a live sample each.
fn templates_overlay(
    view: &WorkspaceView,
    workspace_dir: &std::path::Path,
    pending_edit: Option<&TemplateEdit>,
) -> Markup {
    let sources = cards::load_template_sources(workspace_dir);
    let media_index = build_media_index(view);
    html! {
        div.tmpl-modal {
            div.tmpl-head {
                div.tmpl-head-text {
                    h2 { "View templates" }
                    div.tmpl-sub {
                        "Each file decides how a service renders — as a list row and a near-published card. "
                        "Edit the JSON, hit save, and it applies live across the workspace. Claude can write these too."
                    }
                }
                button.tmpl-close type="button" title="Close (Esc)" { "✕" }
            }
            div.tmpl-list {
                @if sources.is_empty() {
                    div.dp-empty { "No templates in .scratch/rad/cards/ yet." }
                }
                @for source in &sources {
                    (template_panel(view, source, &media_index, pending_edit))
                }
            }
        }
    }
}

/// Server-sent events: emits `refresh` whenever the workspace changes on disk.
async fn events_stream(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let mut receiver = state.events.subscribe();
    let stream = async_stream::stream! {
        while let Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) = receiver.recv().await {
            yield Ok(SseEvent::default().data("refresh"));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
struct ReviewRequest {
    action: String,
    connection: String,
    path: String,
}

fn review_vals(action: &str, connection: &str, path: &str) -> String {
    serde_json::json!({ "action": action, "connection": connection, "path": path }).to_string()
}

fn bulk_vals(action: &str, connection: &str) -> String {
    serde_json::json!({ "action": action, "connection": connection }).to_string()
}

async fn review_action(
    State(state): State<AppState>,
    Form(request): Form<ReviewRequest>,
) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let result =
        tokio::task::spawn_blocking(move || -> anyhow::Result<(WorkspaceView, Option<String>)> {
            let error = match review::ReviewAction::parse(&request.action) {
                None => Some(format!("unknown action: {}", request.action)),
                Some(action) => {
                    match review::apply(&workspace_dir, &request.connection, &request.path, action)
                    {
                        Ok(()) => None,
                        Err(err) => Some(err.to_string()),
                    }
                }
            };
            let view = workspace::load(&workspace_dir)?;
            Ok((view, error))
        })
        .await;

    let markup = match result {
        Ok(Ok((view, error))) => console_response(&view, error.as_deref()),
        Ok(Err(err)) => html! { div.banner-error { "⚠ " (err.to_string()) } },
        Err(err) => html! { div.banner-error { "⚠ review task failed: " (err.to_string()) } },
    };
    Html(markup.into_string())
}

#[derive(Deserialize)]
struct BulkRequest {
    action: String,
    connection: String,
    #[serde(default)]
    folder: Option<String>,
}

/// Applies an action to every changed record in a connection (optionally scoped
/// to one folder) — the "accept all / reject all" group buttons.
async fn review_bulk(
    State(state): State<AppState>,
    Form(request): Form<BulkRequest>,
) -> Html<String> {
    let workspace_dir = state.workspace_dir.clone();
    let result =
        tokio::task::spawn_blocking(move || -> anyhow::Result<(WorkspaceView, Option<String>)> {
            let Some(action) = review::ReviewAction::parse(&request.action) else {
                let view = workspace::load(&workspace_dir)?;
                return Ok((view, Some(format!("unknown action: {}", request.action))));
            };
            let view = workspace::load(&workspace_dir)?;
            let targets: Vec<(String, String)> = view
                .changes
                .iter()
                .filter(|change| {
                    change.connection_dir_name == request.connection
                        && request
                            .folder
                            .as_deref()
                            .is_none_or(|folder| change.folder == folder)
                })
                .map(|change| (change.connection_dir_name.clone(), change.rel_path()))
                .collect();
            let mut failures = 0;
            for (connection, path) in &targets {
                if review::apply(&workspace_dir, connection, path, action).is_err() {
                    failures += 1;
                }
            }
            let refreshed = workspace::load(&workspace_dir)?;
            let note = (failures > 0)
                .then(|| format!("{failures} of {} could not be applied", targets.len()));
            Ok((refreshed, note))
        })
        .await;

    let markup = match result {
        Ok(Ok((view, error))) => console_response(&view, error.as_deref()),
        Ok(Err(err)) => html! { div.banner-error { "⚠ " (err.to_string()) } },
        Err(err) => html! { div.banner-error { "⚠ bulk task failed: " (err.to_string()) } },
    };
    Html(markup.into_string())
}

// ---------------------------------------------------------------------------
// Diff rendering primitives
// ---------------------------------------------------------------------------

fn service_class(service: &str) -> &'static str {
    match service.to_ascii_uppercase().as_str() {
        "SHOPIFY" => "svc-shopify",
        "WORDPRESS" => "svc-wordpress",
        "WEBFLOW" => "svc-webflow",
        "AIRTABLE" => "svc-airtable",
        "YOUTUBE" => "svc-youtube",
        "NOTION" => "svc-notion",
        _ => "svc-default",
    }
}

fn inline_char_diff(old: &str, new: &str) -> Markup {
    let diff = similar::TextDiff::from_chars(old, new);
    html! {
        span.diff {
            @for change in diff.iter_all_changes() {
                @match change.tag() {
                    similar::ChangeTag::Delete => span.del { (change.value()) },
                    similar::ChangeTag::Insert => span.ins { (change.value()) },
                    similar::ChangeTag::Equal => span.eq { (change.value()) },
                }
            }
        }
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn is_long_field(field: &FieldChange) -> bool {
    let published_len = field.published_value.as_deref().map_or(0, str::len);
    let working_len = field.working_value.as_deref().map_or(0, str::len);
    published_len.max(working_len) > LONG_FIELD_LEN
}

fn field_transition(field: &FieldChange) -> Markup {
    match (
        field.published_value.as_deref(),
        field.working_value.as_deref(),
    ) {
        (Some(published), Some(working)) => {
            if published.len() <= CHAR_DIFF_MAX_LEN && working.len() <= CHAR_DIFF_MAX_LEN {
                inline_char_diff(published, working)
            } else {
                html! {
                    span.large { (truncate(published, 90)) }
                    span.arrow { "→" }
                    span.large.ins { (truncate(working, 90)) }
                    span.note { "large field" }
                }
            }
        }
        (None, Some(working)) => {
            html! { span.tag-added { "added" } span.ins { (truncate(working, 200)) } }
        }
        (Some(published), None) => {
            html! { span.tag-removed { "removed" } span.del { (truncate(published, 200)) } }
        }
        (None, None) => html! {},
    }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

fn total_changed_fields(change: &RecordChange) -> usize {
    change.fields.len() + change.hidden_field_count
}

fn state_count(view: &WorkspaceView, state: ChangeState) -> usize {
    view.changes.iter().filter(|c| c.state == state).count()
}

fn status_counts(view: &WorkspaceView) -> Markup {
    html! {
        span.stat.s-unreviewed { (state_count(view, ChangeState::Unreviewed)) " unreviewed" }
        span.stat.s-unpublished { (state_count(view, ChangeState::Unpublished)) " unpublished" }
        span.live { span.live-dot {} "LIVE" }
    }
}

/// Changes grouped by connection dir name, each keeping the change's global
/// index so the detail panes still line up.
type ChangesByConnection<'a> = HashMap<&'a str, Vec<(usize, &'a RecordChange)>>;

/// Folder-scoped row groups in the List: a `(service, folder, connection)` key
/// and the rows under it.
type FolderGroups<'a> = Vec<((&'a str, &'a str, &'a str), Vec<&'a RecordChange>)>;

/// Groups changes by connection (first-seen order), keeping each change's
/// global index so the detail panes still line up.
fn group_changes(view: &WorkspaceView) -> (Vec<&str>, ChangesByConnection<'_>) {
    let mut order: Vec<&str> = Vec::new();
    let mut groups: ChangesByConnection = HashMap::new();
    for (index, change) in view.changes.iter().enumerate() {
        let key = change.connection_dir_name.as_str();
        if !groups.contains_key(key) {
            order.push(key);
        }
        groups.entry(key).or_default().push((index, change));
    }
    (order, groups)
}

/// Folders within a connection's changes, in first-seen order, with counts.
fn folders_in_order<'a>(rows: &[(usize, &'a RecordChange)]) -> Vec<(&'a str, usize)> {
    let mut order: Vec<&str> = Vec::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (_, change) in rows {
        let folder = change.folder.as_str();
        if !counts.contains_key(folder) {
            order.push(folder);
        }
        *counts.entry(folder).or_default() += 1;
    }
    order
        .into_iter()
        .map(|folder| (folder, counts[folder]))
        .collect()
}

/// A node in the folder tree built from slash-separated folder paths, so the
/// rail nests `Scratch Demo/Authors` under `Scratch Demo` instead of showing
/// flat, repeated path prefixes.
struct FolderNode {
    segment: String,
    full_path: String,
    direct_count: usize,
    children: std::collections::BTreeMap<String, FolderNode>,
}

impl FolderNode {
    /// Records directly in this folder plus everything beneath it.
    fn total(&self) -> usize {
        self.direct_count + self.children.values().map(FolderNode::total).sum::<usize>()
    }
}

/// Builds a nested folder tree from `(folder_path, record_count)` pairs.
fn build_folder_tree(folders: &[(&str, usize)]) -> std::collections::BTreeMap<String, FolderNode> {
    let mut roots: std::collections::BTreeMap<String, FolderNode> =
        std::collections::BTreeMap::new();
    for &(folder, count) in folders {
        let segments: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
        let mut level = &mut roots;
        let mut path = String::new();
        for (index, segment) in segments.iter().enumerate() {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(segment);
            let node = level
                .entry((*segment).to_string())
                .or_insert_with(|| FolderNode {
                    segment: (*segment).to_string(),
                    full_path: path.clone(),
                    direct_count: 0,
                    children: std::collections::BTreeMap::new(),
                });
            if index == segments.len() - 1 {
                node.direct_count += count;
            }
            level = &mut node.children;
        }
    }
    roots
}

fn flatten_folder_tree<'a>(
    nodes: &'a std::collections::BTreeMap<String, FolderNode>,
    depth: usize,
    out: &mut Vec<(usize, &'a FolderNode)>,
) {
    for node in nodes.values() {
        out.push((depth, node));
        flatten_folder_tree(&node.children, depth + 1, out);
    }
}

/// Renders a connection's folders as an indented tree of scope nodes. A parent
/// folder scopes (by prefix) to everything beneath it; a leaf scopes to itself.
fn folder_rail_nodes(connection_dir: &str, rows: &[(usize, &RecordChange)]) -> Markup {
    let folders = folders_in_order(rows);
    let tree = build_folder_tree(&folders);
    let mut flat: Vec<(usize, &FolderNode)> = Vec::new();
    flatten_folder_tree(&tree, 0, &mut flat);
    html! {
        @for (depth, node) in &flat {
            div.rail-node.folder.(if node.children.is_empty() { "leaf" } else { "parent" })
                data-conn=(connection_dir)
                data-folder=(node.full_path)
                style=(format!("padding-left:{}px", 26 + depth * 13))
            {
                span.rn-label { (node.segment) }
                span.rn-count { (node.total()) }
            }
        }
    }
}

/// The navigable rail: All changes → each connection → its folders, each a
/// clickable scope filter.
fn rail_tree(view: &WorkspaceView) -> Markup {
    let (order, groups) = group_changes(view);
    html! {
        div.rail-head { "Navigate" }
        div.rail-node.scope-all.active data-conn="" data-folder="" {
            span.rn-label { "All records" }
            span.rn-count { (view.changes.len()) }
        }
        @for connection_dir in &order {
            @let conn = *connection_dir;
            @let rows = &groups[conn];
            @let first = rows[0].1;
            div.rail-node.conn data-conn=(conn) data-folder="" {
                span.svc-dot.(service_class(&first.service)) {}
                span.rn-label { (first.connection_display_name) }
                span.rn-count { (rows.len()) }
            }
            (folder_rail_nodes(conn, rows))
        }
    }
}

fn console_inner(view: &WorkspaceView) -> Markup {
    html! {
        aside.rail { (rail_tree(view)) }
        section #workspace.workspace { (workspace_body(view)) }
    }
}

fn cockpit_page(view: &WorkspaceView) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { "Rad — " (view.workspace_name) }
                link rel="preconnect" href="https://fonts.googleapis.com";
                link rel="preconnect" href="https://fonts.gstatic.com" crossorigin;
                link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500;600&display=swap";
                script src="https://unpkg.com/htmx.org@2.0.4" {}
                style { (PreEscaped(STYLES)) }
            }
            body {
                header.cmdbar {
                    div.brand {
                        div.mark { div.mark-core {} }
                        span.name { "RAD" }
                        span.ws { (view.workspace_name) }
                    }
                    div.search {
                        span.search-icon { "⌕" }
                        input #cmd type="search" placeholder="Search records, fields, connections…" autocomplete="off";
                        span.kbd { "⌘K" }
                    }
                    div.bar-right {
                        div.seg #seg-scope {
                            button.seg-btn.active type="button" data-showall="0" { "Changed" }
                            button.seg-btn type="button" data-showall="1" { "All" }
                        }
                        div.seg #seg-mode {
                            button.seg-btn.active type="button" data-view="review" { "Review" }
                            button.seg-btn type="button" data-view="patterns" { "List" }
                        }
                        button.tmpl-open type="button"
                            hx-get="/api/templates" hx-target="#tmpl-overlay" hx-swap="innerHTML"
                            title="See & edit the card templates that decide how every record renders" {
                            "✦ Templates"
                        }
                        div.status #status-bar {
                            (status_counts(view))
                        }
                    }
                }
                main.console #console {
                    (console_inner(view))
                }
                footer.keys {
                    span.khint { span.kc { "↑↓" } " navigate" }
                    span.khint { span.kc { "A" } " accept" }
                    span.khint { span.kc { "R" } " reject" }
                    span.khint { span.kc { "D" } " discard" }
                    span.khint { span.kc { "space" } " reveal edits" }
                    span.khint { span.kc { "n/p" } " change" }
                    span.khint { span.kc { "/" } " search" }
                    span.khint { span.kc { "⌘K" } " command" }
                }
                div #minimap.minimap hidden {}
                div #tmpl-overlay {}
                script { (PreEscaped(KEYBOARD_JS)) }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// List view — one file per row, grouped by folder, rendered by its template
// ---------------------------------------------------------------------------

/// Strips tags + collapses whitespace into a short plain-text snippet.
fn text_excerpt(value: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, max_chars)
}

/// One record rendered as a compact, self-contained card-row in its own
/// archetype shape (video / product / article / generic). Rows of the same
/// service look alike because they share a template, not because of columns.
fn feed_card(
    record: &RecordChange,
    templates: &[cards::CardTemplate],
    media_index: &HashMap<&str, &str>,
) -> Markup {
    let template = cards::match_template(templates, &record.service, &record.folder);
    let archetype = template.map(|t| t.archetype.as_str()).unwrap_or("generic");

    let image_url: Option<String> = template
        .and_then(|t| resolve_slot(record, t.slots.get("image")))
        .and_then(|(_, value)| {
            if value.starts_with("http") {
                Some(value.to_string())
            } else if value.starts_with("gid://") {
                media_index.get(value).map(|u| u.to_string())
            } else {
                None
            }
        });
    let title = template.and_then(|t| resolve_slot(record, t.slots.get("title")));
    let badge = template.and_then(|t| resolve_slot(record, t.slots.get("badge")));
    let body = template.and_then(|t| resolve_slot(record, t.slots.get("body")));
    let snippet = body
        .map(|(_, value)| text_excerpt(value, 200))
        .filter(|s| !s.is_empty());

    // Same-folder rows share a template, so they render the same data columns in
    // the same fixed widths — that's what makes like items line up vertically. An
    // empty value still holds its column, so the alignment never breaks.
    let columns: &[cards::RowColumn] = template.map_or(&[], |t| t.columns.as_slice());
    let has_body = template.is_some_and(|t| t.slots.contains_key("body"));

    html! {
        div.feed-card.lrow.grow
            data-connection=(record.connection_dir_name)
            data-folder=(record.folder)
            data-path=(record.rel_path())
            data-changed=(if record.state.is_changed() { "1" } else { "0" })
            data-state=(record.state.css_class())
            data-search=(build_search_blob(record))
        {
            @match archetype {
                "video" => div.lr-thumb.vid {
                    @if let Some(src) = &image_url { img src=(src) alt="" loading="lazy"; }
                    @if let Some((_, duration)) = badge { span.lr-dur { (format_video_duration(duration)) } }
                },
                _ => div.lr-thumb.sq {
                    @if let Some(src) = &image_url {
                        img src=(src) alt="" loading="lazy";
                    } @else {
                        span.r-mono { (monogram(&record.display_title)) }
                    }
                },
            }
            div.lr-title { (card_title(record, title)) }
            @if has_body {
                div.lr-snip {
                    @if let Some(snippet) = &snippet { (snippet) }
                }
            }
            @for column in columns {
                @let resolved = column.fields.iter().find_map(|field| {
                    record
                        .working_record
                        .as_ref()
                        .and_then(|record_json| nested_str(record_json, field))
                        .map(|value| (field.as_str(), value))
                });
                div.lr-col style=(format!("width:{}px", column.width.unwrap_or(110))) {
                    @if let Some((field_path, value)) = resolved {
                        (card_field(record, field_path, value, false))
                    }
                }
            }
            div.lr-state {
                @if record.state.is_changed() {
                    span.chip.(record.state.css_class()) { (record.state.label()) }
                }
            }
        }
    }
}

/// The List: a feed of records, each rendered as its own archetype card-row.
/// Filtered by the Changed/All toggle, scope and search on the client.
fn patterns_view(view: &WorkspaceView) -> Markup {
    let mut rows: Vec<&RecordChange> = view.changes.iter().collect();
    rows.sort_by(|a, b| {
        (
            a.service.as_str(),
            a.folder.as_str(),
            a.display_title.as_str(),
        )
            .cmp(&(
                b.service.as_str(),
                b.folder.as_str(),
                b.display_title.as_str(),
            ))
    });
    let media_index = build_media_index(view);
    let changed_count = rows.iter().filter(|r| r.state.is_changed()).count();

    // Group consecutive rows by folder. Within a group every row shares a
    // template, so the field columns line up; different folders are separated by
    // a header and don't have to align with each other.
    let mut groups: FolderGroups = Vec::new();
    for &record in &rows {
        let key = (
            record.service.as_str(),
            record.folder.as_str(),
            record.connection_display_name.as_str(),
        );
        match groups.last_mut() {
            Some(last) if last.0 == key => last.1.push(record),
            _ => groups.push((key, vec![record])),
        }
    }

    html! {
        div.patterns {
            div.patterns-head {
                span.ph-title { "List" }
                span.ph-sub {
                    span #grid-count { (changed_count) }
                    " shown — one file, one row · flip to All to browse everything"
                }
            }
            @if rows.is_empty() {
                div.empty { div.empty-title { "Empty" } div.empty-sub { "Nothing here yet." } }
            } @else {
                div.feed {
                    @for (key, group_rows) in &groups {
                        div.fgroup {
                            div.fgroup-head {
                                span.svc-dot.(service_class(key.0)) {}
                                span.fgh-conn { (key.2) }
                                span.lr-sep { "/" }
                                span { (key.1) }
                                span.fgh-count { (group_rows.len()) }
                            }
                            @for record in group_rows {
                                (feed_card(record, &view.templates, &media_index))
                            }
                        }
                    }
                }
            }
        }
    }
}

fn workspace_body(view: &WorkspaceView) -> Markup {
    if view.changes.is_empty() {
        return html! {
            div.empty {
                div.empty-title { "All clear" }
                div.empty-sub { "Read-only until you publish — nothing's gone anywhere. Edit a record and it streams in." }
            }
        };
    }
    let (order, groups) = group_changes(view);
    html! {
        div.wsgrid {
            div.list {
                div.list-body {
                    div.no-results hidden { "No matches." }
                    @for connection_dir in &order {
                        @let conn = *connection_dir;
                        @let rows = &groups[conn];
                        @let first = rows[0].1;
                        div.group data-conn=(conn) {
                            div.group-head {
                                span.svc-dot.(service_class(&first.service)) {}
                                span.group-name { (first.connection_display_name) }
                                span.group-count { (rows.len()) }
                                div.group-bulk {
                                    button.gb.accept hx-post="/api/review-bulk" hx-vals=(bulk_vals("accept", conn))
                                        hx-target="#console" hx-swap="innerHTML" title="accept every change in this service" { "✓ all" }
                                    button.gb.reject hx-post="/api/review-bulk" hx-vals=(bulk_vals("reject", conn))
                                        hx-target="#console" hx-swap="innerHTML" title="reject every change in this service" { "↩ all" }
                                    button.gb.discard hx-post="/api/review-bulk" hx-vals=(bulk_vals("discard", conn))
                                        hx-target="#console" hx-swap="innerHTML" title="discard every change in this service" { "✕ all" }
                                }
                            }
                            @for (index, change) in rows {
                                (list_row(*index, change))
                            }
                        }
                    }
                }
            }
            div.detail {
                @for (index, change) in view.changes.iter().enumerate() {
                    div.detail-pane data-idx=(index)
                        data-conn=(change.connection_dir_name)
                        data-rel=(change.rel_path())
                        hidden[index != 0] {}
                }
            }
        }
        (patterns_view(view))
    }
}

fn list_row(index: usize, change: &RecordChange) -> Markup {
    let search = build_search_blob(change);
    html! {
        div.row.(change.state.css_class()).active[index == 0]
            data-idx=(index)
            data-connection=(change.connection_dir_name)
            data-folder=(change.folder)
            data-path=(change.rel_path())
            data-changed=(if change.state.is_changed() { "1" } else { "0" })
            data-state=(change.state.css_class())
            data-search=(search)
        {
            span.glyph.(change.state.css_class()) {}
            div.row-main {
                div.row-title { (change.display_title) }
                div.row-sub { span.row-folder { (change.folder) } }
            }
            span.row-delta { (total_changed_fields(change)) }
        }
    }
}

/// A lowercased haystack of everything searchable about a record — its title,
/// connection, folder, and changed field names/values — stashed on the row for
/// instant client-side filtering.
fn build_search_blob(change: &RecordChange) -> String {
    let mut blob = format!(
        "{} {} {}",
        change.display_title, change.connection_display_name, change.folder
    );
    for field in &change.fields {
        blob.push(' ');
        blob.push_str(&field.field);
        if let Some(value) = &field.working_value {
            blob.push(' ');
            blob.push_str(&truncate(value, 100));
        }
        if let Some(value) = &field.published_value {
            blob.push(' ');
            blob.push_str(&truncate(value, 100));
        }
    }
    blob.to_lowercase()
}

/// Drills into a record by a dotted path (`content.rendered`) and returns the
/// leaf string if present.
fn nested_str<'a>(record: &'a serde_json::Value, dotted: &str) -> Option<&'a str> {
    let mut current = record;
    for key in dotted.split('.') {
        current = current.get(key)?;
    }
    current.as_str()
}

/// The first of a slot's candidate field-paths that resolves to a non-empty
/// value on this record. Returns `(field_path, value)`.
fn resolve_slot<'a>(
    record: &'a RecordChange,
    paths: Option<&'a Vec<String>>,
) -> Option<(&'a str, &'a str)> {
    let working = record.working_record.as_ref()?;
    for path in paths? {
        if let Some(value) = nested_str(working, path) {
            if !value.trim().is_empty() {
                return Some((path.as_str(), value));
            }
        }
    }
    None
}

/// Splits HTML into diff tokens: each tag is one atomic token, and text is split
/// into word / whitespace tokens. Scans only on `<`, `>` and ASCII whitespace —
/// all single-byte — so slicing stays on UTF-8 boundaries.
fn html_diff_tokens(source: &str) -> Vec<&str> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'>' {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            tokens.push(&source[start..i]);
        } else {
            let run_start = i;
            while i < bytes.len() && bytes[i] != b'<' {
                i += 1;
            }
            let run = &source[run_start..i];
            let run_bytes = run.as_bytes();
            let mut p = 0;
            while p < run_bytes.len() {
                let is_whitespace = run_bytes[p].is_ascii_whitespace();
                let segment_start = p;
                while p < run_bytes.len() && run_bytes[p].is_ascii_whitespace() == is_whitespace {
                    p += 1;
                }
                tokens.push(&run[segment_start..p]);
            }
        }
    }
    tokens
}

/// Escapes a string for safe use inside a double-quoted HTML attribute.
fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Splits plain text into word / whitespace tokens (no tag handling).
fn word_tokens(source: &str) -> Vec<&str> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut p = 0;
    while p < bytes.len() {
        let is_whitespace = bytes[p].is_ascii_whitespace();
        let start = p;
        while p < bytes.len() && bytes[p].is_ascii_whitespace() == is_whitespace {
            p += 1;
        }
        tokens.push(&source[start..p]);
    }
    tokens
}

/// Pushes a token into the output, escaping it for plain-text fields (HTML
/// fields are already markup and must pass through raw).
fn push_diff_token(out: &mut String, token: &str, is_html: bool) {
    if is_html {
        out.push_str(token);
    } else {
        out.push_str(&escape_attr(token));
    }
}

/// Renders ANY changed field — plain text or HTML — with inserted / changed
/// text wrapped in a `<mark class="ins" data-before="…">`, so the same
/// clean-by-default / reveal / hover-before pattern applies everywhere in the
/// preview. For HTML, tags are atomic and pass through untouched; for plain
/// text, every token is escaped.
fn render_field_diff(published: &str, working: &str, is_html: bool) -> Markup {
    let published_tokens = if is_html {
        html_diff_tokens(published)
    } else {
        word_tokens(published)
    };
    let working_tokens = if is_html {
        html_diff_tokens(working)
    } else {
        word_tokens(working)
    };
    let diff = similar::TextDiff::from_slices(&published_tokens, &working_tokens);
    let mut out = String::new();
    // Deletes precede their replacement inserts, so this holds the text removed
    // just before the current insert run — i.e. its "before".
    let mut removed_before_insert = String::new();
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Delete => removed_before_insert.push_str(change.value()),
            similar::ChangeTag::Equal => {
                removed_before_insert.clear();
                push_diff_token(&mut out, change.value(), is_html);
            }
            similar::ChangeTag::Insert => {
                let token = change.value();
                if (is_html && token.starts_with('<')) || token.trim().is_empty() {
                    push_diff_token(&mut out, token, is_html);
                    continue;
                }
                let before = escape_attr(&text_excerpt(&removed_before_insert, 240));
                if before.is_empty() {
                    out.push_str("<mark class=\"ins\">");
                } else {
                    out.push_str("<mark class=\"ins\" data-before=\"");
                    out.push_str(&before);
                    out.push_str("\">");
                }
                push_diff_token(&mut out, token, is_html);
                out.push_str("</mark>");
            }
        }
    }
    PreEscaped(out)
}

/// Renders a slot value, word-diffed (highlighter-yellow marker) if its field
/// was edited, otherwise plain. `allow_html` lets a body slot render real markup.
fn card_field(record: &RecordChange, field_path: &str, value: &str, allow_html: bool) -> Markup {
    if let Some(change) = record.fields.iter().find(|f| f.field == field_path) {
        let published = change.published_value.as_deref();
        let working = change.working_value.as_deref();
        return match (published, working) {
            (Some(p), Some(w)) => render_field_diff(p, w, allow_html && w.contains('<')),
            (None, Some(w)) if allow_html && w.contains('<') => {
                html! { (PreEscaped(w.to_string())) }
            }
            (None, Some(w)) => html! { mark.ins { (w) } },
            (Some(p), None) => html! { span.del { (p) } },
            (None, None) => html! {},
        };
    }
    if allow_html && value.contains('<') {
        html! { (PreEscaped(value.to_string())) }
    } else {
        html! { (value) }
    }
}

fn slot_markup(record: &RecordChange, slot: Option<(&str, &str)>, allow_html: bool) -> Markup {
    match slot {
        Some((field_path, value)) => card_field(record, field_path, value, allow_html),
        None => html! {},
    }
}

fn card_title(record: &RecordChange, slot: Option<(&str, &str)>) -> Markup {
    match slot {
        Some((field_path, value)) => card_field(record, field_path, value, false),
        None => html! { (record.display_title) },
    }
}

/// Turns an ISO-8601 video duration (`PT8M53S`) into `8:53` / `1:02:03`.
fn format_video_duration(value: &str) -> String {
    let Some(rest) = value.strip_prefix("PT") else {
        return value.to_string();
    };
    let (mut hours, mut minutes, mut seconds) = (0u64, 0u64, 0u64);
    let mut number = String::new();
    for ch in rest.chars() {
        if ch.is_ascii_digit() {
            number.push(ch);
            continue;
        }
        let value = number.parse().unwrap_or(0);
        number.clear();
        match ch {
            'H' => hours = value,
            'M' => minutes = value,
            'S' => seconds = value,
            _ => {}
        }
    }
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

fn monogram(title: &str) -> String {
    title
        .chars()
        .find(|c| c.is_alphanumeric())
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_else(|| "·".to_string())
}

/// Indexes every record carrying a gid `id` and an image URL, so a card can
/// resolve a `featuredMedia` reference (a gid) to the actual image — the
/// files-based equivalent of a foreign-key lookup, no external fetch.
fn build_media_index(view: &WorkspaceView) -> HashMap<&str, &str> {
    let mut index = HashMap::new();
    for change in &view.changes {
        if let Some(value) = &change.working_record {
            let Some(id) = value.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            if !id.starts_with("gid://") {
                continue;
            }
            let url = ["image.url", "originalSource.url", "image.src", "url"]
                .iter()
                .find_map(|path| nested_str(value, path))
                .filter(|u| u.starts_with("http"));
            if let Some(url) = url {
                index.insert(id, url);
            }
        }
    }
    index
}

/// Builds the near-published preview card via the record's matched template
/// archetype (product / video / article / generic), with edits highlighted in
/// place. Returns None when there's nothing renderable.
fn content_preview(
    record: &RecordChange,
    templates: &[cards::CardTemplate],
    media_index: &HashMap<&str, &str>,
) -> Option<Markup> {
    record.working_record.as_ref()?;
    let template = cards::match_template(templates, &record.service, &record.folder)?;

    // Resolve the image slot to a URL: direct http, or a gid looked up in the
    // workspace's media records.
    let image_url: Option<String> =
        resolve_slot(record, template.slots.get("image")).and_then(|(_, value)| {
            if value.starts_with("http") {
                Some(value.to_string())
            } else if value.starts_with("gid://") {
                media_index.get(value).map(|u| u.to_string())
            } else {
                None
            }
        });
    let title = resolve_slot(record, template.slots.get("title"));
    let subtitle = resolve_slot(record, template.slots.get("subtitle"));
    let price = resolve_slot(record, template.slots.get("price"));
    let body = resolve_slot(record, template.slots.get("body"));
    let badge = resolve_slot(record, template.slots.get("badge"));

    if title.is_none() && body.is_none() && image_url.is_none() {
        return None;
    }

    let inner = match template.archetype.as_str() {
        "video" => html! {
            @if let Some(src) = &image_url {
                div.vid-thumb {
                    img src=(src) alt="" loading="lazy";
                    @if let Some((_, duration)) = badge { span.vid-dur { (format_video_duration(duration)) } }
                }
            }
            div.pv-title.vid-title { (card_title(record, title)) }
            @if subtitle.is_some() { div.vid-channel { (slot_markup(record, subtitle, false)) } }
            @if body.is_some() { div.pv-body.vid-desc { (slot_markup(record, body, true)) } }
        },
        "product" => html! {
            div.prod {
                @if let Some(src) = &image_url {
                    div.prod-img { img src=(src) alt="" loading="lazy"; }
                } @else {
                    div.prod-img.prod-noimg { (monogram(&record.display_title)) }
                }
                div.prod-info {
                    div.prod-top {
                        div.pv-title.prod-title { (card_title(record, title)) }
                        @if let Some((bf, bv)) = badge { span.prod-badge { (card_field(record, bf, bv, false)) } }
                    }
                    @if subtitle.is_some() || price.is_some() {
                        div.prod-meta {
                            @if subtitle.is_some() { span.prod-type { (slot_markup(record, subtitle, false)) } }
                            @if let Some((pf, pv)) = price { span.prod-price { "$" (card_field(record, pf, pv, false)) } }
                        }
                    }
                    @if body.is_some() { div.pv-body.prod-desc { (slot_markup(record, body, true)) } }
                }
            }
        },
        "article" => html! {
            @if let Some(src) = &image_url { img.art-hero src=(src) alt="" loading="lazy"; }
            div.pv-title { (card_title(record, title)) }
            @if body.is_some() { div.pv-body { (slot_markup(record, body, true)) } }
        },
        _ => html! {
            div.pv-title { (card_title(record, title)) }
            @if body.is_some() { div.pv-body { (slot_markup(record, body, true)) } }
        },
    };

    Some(html! {
        div.pv-frame.(format!("card-{}", template.archetype)) { (inner) }
    })
}

/// Flattens a record into an ordered `(dotted_path, value)` list of every leaf
/// field, so the detail pane can show the entire file — not just what changed.
fn flatten_record_fields(value: &serde_json::Value, prefix: &str, out: &mut Vec<(String, String)>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_record_fields(child, &path, out);
            }
        }
        serde_json::Value::Array(items) => {
            if items.is_empty() {
                out.push((prefix.to_string(), "[]".to_string()));
            } else {
                for (index, child) in items.iter().enumerate() {
                    flatten_record_fields(child, &format!("{prefix}[{index}]"), out);
                }
            }
        }
        serde_json::Value::String(text) => out.push((prefix.to_string(), text.clone())),
        serde_json::Value::Null => out.push((prefix.to_string(), "null".to_string())),
        other => out.push((prefix.to_string(), other.to_string())),
    }
}

fn detail_pane(
    change: &RecordChange,
    templates: &[cards::CardTemplate],
    media_index: &HashMap<&str, &str>,
) -> Markup {
    let connection = change.connection_dir_name.clone();
    let path = change.rel_path();
    let preview = content_preview(change, templates, media_index);
    let changed_fields: HashMap<&str, &FieldChange> = change
        .fields
        .iter()
        .map(|f| (f.field.as_str(), f))
        .collect();
    let mut all_fields: Vec<(String, String)> = Vec::new();
    if let Some(working_record) = change.working_record.as_ref() {
        flatten_record_fields(working_record, "", &mut all_fields);
    }
    // Changed fields first, so review stays easy even in the full-file view.
    all_fields.sort_by_key(|(field_path, _)| !changed_fields.contains_key(field_path.as_str()));
    let raw_json = change
        .working_record
        .as_ref()
        .and_then(|working_record| serde_json::to_string_pretty(working_record).ok());
    html! {
        div.dp-head {
            span.svc-dot.(service_class(&change.service)) {}
            span.dp-conn { (change.connection_display_name) }
            span.dp-sep { "/" }
            span.dp-folder { (change.folder) }
            span.chip.(change.state.css_class()) { (change.state.label()) }
        }
        h2.dp-title { (change.display_title) }
        div.dp-path { (path) }
        div.dp-meta {
            @if change.fields.is_empty() {
                "Published record · no local changes"
            } @else {
                b { (total_changed_fields(change)) }
                @if total_changed_fields(change) == 1 { " field changed" } @else { " fields changed" }
                " · " (change.state.label())
            }
        }
        div.dp-bar {
            div.dp-viewswitch {
                button.dpv-btn.active type="button" data-dview="preview" { "Preview" }
                button.dpv-btn type="button" data-dview="fields" { "Fields " span.dpv-n { (all_fields.len()) } }
                button.dpv-btn type="button" data-dview="raw" { "Raw" }
            }
            @if change.state.is_changed() {
                div.dp-actions {
                    button.act.accept
                        hx-post="/api/review" hx-vals=(review_vals("accept", &connection, &path))
                        hx-target="#console" hx-swap="innerHTML"
                        title="Stage this edit — nothing ships until you publish" { span.kc { "A" } "ccept" }
                    button.act.reject
                        hx-post="/api/review" hx-vals=(review_vals("reject", &connection, &path))
                        hx-target="#console" hx-swap="innerHTML"
                        title="undo the unreviewed edit — restore approved" { span.kc { "R" } "eject" }
                    button.act.discard
                        hx-post="/api/review" hx-vals=(review_vals("discard", &connection, &path))
                        hx-target="#console" hx-swap="innerHTML"
                        title="Throw it away — back to what's live" { span.kc { "D" } "iscard" }
                }
            }
        }
        div.dp-view.preview {
            @if let Some(preview_markup) = preview {
                (preview_markup)
            } @else {
                div.dp-empty { "No rendered preview for this record type — see Fields or Raw." }
            }
        }
        div.dp-view.fields {
            @if all_fields.is_empty() {
                div.dp-empty { "No record data." }
            } @else {
                div.dp-fieldtable {
                    @for (field_path, value) in &all_fields {
                        @let is_changed = changed_fields.contains_key(field_path.as_str());
                        @let is_block = value.len() > 90
                            || changed_fields.get(field_path.as_str()).is_some_and(|f| is_long_field(f));
                        div.dp-frow.changed[is_changed].block[is_block].inline[!is_block] {
                            span.dp-fkey { (field_path) }
                            span.dp-fval {
                                @if let Some(field_change) = changed_fields.get(field_path.as_str()) {
                                    (field_transition(field_change))
                                } @else if value.is_empty() {
                                    span.dp-fempty { "—" }
                                } @else {
                                    (truncate(value, 600))
                                }
                            }
                        }
                    }
                }
            }
        }
        div.dp-view.raw {
            @if let Some(raw_json) = &raw_json {
                pre.dp-raw { (raw_json) }
            } @else {
                div.dp-empty { "No record data." }
            }
        }
    }
}

fn error_page(message: &str) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head { meta charset="utf-8"; title { "Rad" } style { (PreEscaped(STYLES)) } }
            body {
                main style="padding:48px;font-family:monospace" {
                    h1 style="color:#ff7d8a" { "Rad couldn't start" }
                    pre style="color:#e6e8ee;white-space:pre-wrap" { (message) }
                }
            }
        }
    }
}

const KEYBOARD_JS: &str = r#"
(function () {
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // Wires up a lazily-loaded detail pane: its Preview/Fields/Raw switch buttons,
  // reflecting the current view (held as a class on #console).
  function bindDetail(pane) {
    var consoleEl = document.getElementById('console');
    var cur = ((consoleEl && consoleEl.className.match(/dview-(\w+)/)) || [null, 'preview'])[1];
    Array.prototype.slice.call(pane.querySelectorAll('.dpv-btn')).forEach(function (b) {
      b.classList.toggle('active', b.dataset.dview === cur);
      b.addEventListener('click', function () {
        var v = b.dataset.dview;
        if (consoleEl) {
          consoleEl.classList.remove('dview-preview', 'dview-fields', 'dview-raw');
          consoleEl.classList.add('dview-' + v);
        }
        qsa('.dpv-btn').forEach(function (x) { x.classList.toggle('active', x.dataset.dview === v); });
        requestAnimationFrame(updateMinimap);
      });
    });
    tagChangedBlocks(pane);
    requestAnimationFrame(updateMinimap);
  }

  // A scroll-overview pinned to the right: a colored tick for each changed
  // record in the active list, plus a viewport box. Click anywhere to jump.
  // Flags every block containing an edit, so a margin bar can show where the
  // changes are without touching the prose.
  function tagChangedBlocks(root) {
    var marks = root.querySelectorAll('mark.ins');
    for (var i = 0; i < marks.length; i++) {
      var block = marks[i].closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,figure,pre,td');
      if (block) block.classList.add('rad-changed-block');
    }
  }
  // n / p walk edit-to-edit in the open document: scroll the change to center
  // and light only that one (.rad-focus), so the rest stay clean.
  var radChangeIndex = -1;
  function stepChange(dir) {
    var detail = document.querySelector('.detail');
    if (!detail) return;
    var marks = Array.prototype.slice.call(detail.querySelectorAll('mark.ins'))
      .filter(function (m) { return m.offsetParent !== null; });
    if (!marks.length) return;
    radChangeIndex = (radChangeIndex + dir + marks.length) % marks.length;
    marks.forEach(function (m) { m.classList.remove('rad-focus'); });
    var mark = marks[radChangeIndex];
    mark.classList.add('rad-focus');
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function mmContainer() { return document.querySelector('.detail'); }
  function mmRelTop(el, container) {
    return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  }
  // Marks where the edits sit within the scrolled detail document, so a long
  // rendered post tells you at a glance where the changes are.
  function updateMinimap() {
    var mm = document.getElementById('minimap');
    if (!mm) return;
    var container = mmContainer();
    if (!container) { mm.hidden = true; return; }
    var rect = container.getBoundingClientRect();
    var sh = container.scrollHeight, ch = rect.height;
    if (ch < 8 || sh <= ch + 4) { mm.hidden = true; return; }
    var marks = container.querySelectorAll('.ins, .del, .dp-frow.changed');
    var pts = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.offsetParent === null) continue;
      pts.push({ y: mmRelTop(m, container) / sh * ch, del: m.classList.contains('del') });
    }
    pts.sort(function (a, b) { return a.y - b.y; });
    var html = '', last = -99;
    for (var j = 0; j < pts.length; j++) {
      if (pts[j].y - last < 7) continue;
      last = pts[j].y;
      html += '<div class="mm-tick ' + (pts[j].del ? 'deleted' : '') + '" style="top:' + pts[j].y.toFixed(1) + 'px"></div>';
    }
    mm.style.top = rect.top + 'px';
    mm.style.height = ch + 'px';
    mm.hidden = false;
    var viewTop = (container.scrollTop / sh * ch).toFixed(1);
    var viewH = Math.max(18, ch * ch / sh).toFixed(1);
    mm.innerHTML = html + '<div class="mm-view" style="top:' + viewTop + 'px;height:' + viewH + 'px"></div>';
  }
  window.__radUpdateMinimap = updateMinimap;
  var mmRaf = 0;
  function mmOnScroll() {
    if (mmRaf) return;
    mmRaf = requestAnimationFrame(function () { mmRaf = 0; updateMinimap(); });
  }
  (function () {
    var mm = document.getElementById('minimap');
    if (mm) mm.addEventListener('click', function (e) {
      var container = mmContainer();
      if (!container) return;
      var rect = mm.getBoundingClientRect();
      var frac = (e.clientY - rect.top) / rect.height;
      container.scrollTop = frac * container.scrollHeight - container.clientHeight / 2;
    });
    window.addEventListener('resize', updateMinimap);
  })();

  function connectLiveStream() {
    if (window.__radEventSource) return;
    if (new URLSearchParams(location.search).get('nostream') !== null) return;
    var es = new EventSource('/api/events');
    window.__radEventSource = es;
    es.onmessage = function () {
      if (window.htmx) {
        window.htmx.ajax('GET', '/api/console', { target: '#console', swap: 'innerHTML' });
      }
    };
  }

  function init() {
    connectLiveStream();
    var consoleEl = document.getElementById('console');
    var allRows = qsa('.row');
    var panes = qsa('.detail-pane');
    var railNodes = qsa('.rail-node');
    var groups = qsa('.group');
    var growRows = qsa('.grow');
    var cmd = document.getElementById('cmd');
    var noResults = document.querySelector('.no-results');
    if (!allRows.length) return;

    var params = new URLSearchParams(location.search);
    if (params.get('showall') === '1') window.__radShowAll = true;
    if (params.get('conn')) window.__radConn = params.get('conn');
    if (params.get('folder')) window.__radFolder = params.get('folder');
    if (params.get('dview') && consoleEl) consoleEl.classList.add('dview-' + params.get('dview'));
    if (params.get('reveal') && consoleEl) consoleEl.classList.add('rad-reveal');
    if (params.get('openstudio') && !window.__radStudioOpened && window.htmx) {
      window.__radStudioOpened = true;
      window.htmx.ajax('GET', '/api/templates', { target: '#tmpl-overlay', swap: 'innerHTML' });
    }
    var viewParam = params.get('view');
    if (viewParam && consoleEl) {
      consoleEl.classList.remove('mode-review', 'mode-patterns', 'mode-scanner');
      consoleEl.classList.add('mode-' + viewParam);
    }

    var visible = allRows.slice();
    var sel = 0;
    var firstLoad = !window.__radSelPath;

    function detailFor(row) {
      return panes.find(function (p) { return p.dataset.idx === row.dataset.idx; });
    }
    function showByRow(row) {
      sel = visible.indexOf(row);
      radChangeIndex = -1;
      allRows.forEach(function (r) { r.classList.toggle('active', r === row); });
      panes.forEach(function (p) { p.hidden = (p.dataset.idx !== row.dataset.idx); });
      row.scrollIntoView({ block: 'nearest' });
      window.__radSelPath = row.dataset.path;
      window.__radSelConn = row.dataset.connection;
      var pane = detailFor(row);
      if (pane && pane.dataset.conn && !pane.dataset.loaded) {
        pane.dataset.loaded = '1';
        if (window.htmx) {
          window.htmx.ajax('GET',
            '/api/detail?conn=' + encodeURIComponent(pane.dataset.conn) +
            '&rel=' + encodeURIComponent(pane.dataset.rel),
            { target: pane, swap: 'innerHTML' });
        }
      }
      requestAnimationFrame(updateMinimap);
    }
    function show(i) {
      if (!visible.length) return;
      var n = visible.length;
      showByRow(visible[((i % n) + n) % n]);
    }
    function act(name) {
      if (!visible.length) return;
      var pane = detailFor(visible[sel]);
      if (pane) { var b = pane.querySelector('.act.' + name); if (b) b.click(); }
    }

    function matchScope(row) {
      var conn = window.__radConn || '';
      var folder = window.__radFolder || '';
      if (conn && row.dataset.connection !== conn) return false;
      if (folder) {
        var rf = row.dataset.folder || '';
        if (rf !== folder && rf.indexOf(folder + '/') !== 0) return false;
      }
      return true;
    }
    function matchSearch(row) {
      var q = ((cmd && cmd.value) || '').trim().toLowerCase();
      if (!q) return true;
      return (row.dataset.search || '').indexOf(q) !== -1;
    }
    function matchChanged(row) {
      return window.__radShowAll || row.dataset.changed === '1';
    }
    function applyFilters(preservePath) {
      visible = [];
      allRows.forEach(function (r) {
        var ok = matchScope(r) && matchSearch(r) && matchChanged(r);
        r.style.display = ok ? '' : 'none';
        if (ok) visible.push(r);
      });
      groups.forEach(function (g) {
        var rows = Array.prototype.slice.call(g.querySelectorAll('.row'));
        var shown = rows.filter(function (r) { return r.style.display !== 'none'; });
        g.style.display = shown.length ? '' : 'none';
        var counter = g.querySelector('.group-count');
        if (counter) counter.textContent = shown.length;
      });
      var growShown = 0;
      growRows.forEach(function (r) {
        var ok = matchScope(r) && matchSearch(r) && matchChanged(r);
        r.style.display = ok ? '' : 'none';
        if (ok) growShown++;
      });
      var gridCount = document.getElementById('grid-count');
      if (gridCount) gridCount.textContent = growShown;
      qsa('.fgroup').forEach(function (g) {
        var gr = Array.prototype.slice.call(g.querySelectorAll('.grow'));
        g.style.display = gr.some(function (r) { return r.style.display !== 'none'; }) ? '' : 'none';
      });
      if (noResults) noResults.hidden = visible.length > 0;
      var target = null;
      if (preservePath && window.__radSelPath) {
        target = visible.find(function (r) {
          return r.dataset.path === window.__radSelPath && r.dataset.connection === window.__radSelConn;
        });
      }
      if (!target) target = visible[0];
      if (target) showByRow(target);
      updateMinimap();
    }
    window.__radApply = applyFilters;

    railNodes.forEach(function (node) {
      node.classList.toggle('active',
        (node.dataset.conn || '') === (window.__radConn || '') &&
        (node.dataset.folder || '') === (window.__radFolder || ''));
      node.addEventListener('click', function () {
        window.__radConn = node.dataset.conn || '';
        window.__radFolder = node.dataset.folder || '';
        railNodes.forEach(function (n) { n.classList.remove('active'); });
        node.classList.add('active');
        applyFilters(true);
      });
    });
    allRows.forEach(function (r) { r.addEventListener('click', function () { showByRow(r); }); });
    qsa('.feed-card').forEach(function (c) {
      c.addEventListener('click', function () {
        window.__radSelPath = c.dataset.path;
        window.__radSelConn = c.dataset.connection;
        if (c.dataset.changed !== '1') window.__radShowAll = true;
        if (consoleEl) consoleEl.classList.remove('mode-patterns', 'mode-scanner');
        init();
      });
    });
    if (consoleEl && !/dview-/.test(consoleEl.className)) consoleEl.classList.add('dview-preview');

    // Keep the segmented toggles visually in sync with current state each render.
    qsa('#seg-scope .seg-btn').forEach(function (b) {
      b.classList.toggle('active', (b.dataset.showall === '1') === !!window.__radShowAll);
    });
    qsa('#seg-mode .seg-btn').forEach(function (b) {
      var current = 'review';
      if (consoleEl && consoleEl.classList.contains('mode-patterns')) current = 'patterns';
      else if (consoleEl && consoleEl.classList.contains('mode-scanner')) current = 'scan';
      b.classList.toggle('active', b.dataset.view === current);
    });

    // The command bar persists across live refreshes, so bind its controls once
    // and let them call the latest applyFilters via window.__radApply.
    if (!window.__radControlsBound) {
      window.__radControlsBound = true;
      if (cmd) cmd.addEventListener('input', function () { if (window.__radApply) window.__radApply(true); });
      qsa('#seg-scope .seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          window.__radShowAll = b.dataset.showall === '1';
          qsa('#seg-scope .seg-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          if (window.__radApply) window.__radApply(true);
        });
      });
      qsa('#seg-mode .seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var c = document.getElementById('console');
          if (c) {
            c.classList.remove('mode-review', 'mode-patterns', 'mode-scanner');
            c.classList.add('mode-' + b.dataset.view);
          }
          qsa('#seg-mode .seg-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          requestAnimationFrame(function () { if (window.__radUpdateMinimap) window.__radUpdateMinimap(); });
        });
      });
    }

    document.onkeydown = function (e) {
      if (cmd && document.activeElement === cmd) { if (e.key === 'Escape') cmd.blur(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (cmd) cmd.focus(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return; // let Cmd+R / Cmd+A / browser shortcuts through
      if (e.key === ' ' || e.code === 'Space') {
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'BUTTON' || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        e.preventDefault();
        if (consoleEl) consoleEl.classList.add('rad-reveal');
        return;
      }
      switch (e.key) {
        case 'ArrowDown': case 'j': e.preventDefault(); show(sel + 1); break;
        case 'ArrowUp': case 'k': e.preventDefault(); show(sel - 1); break;
        case '/': e.preventDefault(); if (cmd) cmd.focus(); break;
        case 'a': act('accept'); break;
        case 'r': act('reject'); break;
        case 'd': act('discard'); break;
        case 'n': e.preventDefault(); stepChange(1); break;
        case 'p': e.preventDefault(); stepChange(-1); break;
      }
    };

    var detailScroll = document.querySelector('.detail');
    if (detailScroll && !detailScroll.__mmBound) {
      detailScroll.__mmBound = true;
      detailScroll.addEventListener('scroll', mmOnScroll);
    }
    applyFilters(true);
    if (firstLoad) {
      var qp = new URLSearchParams(location.search).get('sel');
      var i = parseInt(qp, 10);
      if (!isNaN(i) && i >= 0 && i < visible.length) showByRow(visible[i]);
    }
  }
  document.addEventListener('DOMContentLoaded', init);
  document.body.addEventListener('htmx:afterSwap', function (e) {
    var t = e && e.target;
    if (!t) { init(); return; }
    if (t.classList && t.classList.contains('detail-pane')) { bindDetail(t); }
    else if (t.id === 'tmpl-overlay') { /* the template studio manages itself */ }
    else { init(); }
  });

  function closeTemplates() {
    var overlay = document.getElementById('tmpl-overlay');
    if (overlay && overlay.innerHTML) { overlay.innerHTML = ''; return true; }
    return false;
  }
  document.body.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.tmpl-close')) { closeTemplates(); }
    else if (e.target && e.target.id === 'tmpl-overlay') { closeTemplates(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeTemplates(); }
  });
  function clearReveal() {
    var c = document.getElementById('console');
    if (c) c.classList.remove('rad-reveal');
  }
  document.addEventListener('keyup', function (e) {
    if (e.key === ' ' || e.code === 'Space') clearReveal();
  });
  window.addEventListener('blur', clearReveal);
})();
"#;

const STYLES: &str = r#"
:root {
  --bg: #f6f3ec; --panel: #fffdf7; --panel-2: #fbf8f1; --rail: #f1ece1;
  --line: #e2ddce; --line-soft: #ece7dc;
  --text: #181410; --dim: #6e6655; --faint: #a8a08e;
  /* Scratch brand */
  --paper: #f6f3ec; --ink: #181410; --ink-soft: #6e6655;
  --bp-blue: #155cf2; --hl-yellow: #ffff66; --amber: #f5c84a; --rose: #e08585;
  --serif: "Fraunces", Georgia, "Times New Roman", serif;
  --sel: rgba(21,92,242,.10); --sel-bar: #155cf2;
  --mint: #2fe6b0; --blue: #155cf2;
  --ins: #2f9e6e; --ins-bg: rgba(47,158,110,.13);
  --del: #c5524f; --del-bg: rgba(197,82,79,.10);
  --svc-shopify: #5aa544; --svc-wordpress: #2b7fd4; --svc-webflow: #7c5cff;
  --svc-airtable: #e08a1e; --svc-youtube: #d8453f; --svc-notion: #6e6655; --svc-default: #a8a08e;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
::selection { background: var(--hl-yellow); color: var(--ink); }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  background-color: var(--bg);
  background-image:
    linear-gradient(color-mix(in srgb, var(--ink) 4%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--ink) 4%, transparent) 1px, transparent 1px);
  background-size: 22px 22px;
  color: var(--text);
  font: 13px/1.5 var(--mono);
  -webkit-font-smoothing: antialiased;
  display: grid; grid-template-rows: 50px 1fr 30px; height: 100vh;
}

/* ---- command bar ---- */
.cmdbar { display: grid; grid-template-columns: auto minmax(240px, 1fr) auto; align-items: center; gap: 16px; padding: 0 18px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mark { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid rgba(21,92,242,.5); display: grid; place-items: center; box-shadow: 0 0 12px -3px var(--bp-blue); }
.mark-core { width: 6px; height: 6px; border-radius: 50%; background: var(--bp-blue); box-shadow: 0 0 8px var(--bp-blue); }
.brand .name { font-family: var(--serif); font-weight: 700; letter-spacing: 3px; font-size: 15px; color: var(--ink); }
.brand .ws { color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search { display: flex; align-items: center; gap: 9px; background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 0 11px; height: 32px; }
.search:focus-within { border-color: var(--bp-blue); box-shadow: 0 0 0 3px rgba(21,92,242,.18); }
.search-icon { color: var(--faint); font-size: 15px; }
.search input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--text); font: inherit; font-size: 12.5px; }
.search input::placeholder { color: var(--faint); }
.kbd { font-size: 10px; color: var(--faint); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
.status { display: flex; align-items: center; justify-content: flex-end; gap: 14px; font-size: 11.5px; }
.bar-right { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.seg { display: inline-flex; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
.seg-btn { background: transparent; border: 0; color: var(--dim); font: inherit; font-size: 11.5px; padding: 4px 11px; border-radius: 6px; cursor: pointer; transition: all .12s; }
.seg-btn:hover { color: var(--text); }
.seg-btn.active { background: var(--panel); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,.35); }
.stat { color: var(--dim); display: inline-flex; align-items: center; gap: 5px; }
.stat::before { content: ""; width: 7px; height: 7px; border-radius: 2px; }
.stat.s-unreviewed::before { background: var(--amber); }
.stat.s-unpublished::before { background: var(--blue); }
.live { display: inline-flex; align-items: center; gap: 6px; color: var(--bp-blue); font-weight: 600; letter-spacing: 1.5px; font-size: 10.5px; padding: 4px 9px; border: 1px solid rgba(21,92,242,.3); border-radius: 100px; }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bp-blue); box-shadow: 0 0 9px var(--bp-blue); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

/* ---- console ---- */
.console { display: grid; grid-template-columns: 196px 1fr; min-height: 0; }
.rail { border-right: 1px solid var(--line); padding: 14px 10px; overflow-y: auto; background: var(--rail); }
.rail-head { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--faint); padding: 2px 8px 9px; }
.rail-item { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
.rail-item:hover { background: rgba(24,20,16,.03); }
.svc-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--svc-default); box-shadow: 0 0 8px -1px currentColor; }
.svc-dot.svc-shopify { background: var(--svc-shopify); color: var(--svc-shopify); }
.svc-dot.svc-wordpress { background: var(--svc-wordpress); color: var(--svc-wordpress); }
.svc-dot.svc-webflow { background: var(--svc-webflow); color: var(--svc-webflow); }
.svc-dot.svc-airtable { background: var(--svc-airtable); color: var(--svc-airtable); }
.svc-dot.svc-youtube { background: var(--svc-youtube); color: var(--svc-youtube); }
.svc-dot.svc-notion { background: var(--svc-notion); color: var(--svc-notion); }
.rail-name { flex: 1; font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-count { font-size: 11px; font-weight: 600; color: var(--text); background: rgba(24,20,16,.06); border-radius: 5px; padding: 0 6px; }
.rail-quiet { color: var(--faint); }

/* ---- workspace: list + detail ---- */
.workspace { min-height: 0; overflow: hidden; }
.banner-error { background: var(--del-bg); color: var(--del); padding: 8px 14px; font-size: 12px; border-bottom: 1px solid rgba(255,125,138,.2); }
.wsgrid { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; height: 100%; min-height: 0; }
#console.mode-scanner .detail { display: none; }
#console.mode-scanner .wsgrid { grid-template-columns: 1fr; }
#console.mode-patterns .wsgrid { display: none; }
.patterns { display: none; flex-direction: column; min-height: 0; height: 100%; }
#console.mode-patterns .patterns { display: flex; }
.patterns-head { flex: none; display: flex; align-items: baseline; gap: 12px; padding: 14px 16px 12px; }
.ph-title { font-family: var(--serif); font-weight: 600; font-size: 18px; color: var(--ink); }
.ph-sub { color: var(--faint); font-size: 12px; }
.grid-wrap { flex: 1; overflow: auto; min-height: 0; }
.feed { flex: 1; overflow-y: auto; min-height: 0; padding: 0 0 40px; }
.fgroup-head { display: flex; align-items: center; gap: 7px; padding: 13px 18px 4px; font-family: var(--mono); font-size: 11px; color: var(--ink-soft); position: sticky; top: 0; background: var(--bg); z-index: 1; }
.fgh-conn { color: var(--ink); font-weight: 600; }
.fgh-count { margin-left: 5px; color: var(--faint); }
.lrow { display: flex; align-items: center; gap: 13px; padding: 5px 18px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.lrow:hover { background: rgba(24,20,16,.045); }
.lr-thumb { flex: none; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--ink) 8%, var(--paper)); display: grid; place-items: center; position: relative; }
.lr-thumb.vid { width: 50px; height: 28px; }
.lr-thumb.sq { width: 30px; height: 30px; }
.lr-thumb img { width: 100%; height: 100%; object-fit: cover; }
.r-mono { font-family: var(--serif); font-size: 14px; color: var(--ink-soft); }
.lr-dur { position: absolute; bottom: 1px; right: 1px; background: rgba(0,0,0,.8); color: #fff; font-family: var(--mono); font-size: 7px; line-height: 1.5; padding: 0 2px; border-radius: 2px; }
.lr-title { flex: 2 1 0; min-width: 0; font-family: var(--serif); font-size: 13.5px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lr-snip { flex: 3 1 0; min-width: 0; font-family: var(--serif); font-size: 12.5px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lr-col { flex: none; font-family: var(--mono); font-size: 11px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 6px; }
.lr-sep { color: var(--faint); }
.lr-state { flex: none; width: 88px; display: flex; justify-content: flex-end; }
.lrow .chip { flex: none; }
.lrow mark.ins { background: rgba(124,92,246,.16); color: var(--ink); border-radius: 3px; padding: 0 1px; }
.minimap { position: fixed; width: 12px; right: 2px; z-index: 40; cursor: pointer; background: rgba(24,20,16,.05); border-radius: 6px; }
.minimap[hidden] { display: none; }
.minimap:hover { background: rgba(24,20,16,.08); }
.mm-tick { position: absolute; right: 1px; width: 10px; height: 5px; border-radius: 2px; background: linear-gradient(90deg, #155cf2, #7c5cf6); box-shadow: 0 0 0 1px rgba(255,255,255,.55); animation: rad-tick-pulse 1.8s ease-in-out infinite; }
.mm-tick.deleted { background: var(--del); }
.mm-view { position: absolute; left: 1px; right: 1px; background: rgba(124,92,246,.10); border: 1px solid rgba(124,92,246,.3); border-radius: 3px; pointer-events: none; min-height: 18px; }
@keyframes rad-tick-pulse { 0%, 100% { opacity: .7; box-shadow: 0 0 0 1px rgba(255,255,255,.5); } 50% { opacity: 1; box-shadow: 0 0 7px 1px rgba(124,92,246,.85); } }
table.grid { border-collapse: separate; border-spacing: 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.45; }
.grid th, .grid td { border-bottom: 1px solid var(--line-soft); border-right: 1px solid var(--line-soft); padding: 5px 10px; max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; vertical-align: top; }
.grid thead th { position: sticky; top: 0; z-index: 3; background: var(--panel-2); color: var(--dim); vertical-align: bottom; }
.grid .col-rec, .grid .cell-rec { position: sticky; left: 0; z-index: 2; background: var(--rail); min-width: 220px; max-width: 260px; }
.grid thead .col-rec { z-index: 4; }
.colh { display: flex; align-items: baseline; gap: 6px; }
.colh-name { color: var(--blue); font-weight: 600; }
.colh-count { color: var(--faint); }
.colh-bulk { display: flex; gap: 4px; margin-top: 4px; height: 0; overflow: hidden; opacity: 0; transition: opacity .12s; }
.grid th:hover .colh-bulk { opacity: 1; height: auto; }
.crin { display: flex; align-items: center; gap: 7px; }
.cr-title { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.cr-folder { color: var(--faint); font-size: 10px; flex: none; }
.gcell { color: var(--dim); }
.gcell.changed { background: rgba(245,200,74,.14); }
.gcell .gdim { color: var(--faint); }
.grid tbody tr:hover td { background: rgba(24,20,16,.03); }
.grid tbody tr:hover .cell-rec { background: #efe9dd; }
.grid tbody tr:hover .gcell.changed { background: rgba(245,200,74,.24); }
.list { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.list-head { display: grid; grid-template-columns: 22px 1fr 34px; gap: 8px; padding: 9px 14px; font-size: 9.5px; letter-spacing: 1.2px; color: var(--faint); border-bottom: 1px solid var(--line); }
.lh-delta { text-align: right; }
.list-body { overflow-y: auto; min-height: 0; }
.row { display: grid; grid-template-columns: 22px 1fr 34px; gap: 8px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--line-soft); cursor: pointer; border-left: 2px solid transparent; }
.row:hover { background: rgba(24,20,16,.025); }
.row.active { background: var(--sel); border-left-color: var(--sel-bar); }
.glyph { width: 8px; height: 8px; border-radius: 2px; justify-self: center; background: var(--faint); }
.glyph.state-unreviewed { background: var(--amber); box-shadow: 0 0 9px -1px var(--amber); }
.glyph.state-unpublished { background: var(--blue); box-shadow: 0 0 9px -1px var(--blue); }
.glyph.state-added { background: var(--ins); box-shadow: 0 0 9px -1px var(--ins); }
.glyph.state-deleted { background: var(--del); box-shadow: 0 0 9px -1px var(--del); }
.glyph.state-unchanged { background: var(--faint); box-shadow: none; opacity: .5; }
.row.state-unchanged .row-title { color: var(--dim); }
.row-main { min-width: 0; }
.row-title { font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.active .row-title { color: var(--ink); }
.row-sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--faint); margin-top: 2px; }
.row-conn { color: var(--dim); }
.row-delta { font-size: 11px; color: var(--dim); text-align: right; font-weight: 600; }

/* navigable rail */
.rail-node { display: flex; align-items: center; gap: 9px; padding: 6px 9px; border-radius: 7px; cursor: pointer; border-left: 2px solid transparent; }
.rail-node:hover { background: rgba(24,20,16,.035); }
.rail-node.active { background: var(--sel); border-left-color: var(--sel-bar); }
.rail-node.folder { padding-left: 26px; }
.rail-node.folder .rn-label { color: var(--dim); font-size: 12px; }
.rail-node.parent .rn-label { color: var(--text); font-weight: 600; }
.rn-label { flex: 1; font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-count { font-size: 10.5px; color: var(--dim); background: rgba(24,20,16,.05); border-radius: 5px; padding: 0 6px; }
.rail-node.active .rn-count { color: var(--text); }

/* service groups + bulk */
.group { margin-bottom: 4px; }
.group-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 9px; padding: 8px 14px; background: var(--panel-2); border-bottom: 1px solid var(--line); }
.group-name { font-size: 11.5px; font-weight: 600; letter-spacing: .4px; color: var(--text); text-transform: uppercase; }
.group-count { font-size: 10.5px; color: var(--dim); background: rgba(24,20,16,.06); border-radius: 100px; padding: 0 7px; }
.group-bulk { margin-left: auto; display: flex; gap: 5px; opacity: 0; transition: opacity .12s; }
.group:hover .group-bulk { opacity: 1; }
.gb { background: transparent; border: 1px solid var(--line); color: var(--faint); border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 10.5px; cursor: pointer; }
.gb:hover { color: var(--text); border-color: var(--faint); }
.gb.accept:hover { color: var(--amber); border-color: var(--amber); }
.gb.discard:hover { color: var(--rose); border-color: var(--rose); }
.no-results { padding: 30px; text-align: center; color: var(--faint); }

.detail { overflow-y: auto; min-height: 0; padding: 22px 26px; }
.detail-pane { max-width: 1180px; }
.dp-meta { font-size: 11px; color: var(--faint); margin: 8px 0 24px; }
.dp-meta b { color: var(--dim); font-weight: 600; }
.dp-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dp-conn { color: var(--text); font-weight: 600; }
.dp-sep, .dp-folder { color: var(--dim); }
.chip { margin-left: auto; font-size: 9.5px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; padding: 3px 9px; border-radius: 100px; }
.chip.state-unreviewed { color: var(--ink); background: rgba(245,200,74,.32); border: 1px solid rgba(245,200,74,.55); }
.chip.state-unpublished { color: var(--ink); background: rgba(21,92,242,.14); border: 1px solid rgba(21,92,242,.4); }
.chip.state-added { color: var(--ink); background: rgba(47,158,110,.16); border: 1px solid rgba(47,158,110,.4); }
.chip.state-deleted { color: var(--ink); background: rgba(197,82,79,.14); border: 1px solid rgba(197,82,79,.4); }
.chip.state-unchanged { color: var(--ink-soft); background: transparent; border: 1px solid var(--line); }
.dp-title { font-family: var(--serif); font-weight: 600; font-size: 21px; color: var(--ink); margin: 13px 0 3px; line-height: 1.25; }
.dp-path { font-size: 11px; color: var(--faint); }
.dp-fields { display: flex; flex-direction: column; gap: 14px; }
.dp-field.inline { display: grid; grid-template-columns: 130px 1fr; gap: 14px; align-items: baseline; }
.dp-field.block { display: flex; flex-direction: column; gap: 7px; }
.dp-flabel { font-size: 11px; color: var(--dim); letter-spacing: .2px; }
.dp-field.block .dp-flabel { text-transform: uppercase; letter-spacing: 1px; font-size: 10px; color: var(--faint); }
.dp-fdiff { font-size: 13.5px; min-width: 0; word-break: break-word; }
.dp-field.block .dp-fdiff { font-family: var(--mono); font-size: 13.5px; line-height: 1.6; }
.diff .eq { color: var(--text); }
.diff .del { color: var(--del); background: transparent; text-decoration: line-through; border-radius: 2px; }
.diff .ins { color: var(--ink); background: var(--hl-yellow); border-radius: 2px; padding: 0 1px; }
.arrow { color: var(--faint); margin: 0 7px; }
.large { color: var(--dim); } .note { color: var(--faint); font-style: italic; margin-left: 6px; font-size: 11px; }
.tag-added, .tag-removed { font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; margin-right: 8px; padding: 1px 6px; border-radius: 5px; }
.tag-added { color: var(--ins); background: var(--ins-bg); } .tag-removed { color: var(--del); background: var(--del-bg); }
.dp-more { font-size: 12px; color: var(--faint); }
.dp-nochange { color: var(--faint); font-size: 13px; padding: 4px 0; }
.dp-actions { display: flex; gap: 9px; }
.dp-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; position: sticky; top: 0; z-index: 3; background: var(--bg); padding: 8px 0; margin: 0 0 14px; }
.dp-viewswitch { display: inline-flex; gap: 2px; background: rgba(24,20,16,.05); border-radius: 8px; padding: 3px; }
.dpv-btn { font-family: var(--mono); font-size: 11px; color: var(--dim); background: transparent; border: 0; border-radius: 6px; padding: 5px 13px; cursor: pointer; }
.dpv-btn.active { background: var(--paper); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.07); }
.dpv-n { color: var(--faint); }
.dp-view { display: none; }
#console.dview-preview .dp-view.preview,
#console.dview-fields .dp-view.fields,
#console.dview-raw .dp-view.raw { display: block; }
.dp-fieldtable { display: flex; flex-direction: column; border-top: 1px solid var(--line-soft); max-width: 940px; }
.dp-frow { display: flex; gap: 16px; padding: 6px 3px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
.dp-frow.block { flex-direction: column; gap: 3px; }
.dp-frow.changed { background: rgba(255,255,102,.18); }
.dp-fkey { flex: none; width: 230px; font-family: var(--mono); font-size: 11px; color: var(--ink-soft); word-break: break-word; }
.dp-frow.block .dp-fkey { width: auto; }
.dp-fval { flex: 1; min-width: 0; font-family: var(--serif); color: var(--ink); word-break: break-word; white-space: pre-wrap; }
.dp-fempty { color: var(--faint); }
.dp-raw { font-family: var(--mono); font-size: 11.5px; line-height: 1.5; color: var(--ink); background: rgba(24,20,16,.03); border: 1px solid var(--line-soft); border-radius: 8px; padding: 14px 16px; white-space: pre-wrap; word-break: break-word; max-width: 940px; }
.dp-empty { color: var(--dim); font-family: var(--mono); font-size: 12.5px; padding: 24px 0; }
.tmpl-open { font-family: var(--mono); font-size: 12px; color: var(--ink); background: var(--paper); border: 1px solid color-mix(in srgb, var(--ink) 18%, var(--paper)); border-radius: 8px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }
.tmpl-open:hover { border-color: var(--bp-blue); color: var(--bp-blue); }
#tmpl-overlay:empty { display: none; }
#tmpl-overlay { position: fixed; inset: 0; background: rgba(24,20,16,.5); z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 36px 24px; overflow: auto; }
.tmpl-modal { background: var(--bg); border: 1px solid color-mix(in srgb, var(--ink) 16%, var(--paper)); border-radius: 14px; width: min(1180px, 100%); box-shadow: 0 30px 80px -20px rgba(24,20,16,.6); overflow: hidden; }
.tmpl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 26px; border-bottom: 1px solid var(--line-soft); background: var(--paper); }
.tmpl-head h2 { font-family: var(--serif); font-size: 22px; color: var(--ink); margin: 0 0 5px; }
.tmpl-sub { font-family: var(--mono); font-size: 12px; color: var(--ink-soft); max-width: 780px; line-height: 1.5; }
.tmpl-close { font-size: 16px; color: var(--dim); background: transparent; border: 0; cursor: pointer; padding: 4px 9px; border-radius: 6px; }
.tmpl-close:hover { background: rgba(24,20,16,.06); color: var(--ink); }
.tmpl-list { padding: 18px 26px 30px; display: flex; flex-direction: column; gap: 20px; max-height: calc(100vh - 190px); overflow: auto; }
.tmpl-card { border: 1px solid var(--line-soft); border-radius: 10px; overflow: hidden; background: var(--paper); }
.tmpl-card-head { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 1px solid var(--line-soft); }
.tmpl-file { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink); }
.tmpl-arch { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--ink); background: rgba(245,200,74,.4); border-radius: 4px; padding: 2px 8px; }
.tmpl-match { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); margin-left: auto; }
.tmpl-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.tmpl-form { display: flex; flex-direction: column; border-right: 1px solid var(--line-soft); min-width: 0; }
.tmpl-json { font-family: var(--mono); font-size: 11.5px; line-height: 1.55; color: var(--ink); background: #fffdf7; border: 0; outline: none; resize: vertical; min-height: 250px; padding: 14px 16px; white-space: pre-wrap; word-break: break-word; tab-size: 2; }
.tmpl-formbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--line-soft); background: var(--paper); }
.tmpl-save { font-family: var(--mono); font-size: 12px; color: var(--ink); background: var(--amber); border: 0; border-radius: 7px; padding: 7px 16px; cursor: pointer; font-weight: 600; }
.tmpl-save:hover { background: var(--hl-yellow); }
.tmpl-ok { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); }
.tmpl-err { font-family: var(--mono); font-size: 11px; color: #b4452f; }
.tmpl-sample { padding: 16px; background: var(--bg); display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.tmpl-sample-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--faint); }
.tmpl-feed { border: 1px solid var(--line-soft); border-radius: 8px; overflow: hidden; }
.tmpl-feed .lrow { cursor: default; border-bottom: 0; }
.tmpl-sample-empty { font-family: var(--mono); font-size: 12px; color: var(--dim); padding: 16px 0; }
.dp-split { margin-top: 24px; }
.dp-split.has-preview { display: grid; grid-template-columns: minmax(290px, 420px) 1fr; gap: 32px; align-items: start; }
.dp-changes { min-width: 0; }
.dp-section { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--faint); margin-bottom: 16px; display: flex; align-items: center; }
.pv-near { color: var(--ink); background: var(--amber); margin-left: 9px; font-size: 8.5px; letter-spacing: 1px; border-radius: 3px; padding: 1px 7px; font-weight: 600; }
.dp-preview { min-width: 0; }
.pv-frame { background: #fffdf7; color: var(--ink); border: 1px solid color-mix(in srgb, var(--ink) 16%, var(--paper)); border-radius: 6px; padding: 26px 30px; box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 14px 36px -18px rgba(24,20,16,.28); font-family: var(--serif); }
.vid-thumb { position: relative; border-radius: 6px; overflow: hidden; margin-bottom: 14px; aspect-ratio: 16 / 9; background: #000; }
.vid-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vid-dur { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,.85); color: #fff; font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: 4px; }
.vid-title { margin-bottom: 5px; }
.vid-channel { color: var(--ink-soft); font-size: 12.5px; font-family: var(--mono); margin-bottom: 13px; }
.vid-desc { font-size: 13.5px; white-space: pre-wrap; }
.prod { display: flex; gap: 18px; align-items: flex-start; }
.prod-img { flex: none; width: 116px; height: 116px; border-radius: 6px; overflow: hidden; background: color-mix(in srgb, var(--ink) 7%, var(--paper)); }
.prod-noimg { display: grid; place-items: center; font-family: var(--serif); font-size: 40px; color: var(--ink-soft); }
.prod-img img { width: 100%; height: 100%; object-fit: cover; }
.prod-info { flex: 1; min-width: 0; }
.prod-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.prod-title { margin-bottom: 0; }
.prod-badge { flex: none; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--ink); background: rgba(245,200,74,.45); border-radius: 4px; padding: 2px 7px; white-space: nowrap; }
.prod-meta { display: flex; gap: 14px; margin: 9px 0 12px; font-family: var(--mono); font-size: 12px; color: var(--ink-soft); }
.prod-price { color: var(--ink); font-weight: 600; }
.prod-desc { font-size: 13.5px; }
.art-hero { width: 100%; border-radius: 6px; margin-bottom: 16px; display: block; }
.pv-img { max-width: 100%; border-radius: 9px; margin-bottom: 16px; display: block; }
.pv-title { font-family: var(--serif); font-weight: 700; font-size: 23px; color: #0f0f10; line-height: 1.24; margin-bottom: 15px; letter-spacing: -.2px; }
.pv-body { font-size: 14.5px; line-height: 1.72; color: #34343a; word-break: break-word; }
.pv-body p { margin: 0 0 13px; }
.pv-body :is(h1,h2,h3,h4) { color: #131316; line-height: 1.3; margin: 18px 0 8px; }
.pv-body img { max-width: 100%; height: auto; border-radius: 8px; margin: 6px 0; }
.pv-body a { color: #1d63d8; text-decoration: underline; }
.pv-body ul, .pv-body ol { padding-left: 20px; margin: 0 0 13px; }
.pv-plain { white-space: pre-wrap; }
.pv-frame .diff .eq { color: inherit; }
.pv-frame .diff .ins { color: var(--ink); background: var(--hl-yellow); border-radius: 2px; text-decoration: none; padding: 0 1px; }
/* Body edits read clean in the flow; they light up only on hover or when you
   step to them (.rad-focus), so the result stays readable. */
.pv-frame mark.ins, .pv-body mark.ins {
  position: relative; color: inherit; background: transparent; border-radius: 4px; padding: 0 1px;
  cursor: help; text-decoration: none; -webkit-box-decoration-break: clone; box-decoration-break: clone;
  transition: background .15s, box-shadow .15s;
}
.pv-frame mark.ins:hover, .pv-body mark.ins:hover, mark.ins.rad-focus {
  background: linear-gradient(110deg, rgba(21,92,242,.16), rgba(124,92,246,.2), rgba(236,72,153,.16));
  background-size: 220% 100%;
  box-shadow: 0 0 0 1px rgba(124,92,246,.55), 0 0 12px rgba(124,92,246,.4);
  animation: ai-shimmer 3.5s linear infinite;
}
@keyframes ai-shimmer { 0% { background-position: 0% 50%; } 100% { background-position: 220% 50%; } }
/* Hold space: flash every body edit on at once, then release to read clean. */
#console.rad-reveal .pv-frame mark.ins, #console.rad-reveal .pv-body mark.ins {
  background: linear-gradient(110deg, rgba(21,92,242,.16), rgba(124,92,246,.2), rgba(236,72,153,.16));
  background-size: 220% 100%;
  box-shadow: 0 0 0 1px rgba(124,92,246,.55), 0 0 12px rgba(124,92,246,.4);
  animation: ai-shimmer 3.5s linear infinite;
}
#console.rad-reveal .rad-changed-block::before { opacity: 1; width: 4px; }
/* Short-field edits (title etc.) stay gently marked — no clutter risk there. */
.pv-frame .diff .ins {
  background: linear-gradient(110deg, rgba(21,92,242,.12), rgba(124,92,246,.15), rgba(236,72,153,.12));
  background-size: 220% 100%; color: var(--ink); border-radius: 5px; padding: 0 4px; text-decoration: none;
  box-shadow: 0 0 0 1px rgba(124,92,246,.38);
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
/* "Where": a margin bar beside any block that contains an edit. */
.pv-frame .rad-changed-block, .pv-body .rad-changed-block { position: relative; }
.pv-frame .rad-changed-block::before, .pv-body .rad-changed-block::before {
  content: ''; position: absolute; left: -20px; top: .12em; bottom: .12em; width: 3px; border-radius: 2px;
  background: linear-gradient(180deg, #155cf2, #7c5cf6, #ec4899); opacity: .8;
}
mark.ins[data-before]:hover::after, mark.ins[data-before].rad-focus::after {
  content: "was: " attr(data-before);
  position: absolute; left: 50%; bottom: calc(100% + 9px); transform: translateX(-50%);
  background: var(--ink); color: #f6f3ec; font-family: var(--mono); font-size: 11px; font-weight: 400;
  padding: 7px 11px; border-radius: 7px; white-space: normal; width: max-content; max-width: 340px;
  line-height: 1.5; text-align: left; box-shadow: 0 12px 30px -8px rgba(24,20,16,.62);
  z-index: 30; pointer-events: none;
}
mark.ins[data-before]:hover::before, mark.ins[data-before].rad-focus::before {
  content: ""; position: absolute; left: 50%; bottom: calc(100% + 4px); transform: translateX(-50%);
  border: 5px solid transparent; border-top-color: var(--ink); z-index: 30; pointer-events: none;
}
.dp-frow.changed { background: linear-gradient(90deg, rgba(124,92,246,.10), transparent 55%); border-left: 2px solid #7c5cf6; }
@media (prefers-reduced-motion: reduce) { .mm-tick, .pv-frame mark.ins:hover, .pv-body mark.ins:hover, mark.ins.rad-focus { animation: none; } }
.pv-frame .diff .del { color: #a23b3b; background: transparent; text-decoration: line-through; border-radius: 2px; }
.pv-title .diff .ins { background: var(--hl-yellow); }
.act { background: transparent; border: 1px solid var(--line); color: var(--dim); border-radius: 8px; padding: 7px 16px 7px 11px; font: inherit; font-size: 12.5px; cursor: pointer; transition: all .13s; display: inline-flex; align-items: center; gap: 8px; }
.act .kc { background: rgba(24,20,16,.06); }
.act:hover { color: var(--text); border-color: var(--faint); }
.act.accept { color: var(--amber); border-color: rgba(245,200,74,.45); }
.act.accept:hover { color: var(--ink); background: var(--amber); border-color: var(--ink); box-shadow: 0 7px 20px -10px var(--amber); }
.act.accept:hover .kc { background: rgba(0,0,0,.2); color: var(--ink); }
.act.discard { color: var(--rose); border-color: rgba(224,133,133,.4); }
.act.discard:hover { color: var(--ink); background: var(--rose); border-color: var(--ink); }

.empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.empty-title { font-family: var(--serif); font-size: 18px; color: var(--text); }
.empty-sub { color: var(--faint); font-size: 13px; }

/* ---- footer ---- */
.keys { display: flex; align-items: center; gap: 18px; padding: 0 18px; border-top: 1px solid var(--line); background: var(--panel-2); font-size: 11px; color: var(--faint); }
.khint { display: inline-flex; align-items: center; gap: 6px; }
.kc { font-family: var(--mono); font-size: 10px; color: var(--dim); background: rgba(24,20,16,.05); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; min-width: 16px; text-align: center; }

::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: var(--line); border-radius: 9px; border: 2px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background: var(--faint); }
"#;
