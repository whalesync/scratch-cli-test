//! The templating ("views") layer — the heart of this app. Each folder can have
//! its own **row** view (how it looks in the list) and **preview** view (how the
//! space-to-open card looks), written as small HTML snippets with MiniJinja
//! expressions. The AI authors these as plain files; we resolve the most
//! specific one per record and render it.
//!
//! Views live entirely under the workspace's `.scratch/` — never in a connection
//! folder (those hold content) — at `.scratch/proof/views/`. Resolution
//! precedence for a record with `(service, folder)` and a `kind` of `row` or
//! `preview`:
//!   1. `<service>/<folder>.<kind>.html`   (most specific — per folder)
//!   2. `<service>.<kind>.html`            (per service)
//!   3. `default.<kind>.html`              (workspace default, seeded on start)
//!   4. a built-in default                 (so it works before any file exists)
//!
//! A `ViewMode` lets the preview pane force `Default` or `Custom` instead of the
//! `Auto` precedence, so you can flip between the generic view and a folder's
//! bespoke one. Views are re-read from disk on every render — edit a file (or
//! ask the AI) and the next keypress shows it, no restart.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use minijinja::{AutoEscape, Environment, State};
use serde_json::{json, Value};

use crate::diff;
use crate::workspace::{LookupIndex, Record};

pub const VIEWS_SUBDIR: &str = ".scratch/proof/views";

pub const DEFAULT_ROW_TEMPLATE: &str = r#"{# Default row. Ask the AI to write a per-folder one, e.g.
   .scratch/proof/views/<SERVICE>/<Folder>.row.html
   Context: title, summary, record, folder, service, connection, path, state,
   changed, added, deleted, unreviewed, unpublished, field_count, data #}
<div class="r-line">
  <span class="r-title">{{ title }}</span>
  {% if changed %}<span class="r-pill r-{{ state }}">{{ state }}</span>{% endif %}
</div>
<div class="r-sub">{{ service }} · {{ folder }}{% if field_count %} · {{ field_count }} changed{% endif %}</div>
{% if summary %}<div class="r-snippet">{{ summary }}</div>{% endif %}
"#;

pub const DEFAULT_PREVIEW_TEMPLATE: &str = r#"{# Default preview. Renders every field's value, changed ones first as
   word-level diffs. Context adds: fields = [{ key, value, changed, diff_html }],
   changes = [{ field, published, working, diff_html }], has_changes.
   diff_html is pre-rendered word-level HTML — pipe it through `safe`. #}
<div class="card-head">
  <div class="card-title">{{ title }}</div>
  <div class="card-meta">{{ service }} · {{ connection }} · {{ folder }}
    · <span class="chip chip-{{ state }}">{{ state }}</span>
    {% if has_changes %}· {{ field_count }} changed{% endif %}</div>
</div>
<div class="card-fields">
  {% for f in fields %}
  <div class="cf{% if f.changed %} cf-changed{% endif %}">
    <div class="cf-key">{{ f.key }}</div>
    <div class="cf-val">{% if f.changed %}{{ f.diff_html | safe }}{% else %}{{ f.value }}{% endif %}</div>
  </div>
  {% endfor %}
</div>
"#;

pub const VIEWS_README: &str = r#"# Proof views

Each folder can have its own **row** view and **preview** view. They're plain
HTML files with [MiniJinja](https://docs.rs/minijinja) expressions, re-read on
every render — edit a file and the next keypress shows it.

These live under the workspace's `.scratch/` (never in a connection folder,
which holds content):

```
.scratch/proof/views/
  default.row.html                  # workspace default row
  default.preview.html              # workspace default preview
  <SERVICE>.row.html                # per service, e.g. WORDPRESS.row.html
  <SERVICE>/<folder...>.row.html    # per folder; the tree mirrors the workspace
  <SERVICE>/<folder...>.preview.html
```

The views tree mirrors the workspace folder structure, so a record in
`Scratch Demo/Authors` of an Airtable connection looks for
`AIRTABLE/Scratch Demo/Authors.row.html` (real nested directories).

