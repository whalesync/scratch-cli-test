//! Shopify verbatim-format data migration transform (DEV-10637).
//!
//! Pure, idempotent Rust port of the TypeScript reference transform at
//! `server/src/remote-service/connectors/library/shopify/shopify-verbatim-migration.ts`.
//! It rewrites an already-pulled Shopify record so it matches what a fresh pull
//! now produces under the Connector Prime Directive (data stored VERBATIM). Two
//! historical reshapes are undone:
//!
//!   1. SEO metafields (articles / pages / blogs): the old pull synthesized a
//!      `seo: { title, description }` object from the `global.title_tag` /
//!      `global.description_tag` metafields. The connector now lands those
//!      metafields verbatim as `seoTitle` / `seoDescription`, each shaped
//!      `{ value }`. This converts `seo` → `seoTitle` / `seoDescription`.
//!   2. File images: the old `listFiles` flattened a MediaImage's nested
//!      `image { url … }` into a top-level `url`. The connector now yields the
//!      node verbatim. This re-nests a MediaImage's top-level `url` back under
//!      `image`. NOTE: `altText` / `width` / `height` were LOST at pull time and
//!      cannot be recovered here — only a re-pull restores them. This migration
//!      only restores the container shape (`{ url }`).
//!
//! [`migrate_shopify_record_to_verbatim_format`] takes ownership of a parsed
//! record object and returns a possibly-rewritten object plus a `changed` flag.
//! It is idempotent: running it again on an already-migrated record is a no-op
//! (`changed == false`), and JSON key order is preserved otherwise (this crate's
//! `serde_json` has `preserve_order` enabled, so [`JsonMap`] keeps insertion
//! order). The seo/image logic mirrors the connector exactly so the migration
//! and a fresh pull converge on the same on-disk shape.

use serde_json::{Map as JsonMap, Value as JsonValue};

/// Entity types whose SEO metafields were historically reshaped into a synthetic
/// `seo` object and now land verbatim as `seoTitle` / `seoDescription`. Mirrors
/// `SEO_METAFIELD_ENTITIES` in `shopify-api-client.ts`.
pub const SEO_METAFIELD_ENTITY_TYPES: [&str; 3] = ["articles", "pages", "blogs"];

/// GraphQL id fragment that identifies a MediaImage file node.
const MEDIA_IMAGE_ID_MARKER: &str = "/MediaImage/";

/// Outcome of running the verbatim transform over a single record: whether the
/// record was rewritten, and the (possibly unchanged) record object.
pub struct ShopifyVerbatimMigrationOutcome {
    pub changed: bool,
    pub record: JsonMap<String, JsonValue>,
}

/// Convert a single already-pulled Shopify record into the verbatim on-disk
/// format a fresh pull now produces, dispatching on `entity_type`. Pure and
/// idempotent — see the module docs.
pub fn migrate_shopify_record_to_verbatim_format(
    record: JsonMap<String, JsonValue>,
    entity_type: &str,
) -> ShopifyVerbatimMigrationOutcome {
    if SEO_METAFIELD_ENTITY_TYPES.contains(&entity_type) {
        migrate_seo_metafield_record(record)
    } else if entity_type == "files" {
        migrate_file_record(record)
    } else {
        // Products, collections, and every other entity are already verbatim.
        ShopifyVerbatimMigrationOutcome {
            changed: false,
            record,
        }
    }
}

/// articles / pages / blogs: `seo: { title, description }` → verbatim
/// `seoTitle` / `seoDescription`, matching a fresh pull EXACTLY. Idempotent:
/// absent `seo`, or an already-present `seoTitle`, means the record is already
/// migrated.
fn migrate_seo_metafield_record(
    record: JsonMap<String, JsonValue>,
) -> ShopifyVerbatimMigrationOutcome {
    if !record.contains_key("seo") || record.contains_key("seoTitle") {
        return ShopifyVerbatimMigrationOutcome {
            changed: false,
            record,
        };
    }

    // `seo` is expected to be an object or null; anything else is treated the
    // same way the TS reference does (a missing/non-string title yields null).
    let seo_object = match record.get("seo") {
        Some(JsonValue::Object(object)) => Some(object.clone()),
        _ => None,
    };

    // Rebuild the record without `seo`, preserving key order otherwise, then
    // append the two verbatim metafield keys (matching a fresh pull's shape).
    let mut migrated = JsonMap::new();
    for (key, value) in &record {
        if key == "seo" {
            continue;
        }
        migrated.insert(key.clone(), value.clone());
    }

    let (seo_title, seo_description) = match seo_object {
        Some(object) => (
            seo_metafield_value(object.get("title")),
            seo_metafield_value(object.get("description")),
        ),
        // `seo === null` (or any non-object): both metafields are null.
        None => (JsonValue::Null, JsonValue::Null),
    };
    migrated.insert("seoTitle".to_string(), seo_title);
    migrated.insert("seoDescription".to_string(), seo_description);

    ShopifyVerbatimMigrationOutcome {
        changed: true,
        record: migrated,
    }
}

