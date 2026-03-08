use std::collections::HashMap;

use serde_json::Value;

use crate::traits::{ValidateContext, ValidationIssue, Validator};

/// Validates that `x-scratch-record-ref` fields reference existing records.
///
/// Walks the schema for `x-scratch-record-ref` annotations, then checks that
/// the corresponding field values in the record exist as keys in
/// `ctx.folder_records`.
pub struct RecordRefsValidator;

impl Validator for RecordRefsValidator {
    fn name(&self) -> &str {
        "record_refs"
    }

    fn validate(&self, ctx: &ValidateContext) -> Vec<ValidationIssue> {
        let Some(ref schema) = ctx.schema else {
            return vec![];
        };
        if ctx.folder_records.is_empty() {
            return vec![];
        }

        let mut issues = Vec::new();
        walk_for_refs(
            &ctx.record,
            schema,
            &[],
            &ctx.folder_records,
            &mut issues,
        );
        issues
    }
}

fn walk_for_refs(
    value: &Value,
    schema: &Value,
    path: &[String],
    folder_records: &HashMap<String, Value>,
    issues: &mut Vec<ValidationIssue>,
) {
    let Some(obj) = schema.as_object() else {
        return;
    };

    if obj.contains_key("x-scratch-record-ref") {
        check_ref_value(value, path, folder_records, issues);
        return;
    }

    if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
        for (key, prop_schema) in props {
            let mut child_path = path.to_vec();
            child_path.push(key.clone());
            let child_value = value.get(key).unwrap_or(&Value::Null);
            walk_for_refs(child_value, prop_schema, &child_path, folder_records, issues);
        }
    }

    if let Some(items_schema) = obj.get("items") {
        if let Some(arr) = value.as_array() {
            for (i, element) in arr.iter().enumerate() {
                let mut child_path = path.to_vec();
                child_path.push(i.to_string());
                walk_for_refs(element, items_schema, &child_path, folder_records, issues);
            }
        }
    }

    for keyword in &["oneOf", "anyOf", "allOf"] {
        if let Some(variants) = obj.get(*keyword).and_then(|v| v.as_array()) {
            for variant in variants {
                walk_for_refs(value, variant, path, folder_records, issues);
            }
        }
    }
}

fn check_ref_value(
    value: &Value,
    path: &[String],
    folder_records: &HashMap<String, Value>,
    issues: &mut Vec<ValidationIssue>,
) {
    let path_str = if path.is_empty() {
        String::new()
    } else {
        format!("/{}", path.join("/"))
    };

    match value {
        Value::String(ref_id) => {
            if !folder_records.contains_key(ref_id.as_str()) {
                issues.push(ValidationIssue {
                    path: path_str,
                    message: format!("Unresolved record reference: '{ref_id}'"),
                    warning: false,
                });
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                if let Value::String(ref_id) = item {
                    if !folder_records.contains_key(ref_id.as_str()) {
                        issues.push(ValidationIssue {
                            path: format!("{path_str}/{i}"),
                            message: format!("Unresolved record reference: '{ref_id}'"),
                            warning: false,
                        });
                    }
                }
            }
        }
        Value::Null => {}
        _ => {
            issues.push(ValidationIssue {
                path: path_str,
                message: format!(
                    "Expected a string or array of strings for record reference, got: {value}"
                ),
                warning: false,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx_with_refs(
        record: Value,
        schema: Value,
        folder_records: HashMap<String, Value>,
    ) -> ValidateContext {
        ValidateContext {
            record,
            original_record: None,
            schema: Some(schema),
            folder_records,
            options: HashMap::new(),
            file_path: "/test/record.json".into(),
        }
    }

    #[test]
    fn valid_ref() {
        let v = RecordRefsValidator;
        let mut folder = HashMap::new();
        folder.insert("rec_001".into(), json!({}));
        let ctx = ctx_with_refs(
            json!({"author_id": "rec_001"}),
            json!({
                "type": "object",
                "properties": {
                    "author_id": {"type": "string", "x-scratch-record-ref": true}
                }
            }),
            folder,
        );
        assert!(v.validate(&ctx).is_empty());
    }

    #[test]
    fn unresolved_ref() {
        let v = RecordRefsValidator;
        let mut folder = HashMap::new();
        folder.insert("rec_other".into(), json!({}));
        let ctx = ctx_with_refs(
            json!({"author_id": "rec_missing"}),
            json!({
                "type": "object",
                "properties": {
                    "author_id": {"type": "string", "x-scratch-record-ref": true}
                }
            }),
            folder,
        );
        let issues = v.validate(&ctx);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("rec_missing"));
    }

    #[test]
    fn empty_folder_records_skips() {
        let v = RecordRefsValidator;
        let ctx = ctx_with_refs(
            json!({"author_id": "rec_001"}),
            json!({
                "type": "object",
                "properties": {
                    "author_id": {"type": "string", "x-scratch-record-ref": true}
                }
            }),
            HashMap::new(),
        );
        assert!(v.validate(&ctx).is_empty());
    }

    #[test]
    fn null_ref_ok() {
        let v = RecordRefsValidator;
        let mut folder = HashMap::new();
        folder.insert("rec_001".into(), json!({}));
        let ctx = ctx_with_refs(
            json!({"author_id": null}),
            json!({
                "type": "object",
                "properties": {
                    "author_id": {"type": "string", "x-scratch-record-ref": true}
                }
            }),
            folder,
        );
        assert!(v.validate(&ctx).is_empty());
    }
}