In the preview pane, the **default ⇄ custom** toggle (or the `t` key) flips
between the generic `default.*` view and this folder's bespoke one.

The preview column width is owned by the app (the `.card` wrapper). Do **not**
set an outer `max-width` on your top-level element — it will end up narrower than
the toolbar and the right edges won't line up. Constrain only inner body text
(e.g. a `.proof-rich` wrapper ~680px) for readable line length.

## Context available to a view

| name | meaning |
|------|---------|
| `title` | best-effort record title |
| `summary` | a one-line prose snippet (first sentence-like value), or empty |
| `record` | record filename (no `.json`) |
| `folder`, `service`, `connection`, `path` | location metadata |
| `state` | `unreviewed` / `unpublished` / `added` / `deleted` / `unchanged` |
| `changed`, `added`, `deleted`, `unreviewed`, `unpublished` | booleans |
| `field_count` | number of changed fields |
| `data` | the record's own JSON — address fields verbatim: `{{ data.fields.Name }}` |

Preview views also get:

| name | meaning |
|------|---------|
| `has_changes` | whether there are any field changes |
| `fields` | **every** field: `[{ key, value, changed, diff_html }]`, changed first |
| `changes` | changed fields only: `[{ field, published, working, diff_html }]` |

`diff_html` is pre-rendered word-level diff markup — output it with the `safe`
filter: `{{ f.diff_html | safe }}`. All other `{{ ... }}` is HTML-escaped.

## Looking up related records

`lookup(folder, match_field, match_value, return_field)` finds the first record
in `folder` (within this connection) whose `match_field` equals `match_value`,
and returns its `return_field`. Both fields are dotted paths. It's a literal
scan — you say exactly where to look, what to match, and what to read; the engine
assumes nothing.

```
{# Shopify product image — in Product Media, where id == featuredMedia.id #}
{% set img = lookup("Product Media", "id", data.featuredMedia.id, "image.url") %}
{% if img %}<img src="{{ img }}">{% endif %}

{# Webflow author name from the Authors collection #}
{{ lookup("Whalesync Live Site/Collections/Authors", "id", data.fieldData.author, "fieldData.name") }}
```

`folder` is the exact connection-relative folder path (the same id can live in
two folders, so be specific). Returns empty if nothing matches.

## Highlighting edits in place

`mark(working, published)` renders an HTML field with the runs that differ from
its published version wrapped in `<mark class="pk-change">` — word-level edits
highlighted exactly where they are in the rendered content, and the change
minimap points at each one. Pass a field from `data` and the same field from
`published`:

```
<div class="pub">{{ mark(data.fieldData.body, published.fieldData.body) }}</div>
```

It's HTML-aware (tags are never wrapped) and already safe, so no `| safe`
needed. If `published` is missing or equal, the content renders unchanged. Use
it on HTML body fields; the change minimap (right rail) plots every `.pk-change`.

## Ask the AI

> "Write a proof preview view for WEBFLOW / Blog Posts: the hero image, the title,
>  the author, then the body rendered as HTML."

The AI writes `.scratch/proof/views/WEBFLOW/Blog Posts.preview.html` and the
`custom` toggle shows it immediately.
"#;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ViewMode {
    /// Most-specific-wins: custom if present, else default, else built-in.
    Auto,
    /// Force the workspace default (or built-in), ignoring per-folder views.
    Default,
    /// Force the per-folder/service custom view; `None` if there isn't one.
    Custom,
}

impl ViewMode {
    pub fn parse(raw: &str) -> ViewMode {
        match raw {
            "default" => ViewMode::Default,
            "custom" => ViewMode::Custom,
            _ => ViewMode::Auto,
        }
    }
}

pub struct Resolved {
    pub source: String,
    /// Which file (or "built-in default") is in effect — shown in the UI so you
    /// know what to edit.
    pub label: String,
    pub is_custom: bool,
}

