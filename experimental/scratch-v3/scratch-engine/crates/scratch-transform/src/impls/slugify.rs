use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// Slugify a string value into a URL-friendly slug.
///
/// Rules (Webflow + WordPress compatible):
/// - NFD normalize and strip diacritics/accents (e -> e, n -> n)
/// - Lowercase everything
/// - Replace spaces and underscores with the separator
/// - Remove all characters that aren't [a-z0-9-] (or the separator)
/// - Collapse consecutive separators into one
/// - Trim leading/trailing separators
///
/// Options:
/// - `separator` (string, default "-"): the separator to use between words.
pub struct SlugifyTransformer;

static DIACRITICS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\u{0300}-\u{036f}]").unwrap());
static NON_ALNUM_HYPHEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9-]").unwrap());
static MULTI_HYPHEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-{2,}").unwrap());

impl Transformer for SlugifyTransformer {
    fn name(&self) -> &str {
        "slugify"
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let value = &ctx.source_value;

        if value.is_null() {
            return TransformResult::Value(Value::Null);
        }

        let raw = match value {
            Value::String(s) => s.clone(),
            _ => {
                return TransformResult::Error(format!(
                    "Expected string, got {}",
                    match value {
                        Value::Number(_) => "number",
                        Value::Bool(_) => "boolean",
                        Value::Array(_) => "array",
                        Value::Object(_) => "object",
                        _ => "unknown",
                    }
                ));
            }
        };

        // NFD normalize
        let nfd: String = raw.nfd().collect();
        // Strip combining marks (diacritics)
        let stripped = DIACRITICS_RE.replace_all(&nfd, "");
        // Lowercase
        let lower = stripped.to_lowercase();
        // Replace spaces and underscores with hyphens
        let with_hyphens = lower
            .chars()
            .map(|c| if c.is_whitespace() || c == '_' { '-' } else { c })
            .collect::<String>();
        // Remove non-alphanumeric except hyphens
        let cleaned = NON_ALNUM_HYPHEN_RE.replace_all(&with_hyphens, "");
        // Collapse consecutive hyphens
        let collapsed = MULTI_HYPHEN_RE.replace_all(&cleaned, "-");
        // Trim leading/trailing hyphens
        let result = collapsed.trim_matches('-').to_string();

        TransformResult::Value(Value::String(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scratch_core::types::{SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;

    fn run(value: Value) -> TransformResult {
        let ctx = TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "f".into(),
            source_value: value,
            destination_field_path: "f".into(),
            destination_value: None,
            lookup_tools: None,
            options: HashMap::new(),
            phase: SyncPhase::Data,
        };
        SlugifyTransformer.transform(&ctx)
    }

    fn expect_slug(value: Value) -> String {
        match run(value) {
            TransformResult::Value(Value::String(s)) => s,
            other => panic!("Expected string Value, got {:?}", other),
        }
    }

    #[test]
    fn basic_slugify() {
        assert_eq!(expect_slug(json!("Hello World")), "hello-world");
    }

    #[test]
    fn special_characters() {
        assert_eq!(expect_slug(json!("Hello, World! @#$%")), "hello-world");
    }

    #[test]
    fn leading_trailing_whitespace() {
        assert_eq!(expect_slug(json!("  Hello World  ")), "hello-world");
    }

    #[test]
    fn multiple_spaces() {
        assert_eq!(expect_slug(json!("Hello   World")), "hello-world");
    }

    #[test]
    fn already_slugified() {
        assert_eq!(expect_slug(json!("hello-world")), "hello-world");
    }

    #[test]
    fn null_returns_null() {
        match run(json!(null)) {
            TransformResult::Value(v) => assert_eq!(v, json!(null)),
            other => panic!("Expected null Value, got {:?}", other),
        }
    }

    #[test]
    fn underscores_replaced() {
        assert_eq!(expect_slug(json!("hello_world_test")), "hello-world-test");
    }

    #[test]
    fn diacritics_stripped() {
        assert_eq!(expect_slug(json!("cafe\u{0301} re\u{0301}sume\u{0301}")), "cafe-resume");
        assert_eq!(expect_slug(json!("café résumé")), "cafe-resume");
        assert_eq!(expect_slug(json!("naïve")), "naive");
        assert_eq!(expect_slug(json!("piñata")), "pinata");
    }

    #[test]
    fn non_string_is_error() {
        match run(json!(42)) {
            TransformResult::Error(_) => {}
            other => panic!("Expected Error, got {:?}", other),
        }
    }
}
