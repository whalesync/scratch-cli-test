use crate::traits::{ValidateContext, ValidationIssue, Validator};

/// Rejects changes to protected fields.
///
/// Configure with `options.fields`: an array of field names that cannot change.
/// Compares `record` against `original_record` for those fields.
///
/// Skipped when `original_record` is `None` (new record — nothing to compare)
/// or when no fields are configured.
pub struct ReadonlyFieldsValidator;

impl Validator for ReadonlyFieldsValidator {
    fn name(&self) -> &str {
        "readonly_fields"
    }

    fn validate(&self, ctx: &ValidateContext) -> Vec<ValidationIssue> {
        let Some(ref original) = ctx.original_record else {
            return vec![];
        };

        let Some(fields) = ctx.options.get("fields").and_then(|v| v.as_array()) else {
            return vec![];
        };

        let mut issues = Vec::new();
        for item in fields {
            let Some(field) = item.as_str() else {
                continue;
            };
            if original.get(field) != ctx.record.get(field) {
                issues.push(ValidationIssue {
                    path: format!("/{field}"),
                    message: format!("Field '{field}' is readonly and cannot be changed"),
                    warning: false,
                });
            }
        }
        issues
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::HashMap;

    fn ctx(record: Value, original: Option<Value>, options: HashMap<String, Value>) -> ValidateContext {
        ValidateContext {
            record,
            original_record: original,
            schema: None,
            folder_records: HashMap::new(),
            options,
            file_path: "/test/record.json".into(),
        }
    }

    fn opts(fields: &[&str]) -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("fields".into(), json!(fields));
        m
    }

    #[test]
    fn no_original_skips() {
        let v = ReadonlyFieldsValidator;
        let c = ctx(json!({"id": "changed"}), None, opts(&["id"]));
        assert!(v.validate(&c).is_empty());
    }

    #[test]
    fn unchanged_field_passes() {
        let v = ReadonlyFieldsValidator;
        let c = ctx(
            json!({"id": "abc", "name": "New"}),
            Some(json!({"id": "abc", "name": "Old"})),
            opts(&["id"]),
        );
        assert!(v.validate(&c).is_empty());
    }

    #[test]
    fn changed_field_errors() {
        let v = ReadonlyFieldsValidator;
        let c = ctx(
            json!({"id": "new_id", "name": "Alice"}),
            Some(json!({"id": "old_id", "name": "Alice"})),
            opts(&["id"]),
        );
        let issues = v.validate(&c);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, "/id");
        assert!(issues[0].message.contains("readonly"));
    }

    #[test]
    fn no_fields_configured_passes() {
        let v = ReadonlyFieldsValidator;
        let c = ctx(
            json!({"name": "New"}),
            Some(json!({"name": "Old"})),
            HashMap::new(),
        );
        assert!(v.validate(&c).is_empty());
    }

    #[test]
    fn multiple_fields() {
        let v = ReadonlyFieldsValidator;
        let c = ctx(
            json!({"id": "new", "slug": "new-slug", "name": "Same"}),
            Some(json!({"id": "old", "slug": "old-slug", "name": "Same"})),
            opts(&["id", "slug"]),
        );
        let issues = v.validate(&c);
        assert_eq!(issues.len(), 2);
    }
}
