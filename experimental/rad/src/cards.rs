//! Preview-card templates.
//!
//! A card template is a declarative file describing how to render a record of a
//! given service/folder as a near-published card (an archetype: product, video,
//! article, …) by mapping record field-paths to card slots. Templates live as
//! editable JSON in the workspace's `.scratch/rad/cards/` — never in the
//! publishable connection folders — so they round-trip through git and a user
//! (or Claude) can tweak them and Rad hot-reloads on the next render.
//!
//! Rad ships defaults and seeds them on startup (only if absent, so user edits
//! are never clobbered).

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct CardMatch {
    #[serde(default)]
    pub service: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CardTemplate {
    /// Which records this template applies to. Absent / empty = matches any.
    #[serde(rename = "match", default)]
    pub matcher: Option<CardMatch>,
    /// product | video | article | social | serp | generic
    pub archetype: String,
    /// slot name -> ordered list of record field-paths (first that resolves wins)
    #[serde(default)]
    pub slots: BTreeMap<String, Vec<String>>,
    /// Aligned data columns shown in the List row, in order. Same-folder rows
    /// share these, so the values line up vertically for scanning.
    #[serde(default)]
    pub columns: Vec<RowColumn>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RowColumn {
    /// Ordered field-paths; the first that resolves on a record is shown.
    pub fields: Vec<String>,
    /// Fixed column width in px so the column aligns down the folder.
    #[serde(default)]
    pub width: Option<u32>,
}

impl CardTemplate {
    fn specificity(&self) -> u8 {
        match &self.matcher {
            Some(m) => m.service.is_some() as u8 + m.folder.is_some() as u8,
            None => 0,
        }
    }

    pub fn matches(&self, service: &str, folder: &str) -> bool {
        match &self.matcher {
            None => true,
            Some(m) => {
                m.service
                    .as_deref()
                    .is_none_or(|s| s.eq_ignore_ascii_case(service))
                    && m.folder.as_deref().is_none_or(|f| f == folder)
            }
        }
    }
}

fn cards_dir(workspace_dir: &Path) -> std::path::PathBuf {
    workspace_dir.join(".scratch").join("rad").join("cards")
}

/// Writes the built-in default templates into `.scratch/rad/cards/`, skipping
/// any that already exist (so user/AI edits are preserved).
pub fn seed_defaults(workspace_dir: &Path) {
    let dir = cards_dir(workspace_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    for (filename, contents) in DEFAULT_TEMPLATES {
        let path = dir.join(filename);
        if !path.exists() {
            let _ = std::fs::write(&path, contents);
        }
    }
}

pub fn load_templates(workspace_dir: &Path) -> Vec<CardTemplate> {
    let dir = cards_dir(workspace_dir);
    let mut templates = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(template) = serde_json::from_str::<CardTemplate>(&text) {
                        templates.push(template);
                    }
                }
            }
        }
    }
    templates
}

/// A template file's raw text plus its parsed form (or the parse error), for
/// the in-app template studio.
pub struct TemplateSource {
    pub filename: String,
    pub raw: String,
    pub error: Option<String>,
}

/// Reads every template file with its raw text, so the editor can show and save
/// exactly what's on disk.
pub fn load_template_sources(workspace_dir: &Path) -> Vec<TemplateSource> {
    let dir = cards_dir(workspace_dir);
    let mut sources = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut paths: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        paths.sort();
        for path in paths {
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            let error = serde_json::from_str::<CardTemplate>(&raw)
                .err()
                .map(|parse_error| parse_error.to_string());
            sources.push(TemplateSource {
                filename,
                raw,
                error,
            });
        }
    }
    sources
}

/// Validates and writes a template file. Refuses anything but a plain `*.json`
/// name inside `.scratch/rad/cards/` (no path traversal), and only writes if the
/// contents parse as a template — so a bad edit can't corrupt a template or
/// escape the folder.
pub fn save_template(workspace_dir: &Path, filename: &str, contents: &str) -> Result<(), String> {
    if !filename.ends_with(".json")
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Invalid template filename.".to_string());
    }
    serde_json::from_str::<CardTemplate>(contents).map_err(|e| format!("Invalid template: {e}"))?;
    let dir = cards_dir(workspace_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return Err("Couldn't access the templates folder.".to_string());
    }
    std::fs::write(dir.join(filename), contents).map_err(|e| e.to_string())
}

/// The most specific template whose match applies to this record.
pub fn match_template<'a>(
    templates: &'a [CardTemplate],
    service: &str,
    folder: &str,
) -> Option<&'a CardTemplate> {
    templates
        .iter()
        .filter(|t| t.matches(service, folder))
        .max_by_key(|t| t.specificity())
}