/// The custom candidate files, most specific first. The views tree mirrors the
/// workspace folder structure, so a record in `Scratch Demo/Authors` looks for
/// `<service>/Scratch Demo/Authors.<kind>.html` (real nested directories).
fn custom_candidates(dir: &Path, service: &str, folder: &str, kind: &str) -> [PathBuf; 2] {
    [
        dir.join(service).join(format!("{folder}.{kind}.html")),
        dir.join(format!("{service}.{kind}.html")),
    ]
}

fn default_candidate(dir: &Path, kind: &str) -> PathBuf {
    dir.join(format!("default.{kind}.html"))
}

fn builtin_default(kind: &str) -> &'static str {
    match kind {
        "preview" => DEFAULT_PREVIEW_TEMPLATE,
        _ => DEFAULT_ROW_TEMPLATE,
    }
}

// Per-service default views shipped with the binary (the `.html` files in
// `src/default_views/`, embedded at compile time). They're the bespoke default
// for a content folder, matched by service + the folder's leaf name — so a
// Webflow "Blog Posts" collection gets the blog view regardless of the site's
// folder path. A user file under `.scratch/proof/views/` still overrides them.
const SHOPIFY_PRODUCTS_ROW: &str = include_str!("default_views/shopify.products.row.html");
const SHOPIFY_PRODUCTS_PREVIEW: &str = include_str!("default_views/shopify.products.preview.html");
const WORDPRESS_POSTS_ROW: &str = include_str!("default_views/wordpress.posts.row.html");
const WORDPRESS_POSTS_PREVIEW: &str = include_str!("default_views/wordpress.posts.preview.html");
const WEBFLOW_BLOG_ROW: &str = include_str!("default_views/webflow.blog-posts.row.html");
const WEBFLOW_BLOG_PREVIEW: &str = include_str!("default_views/webflow.blog-posts.preview.html");
const YOUTUBE_VIDEOS_ROW: &str = include_str!("default_views/youtube.videos.row.html");
const YOUTUBE_VIDEOS_PREVIEW: &str = include_str!("default_views/youtube.videos.preview.html");

/// The folder's leaf name — the last path segment (`A/B/Blog Posts` → `Blog Posts`).
fn folder_leaf(folder: &str) -> &str {
    folder.rsplit('/').next().unwrap_or(folder)
}

/// A shipped per-service default view for `(service, folder-leaf, kind)`, if one
/// exists.
fn builtin_service_view(service: &str, folder: &str, kind: &str) -> Option<&'static str> {
    match (service, folder_leaf(folder), kind) {
        ("SHOPIFY", "Products", "row") => Some(SHOPIFY_PRODUCTS_ROW),
        ("SHOPIFY", "Products", "preview") => Some(SHOPIFY_PRODUCTS_PREVIEW),
        ("WORDPRESS", "Posts", "row") => Some(WORDPRESS_POSTS_ROW),
        ("WORDPRESS", "Posts", "preview") => Some(WORDPRESS_POSTS_PREVIEW),
        ("WEBFLOW", "Blog Posts", "row") => Some(WEBFLOW_BLOG_ROW),
        ("WEBFLOW", "Blog Posts", "preview") => Some(WEBFLOW_BLOG_PREVIEW),
        ("YOUTUBE", "Videos", "row") => Some(YOUTUBE_VIDEOS_ROW),
        ("YOUTUBE", "Videos", "preview") => Some(YOUTUBE_VIDEOS_PREVIEW),
        _ => None,
    }
}