/// `value != null ? { "value": value } : null` — the verbatim metafield shape.
/// Mirrors the TS `seo.title != null ? { value: seo.title } : null` for both
/// title and description.
fn seo_metafield_value(raw: Option<&JsonValue>) -> JsonValue {
    match raw {
        Some(value) if !value.is_null() => {
            let mut wrapped = JsonMap::new();
            wrapped.insert("value".to_string(), value.clone());
            JsonValue::Object(wrapped)
        }
        _ => JsonValue::Null,
    }
}

/// files: re-nest a MediaImage's flattened top-level `url` back under
/// `image: { url }`, matching a fresh pull's container shape. Only touches
/// MediaImage nodes (detected via `mediaContentType == "IMAGE"` OR a
/// `/MediaImage/` id) that have a top-level string `url` and no existing
/// (non-null) `image`. GenericFile / Video / ExternalVideo (which legitimately
/// carry a top-level `url` and no `image`) are left untouched, as is any record
/// that already has an `image`.
fn migrate_file_record(record: JsonMap<String, JsonValue>) -> ShopifyVerbatimMigrationOutcome {
    let record_id = record.get("id").and_then(JsonValue::as_str).unwrap_or("");
    let is_media_image = record.get("mediaContentType").and_then(JsonValue::as_str)
        == Some("IMAGE")
        || record_id.contains(MEDIA_IMAGE_ID_MARKER);
    let top_level_url = match record.get("url") {
        Some(JsonValue::String(url)) => Some(url.clone()),
        _ => None,
    };
    // `'image' in record && record.image != null`
    let has_existing_image = record
        .get("image")
        .map(|value| !value.is_null())
        .unwrap_or(false);

    let (Some(url), true, false) = (top_level_url, is_media_image, has_existing_image) else {
        return ShopifyVerbatimMigrationOutcome {
            changed: false,
            record,
        };
    };

    // Rebuild without the top-level `url`, preserving key order, then set
    // `image = { url }`.
    let mut migrated = JsonMap::new();
    for (key, value) in &record {
        if key == "url" {
            continue;
        }
        migrated.insert(key.clone(), value.clone());
    }
    let mut image = JsonMap::new();
    image.insert("url".to_string(), JsonValue::String(url));
    migrated.insert("image".to_string(), JsonValue::Object(image));

    ShopifyVerbatimMigrationOutcome {
        changed: true,
        record: migrated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Parse a `json!` value into the record object shape the transform takes.
    fn object(value: JsonValue) -> JsonMap<String, JsonValue> {
        match value {
            JsonValue::Object(map) => map,
            _ => panic!("test fixture must be a JSON object"),
        }
    }

    fn migrate(value: JsonValue, entity_type: &str) -> ShopifyVerbatimMigrationOutcome {
        migrate_shopify_record_to_verbatim_format(object(value), entity_type)
    }

    // ── SEO metafield entities (articles / pages / blogs) ───────────────────

    #[test]
    fn seo_full_object_becomes_wrapped_title_and_description() {
        let outcome = migrate(
            json!({ "id": "gid://shopify/Article/1", "seo": { "title": "T", "description": "D" } }),
            "articles",
        );
        assert!(outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({
                "id": "gid://shopify/Article/1",
                "seoTitle": { "value": "T" },
                "seoDescription": { "value": "D" },
            })
        );
    }

    #[test]
    fn seo_partial_object_nulls_the_missing_side() {
        // title present, description missing → description null.
        let outcome = migrate(json!({ "seo": { "title": "Only title" } }), "pages");
        assert!(outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({ "seoTitle": { "value": "Only title" }, "seoDescription": null })
        );
    }

    #[test]
    fn seo_explicit_null_field_becomes_null_metafield() {
        // A present-but-null title is treated as absent (→ null), not wrapped.
        let outcome = migrate(
            json!({ "seo": { "title": null, "description": "D" } }),
            "blogs",
        );
        assert!(outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({ "seoTitle": null, "seoDescription": { "value": "D" } })
        );
    }

    #[test]
    fn seo_null_object_nulls_both_metafields() {
        let outcome = migrate(json!({ "id": "a", "seo": null }), "articles");
        assert!(outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({ "id": "a", "seoTitle": null, "seoDescription": null })
        );
    }

    #[test]
    fn seo_absent_is_a_no_op() {
        let outcome = migrate(json!({ "id": "a", "title": "Hello" }), "articles");
        assert!(!outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({ "id": "a", "title": "Hello" })
        );
    }

    #[test]
    fn seo_already_migrated_record_is_idempotent() {
        // seoTitle already present → leave untouched even though `seo` lingers.
        let already = json!({ "seoTitle": { "value": "T" }, "seoDescription": null, "seo": { "title": "T" } });
        let outcome = migrate(already.clone(), "articles");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), already);
    }

    #[test]
    fn seo_migration_preserves_surrounding_key_order() {
        let outcome = migrate(
            json!({ "a": 1, "seo": { "title": "T", "description": "D" }, "z": 2 }),
            "pages",
        );
        assert!(outcome.changed);
        // `seo` is removed in place; the two metafields append at the end.
        let keys: Vec<&String> = outcome.record.keys().collect();
        assert_eq!(keys, vec!["a", "z", "seoTitle", "seoDescription"]);
    }

    #[test]
    fn seo_does_not_mutate_the_returned_record_on_no_op() {
        // A no-op returns the record unchanged (no accidental key injection).
        let outcome = migrate(json!({ "id": "a" }), "articles");
        assert!(!outcome.changed);
        assert!(!outcome.record.contains_key("seoTitle"));
        assert!(!outcome.record.contains_key("seoDescription"));
    }

    // ── files: MediaImage re-nesting ────────────────────────────────────────

    #[test]
    fn file_media_image_detected_by_media_content_type() {
        let outcome = migrate(
            json!({ "id": "gid://shopify/GenericFile/9", "mediaContentType": "IMAGE", "url": "https://cdn/x.png" }),
            "files",
        );
        assert!(outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({
                "id": "gid://shopify/GenericFile/9",
                "mediaContentType": "IMAGE",
                "image": { "url": "https://cdn/x.png" },
            })
        );
    }

    #[test]
    fn file_media_image_detected_by_id_marker() {
        // No mediaContentType, but the id carries the /MediaImage/ fragment.
        let outcome = migrate(
            json!({ "id": "gid://shopify/MediaImage/42", "url": "https://cdn/y.jpg" }),
            "files",
        );
        assert!(outcome.changed);
        assert_eq!(
            JsonValue::Object(outcome.record),
            json!({ "id": "gid://shopify/MediaImage/42", "image": { "url": "https://cdn/y.jpg" } })
        );
    }

    #[test]
    fn file_media_image_migration_preserves_key_order() {
        let outcome = migrate(
            json!({ "id": "gid://shopify/MediaImage/1", "url": "u", "alt": "a" }),
            "files",
        );
        assert!(outcome.changed);
        let keys: Vec<&String> = outcome.record.keys().collect();
        // `url` removed in place; `image` appended at the end.
        assert_eq!(keys, vec!["id", "alt", "image"]);
    }

    #[test]
    fn file_generic_file_with_top_level_url_is_untouched() {
        // GenericFile / Video legitimately carry a top-level url and no image.
        let generic = json!({ "id": "gid://shopify/GenericFile/9", "mediaContentType": "FILE", "url": "https://cdn/doc.pdf" });
        let outcome = migrate(generic.clone(), "files");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), generic);
    }

    #[test]
    fn file_video_with_top_level_url_is_untouched() {
        let video = json!({ "id": "gid://shopify/Video/3", "mediaContentType": "VIDEO", "url": "https://cdn/v.mp4" });
        let outcome = migrate(video.clone(), "files");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), video);
    }

    #[test]
    fn file_media_image_with_existing_image_is_skipped() {
        let already = json!({ "id": "gid://shopify/MediaImage/1", "image": { "url": "https://cdn/z.png", "altText": "z" } });
        let outcome = migrate(already.clone(), "files");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), already);
    }

    #[test]
    fn file_media_image_without_top_level_url_is_skipped() {
        let no_url = json!({ "id": "gid://shopify/MediaImage/1", "mediaContentType": "IMAGE" });
        let outcome = migrate(no_url.clone(), "files");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), no_url);
    }

    #[test]
    fn file_media_image_with_non_string_url_is_skipped() {
        let numeric_url = json!({ "id": "gid://shopify/MediaImage/1", "url": 123 });
        let outcome = migrate(numeric_url.clone(), "files");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), numeric_url);
    }

    #[test]
    fn file_migration_is_idempotent_on_second_run() {
        let first = migrate(
            json!({ "id": "gid://shopify/MediaImage/1", "url": "u" }),
            "files",
        );
        assert!(first.changed);
        let second = migrate_shopify_record_to_verbatim_format(first.record.clone(), "files");
        assert!(!second.changed);
        assert_eq!(first.record, second.record);
    }

    // ── other entity types are untouched ────────────────────────────────────

    #[test]
    fn products_with_a_seo_key_are_left_untouched() {
        // Products carry their own `seo` shape verbatim — the migration must NOT
        // reshape it (only articles/pages/blogs get the seo transform).
        let product =
            json!({ "id": "gid://shopify/Product/1", "seo": { "title": "P", "description": "D" } });
        let outcome = migrate(product.clone(), "products");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), product);
    }

    #[test]
    fn collections_with_a_top_level_url_are_left_untouched() {
        let collection = json!({ "id": "gid://shopify/Collection/1", "url": "https://cdn/c" });
        let outcome = migrate(collection.clone(), "collections");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), collection);
    }

    #[test]
    fn unknown_entity_type_is_left_untouched() {
        let record = json!({ "seo": { "title": "T" }, "url": "u" });
        let outcome = migrate(record.clone(), "product-variants");
        assert!(!outcome.changed);
        assert_eq!(JsonValue::Object(outcome.record), record);
    }
}