const DEFAULT_TEMPLATES: &[(&str, &str)] = &[
    (
        "youtube.json",
        r#"{
  "name": "youtube-video",
  "match": { "service": "YOUTUBE" },
  "archetype": "video",
  "slots": {
    "image": ["snippet.thumbnails.high.url", "snippet.thumbnails.medium.url", "snippet.thumbnails.default.url"],
    "title": ["snippet.title", "title"],
    "subtitle": ["snippet.channelTitle"],
    "badge": ["contentDetails.duration"],
    "body": ["snippet.description"]
  },
  "columns": [
    { "fields": ["snippet.channelTitle"], "width": 130 },
    { "fields": ["statistics.viewCount"], "width": 78 },
    { "fields": ["snippet.publishedAt"], "width": 96 }
  ]
}
"#,
    ),
    (
        "wordpress.json",
        r#"{
  "name": "wordpress-article",
  "match": { "service": "WORDPRESS" },
  "archetype": "article",
  "slots": {
    "title": ["title.rendered", "title.raw", "title"],
    "body": ["excerpt.rendered", "content.rendered", "content.raw"],
    "badge": ["status"]
  },
  "columns": [
    { "fields": ["status"], "width": 86 },
    { "fields": ["date", "date_gmt"], "width": 110 }
  ]
}
"#,
    ),
    (
        "shopify-product.json",
        r#"{
  "name": "shopify-product",
  "match": { "service": "SHOPIFY", "folder": "Products" },
  "archetype": "product",
  "slots": {
    "image": ["featuredMedia.id", "featuredImage.url", "image.src"],
    "title": ["title"],
    "subtitle": ["productType"],
    "body": ["descriptionPlainSummary", "description", "descriptionHtml", "bodyHtml"],
    "badge": ["status"]
  },
  "columns": [
    { "fields": ["vendor"], "width": 160 },
    { "fields": ["productType", "customProductType"], "width": 96 },
    { "fields": ["totalInventory"], "width": 60 },
    { "fields": ["status"], "width": 74 }
  ]
}
"#,
    ),
    (
        "shopify-article.json",
        r#"{
  "name": "shopify-article",
  "match": { "service": "SHOPIFY", "folder": "Articles" },
  "archetype": "article",
  "slots": {
    "image": ["image.url", "image.src"],
    "title": ["title"],
    "body": ["summaryHtml", "body", "bodyHtml", "contentHtml"],
    "badge": ["isPublished"]
  },
  "columns": [
    { "fields": ["authorV2.name", "author.name"], "width": 140 },
    { "fields": ["isPublished"], "width": 84 }
  ]
}
"#,
    ),
    (
        "airtable.json",
        r#"{
  "name": "airtable-record",
  "match": { "service": "AIRTABLE" },
  "archetype": "generic",
  "slots": {
    "title": ["fields.Name", "fields.Title", "fields.Headline", "fields.Slug"],
    "body": ["fields.Body", "fields.Notes", "fields.Bio", "fields.Summary", "fields.Description", "fields.Content", "fields.Abstract", "fields.Excerpt"]
  }
}
"#,
    ),
    (
        "webflow.json",
        r#"{
  "name": "webflow-item",
  "match": { "service": "WEBFLOW" },
  "archetype": "article",
  "slots": {
    "image": ["fieldData.image.url", "fieldData.main-image.url", "fieldData.thumbnail.url", "fieldData.cover-image.url", "fieldData.featured-image.url", "fieldData.hero-image.url", "fieldData.og-image.url", "fieldData.logo.url", "fieldData.full-logo-white.url", "fieldData.avatar.url", "hostedUrl"],
    "title": ["fieldData.name", "displayName", "name"],
    "body": ["fieldData.body", "fieldData.post-body", "fieldData.content", "fieldData.rich-text", "fieldData.short-description", "fieldData.description", "fieldData.bio", "fieldData.summary", "fieldData.meta-description", "fieldData.text", "fieldData.answer"]
  },
  "columns": [
    { "fields": ["fieldData.slug", "slug", "originalFileName"], "width": 220 },
    { "fields": ["fieldData.published-date", "lastUpdated", "lastPublished", "createdOn"], "width": 110 }
  ]
}
"#,
    ),
    (
        "generic.json",
        r#"{
  "name": "generic",
  "match": {},
  "archetype": "generic",
  "slots": {
    "title": ["title.rendered", "title", "name", "headline"],
    "body": ["content.rendered", "descriptionHtml", "bodyHtml", "description", "body", "excerpt.rendered"]
  }
}
"#,
    ),
];