fn relative_label(dir: &Path, path: &Path) -> String {
    path.strip_prefix(dir)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Whether a bespoke ("custom") view exists for this record — a user file under
/// `.scratch/proof/views/`, or a shipped per-service default.
pub fn custom_exists(dir: &Path, service: &str, folder: &str, kind: &str) -> bool {
    custom_candidates(dir, service, folder, kind)
        .iter()
        .any(|path| path.exists())
        || builtin_service_view(service, folder, kind).is_some()
}

pub fn resolve(
    dir: &Path,
    service: &str,
    folder: &str,
    kind: &str,
    mode: ViewMode,
) -> Option<Resolved> {
    let read_first_custom = || {
        // A user file under .scratch/proof/views/ wins (exact folder, then service).
        for path in custom_candidates(dir, service, folder, kind) {
            if let Ok(source) = std::fs::read_to_string(&path) {
                return Some(Resolved {
                    source,
                    label: relative_label(dir, &path),
                    is_custom: true,
                });
            }
        }
        // Otherwise a shipped per-service default counts as the bespoke view.
        if let Some(source) = builtin_service_view(service, folder, kind) {
            return Some(Resolved {
                source: source.to_string(),
                label: format!("{service}/{}.{kind}.html (built-in)", folder_leaf(folder)),
                is_custom: true,
            });
        }
        None
    };
    let read_default = || {
        let path = default_candidate(dir, kind);
        if let Ok(source) = std::fs::read_to_string(&path) {
            Resolved {
                source,
                label: format!("default.{kind}.html"),
                is_custom: false,
            }
        } else {
            Resolved {
                source: builtin_default(kind).to_string(),
                label: "built-in default".to_string(),
                is_custom: false,
            }
        }
    };

    match mode {
        ViewMode::Custom => read_first_custom(),
        ViewMode::Default => Some(read_default()),
        ViewMode::Auto => Some(read_first_custom().unwrap_or_else(read_default)),
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Builds an environment configured the way every proof view expects: HTML
/// auto-escaping, plus the `lookup(folder, match_field, match_value,
/// return_field)` function for resolving foreign-key references explicitly. The
/// function reads the current record's connection from the `_conn_dir` context
/// variable, so one environment serves rows from every connection.
fn build_environment(lookup_index: Arc<LookupIndex>) -> Environment<'static> {
    let mut env = Environment::new();
    env.set_auto_escape_callback(|_| AutoEscape::Html);
    env.add_function(
        "lookup",
        move |state: &State,
              folder: String,
              match_field: String,
              match_value: minijinja::Value,
              return_field: String|
              -> minijinja::Value {
            let Some(connection) = state
                .lookup("_conn_dir")
                .and_then(|value| value.as_str().map(|s| s.to_string()))
            else {
                return minijinja::Value::UNDEFINED;
            };
            if match_value.is_undefined() || match_value.is_none() {
                return minijinja::Value::UNDEFINED;
            }
            let match_value_string = match_value
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| match_value.to_string());
            match lookup_index.resolve(
                &connection,
                &folder,
                &match_field,
                &match_value_string,
                &return_field,
            ) {
                Some(value) => minijinja::Value::from_serialize(&value),
                None => minijinja::Value::UNDEFINED,
            }
        },
    );
    // mark(working, published): renders the working HTML with the runs that
    // differ from published wrapped in <mark class="pk-change"> — word-level
    // edits highlighted in place, which the change minimap then points at.
    env.add_function(
        "mark",
        |working: minijinja::Value, published: minijinja::Value| -> minijinja::Value {
            let to_string = |value: &minijinja::Value| -> String {
                if value.is_undefined() || value.is_none() {
                    String::new()
                } else if let Some(text) = value.as_str() {
                    text.to_string()
                } else {
                    value.to_string()
                }
            };
            let working_html = to_string(&working);
            // No published counterpart (or unchanged) → render the content as-is.
            if published.is_undefined() || published.is_none() {
                return minijinja::Value::from_safe_string(working_html);
            }
            let published_html = to_string(&published);
            if published_html == working_html {
                return minijinja::Value::from_safe_string(working_html);
            }
            minijinja::Value::from_safe_string(diff::mark_changes(&published_html, &working_html))
        },
    );
    env
}

fn render_source(
    source: &str,
    context: &Value,
    lookup_index: Arc<LookupIndex>,
) -> Result<String, String> {
    let mut env = build_environment(lookup_index);
    env.add_template_owned("view", source.to_string())
        .map_err(|error| format!("{error:#}"))?;
    let template = env
        .get_template("view")
        .map_err(|error| format!("{error:#}"))?;
    template
        .render(context)
        .map_err(|error| format!("{error:#}"))
}

fn error_box(kind: &str, message: &str) -> String {
    format!(
        "<div class=\"tpl-error\"><b>{} view error</b><pre>{}</pre></div>",
        diff::html_escape(kind),
        diff::html_escape(message)
    )
}

fn placeholder_no_custom(record: &Record) -> String {
    format!(
        "<div class=\"card-head\"><div class=\"card-title\">{title}</div></div>\
         <div class=\"card-empty\">No custom preview view for <b>{service} / {folder}</b> yet.<br><br>\
         Create <code>.scratch/proof/views/{service}/{folder}.preview.html</code> — or ask the AI: \
         <i>\"write a proof preview view for {service} {folder}\"</i>.</div>",
        title = diff::html_escape(&record.display_title),
        service = diff::html_escape(&record.service),
        folder = diff::html_escape(&record.folder),
    )
}

/// Renders all list rows. Caches the compiled `Auto` view per `(service,
/// folder)` for the duration of one page render (rows never use the toggle). A
/// view that fails to compile/render shows an inline error box instead of taking
/// down the page.
pub struct RowRenderer {
    views_dir: PathBuf,
    env: Environment<'static>,
    compiled: HashMap<(String, String), Result<String, String>>,
    counter: usize,
}

impl RowRenderer {
    pub fn new(views_dir: &Path, lookup_index: Arc<LookupIndex>) -> Self {
        Self {
            views_dir: views_dir.to_path_buf(),
            env: build_environment(lookup_index),
            compiled: HashMap::new(),
            counter: 0,
        }
    }

    pub fn render_row(&mut self, record: &Record) -> String {
        let compiled_name = self.compiled_row_name(&record.service, &record.folder);
        match compiled_name {
            Ok(name) => match self
                .env
                .get_template(&name)
                .and_then(|template| template.render(row_context(record)))
            {
                Ok(html) => html,
                Err(error) => error_box("row", &format!("{error:#}")),
            },
            Err(error) => error_box("row", &error),
        }
    }

    fn compiled_row_name(&mut self, service: &str, folder: &str) -> Result<String, String> {
        let key = (service.to_string(), folder.to_string());
        if let Some(result) = self.compiled.get(&key) {
            return result.clone();
        }
        let resolved = resolve(&self.views_dir, service, folder, "row", ViewMode::Auto)
            .expect("Auto always resolves");
        let name = format!("row{}", self.counter);
        self.counter += 1;
        let result = match self.env.add_template_owned(name.clone(), resolved.source) {
            Ok(()) => Ok(name),
            Err(error) => Err(format!("{error:#}")),
        };
        self.compiled.insert(key, result.clone());
        result
    }
}

/// What the preview pane needs to render one record's card plus its toggle.
pub struct PreviewRender {
    pub html: String,
    pub label: String,
    pub is_custom: bool,
    pub custom_available: bool,
}

pub fn render_preview(
    views_dir: &Path,
    record: &Record,
    mode: ViewMode,
    lookup_index: Arc<LookupIndex>,
) -> PreviewRender {
    let custom_available = custom_exists(views_dir, &record.service, &record.folder, "preview");
    match resolve(views_dir, &record.service, &record.folder, "preview", mode) {
        Some(resolved) => {
            let html = match render_source(&resolved.source, &preview_context(record), lookup_index)
            {
                Ok(html) => html,
                Err(error) => error_box("preview", &error),
            };
            PreviewRender {
                html,
                label: resolved.label,
                is_custom: resolved.is_custom,
                custom_available,
            }
        }
        None => PreviewRender {
            html: placeholder_no_custom(record),
            label: "no custom preview yet".to_string(),
            is_custom: false,
            custom_available: false,
        },
    }
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

fn base_context(record: &Record) -> Value {
    json!({
        "title": record.display_title,
        "summary": record.summary.clone().unwrap_or_default(),
        "record": record.record_file_stem,
        "folder": record.folder,
        "service": record.service,
        "connection": record.connection_display_name,
        "path": record.path,
        "state": record.state.label(),
        "changed": record.state.is_changed(),
        "added": record.state == crate::workspace::ChangeState::Added,
        "deleted": record.state == crate::workspace::ChangeState::Deleted,
        "unreviewed": record.state == crate::workspace::ChangeState::Unreviewed,
        "unpublished": record.state == crate::workspace::ChangeState::Unpublished,
        "field_count": record.field_changes.len(),
        "data": record.data.as_ref().map(|data| (**data).clone()).unwrap_or(Value::Null),
        // The published record, mirroring `data`'s shape — pass a field from each
        // to `mark()` to highlight that field's word-level edits in place.
        "published": record.published_data.as_ref().map(|data| (**data).clone()).unwrap_or(Value::Null),
        // Used by the `lookup` function to scope resolution to this record's
        // connection; underscored so views treat it as internal.
        "_conn_dir": record.connection_dir_name,
    })
}

pub fn row_context(record: &Record) -> Value {
    base_context(record)
}

pub fn preview_context(record: &Record) -> Value {
    let mut context = base_context(record);

    let changed_fields: HashMap<&str, &crate::workspace::FieldChange> = record
        .field_changes
        .iter()
        .map(|change| (change.field.as_str(), change))
        .collect();

    // Every field in its natural (stable) position, changed ones marked in place
    // and rendered as word-level diffs — so a long record's changes stay where
    // they are in the file, which is what the change minimap maps.
    let mut fields: Vec<Value> = Vec::new();
    for (key, value) in &record.flat_fields {
        match changed_fields.get(key.as_str()) {
            Some(change) => {
                let published = change.published_value.clone().unwrap_or_default();
                let working = change.working_value.clone().unwrap_or_default();
                fields.push(json!({
                    "key": key,
                    "value": working,
                    "changed": true,
                    "diff_html": diff::inline_word_diff(&published, &working),
                }));
            }
            None => fields.push(json!({
                "key": key,
                "value": value,
                "changed": false,
                "diff_html": "",
            })),
        }
    }
    // Fields that were removed entirely (present in the published record, gone
    // from working) won't appear above — surface them at the end.
    for change in &record.field_changes {
        if record
            .flat_fields
            .iter()
            .all(|(key, _)| key != &change.field)
        {
            let published = change.published_value.clone().unwrap_or_default();
            let working = change.working_value.clone().unwrap_or_default();
            fields.push(json!({
                "key": change.field,
                "value": working,
                "changed": true,
                "diff_html": diff::inline_word_diff(&published, &working),
            }));
        }
    }

    let changes: Vec<Value> = record
        .field_changes
        .iter()
        .map(|change| {
            let published = change.published_value.clone().unwrap_or_default();
            let working = change.working_value.clone().unwrap_or_default();
            json!({
                "field": change.field,
                "published": published,
                "working": working,
                "diff_html": diff::inline_word_diff(&published, &working),
            })
        })
        .collect();

    if let Value::Object(map) = &mut context {
        map.insert(
            "has_changes".into(),
            json!(!record.field_changes.is_empty()),
        );
        map.insert("fields".into(), Value::Array(fields));
        map.insert("changes".into(), Value::Array(changes));
    }
    context
}

/// Seeds `default.row.html`, `default.preview.html`, and a `README.md` into the
/// views dir on first run, so there's something to look at and edit.
pub fn ensure_seeded(views_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(views_dir)?;
    let seeds = [
        ("default.row.html", DEFAULT_ROW_TEMPLATE),
        ("default.preview.html", DEFAULT_PREVIEW_TEMPLATE),
        ("README.md", VIEWS_README),
    ];
    for (filename, contents) in seeds {
        let path = views_dir.join(filename);
        if !path.exists() {
            std::fs::write(&path, contents)?;
        }
    }
    Ok(())
}
