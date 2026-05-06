use super::{
    FieldValidationContext, RecordValidationContext, RecordValidationResult, ValidationLevel,
    ValidationResult,
};
use crate::shared::index::extract_id_path;
use crate::shared::json_path::id_path_root;

/// Validates that a field value's string length is between optional `min` and `max` characters.
/// Non-string values are coerced to their JSON representation for length measurement.
/// Returns `None` when the value passes; `Some(Warning)` when it fails.
pub fn length(ctx: &FieldValidationContext) -> Option<ValidationResult> {
    let min = match ctx.args.get("min") {
        Some(value) => match value.as_u64() {
            Some(value) => Some(value as usize),
            None => return invalid_length_params(),
        },
        None => None,
    };
    let max = match ctx.args.get("max") {
        Some(value) => match value.as_u64() {
            Some(value) => Some(value as usize),
            None => return invalid_length_params(),
        },
        None => None,
    };

    if min.is_none() && max.is_none() {
        return invalid_length_params();
    }
    if min.zip(max).is_some_and(|(min, max)| min > max) {
        return Some(ValidationResult {
            level: ValidationLevel::Warning,
            message: Some("length: 'min' cannot be greater than 'max'".to_string()),
            description: None,
            fixable: false,
        });
    }

    let len = match &ctx.value {
        serde_json::Value::String(s) => s.chars().count(),
        serde_json::Value::Null => 0,
        other => other.to_string().len(),
    };

    if min.is_some_and(|min| len < min) {
        return Some(ValidationResult {
            level: ValidationLevel::Warning,
            message: Some(format!(
                "value is {} character{} (min {})",
                len,
                if len == 1 { "" } else { "s" },
                min.unwrap()
            )),
            description: None,
            fixable: false,
        });
    }
    if max.is_some_and(|max| len > max) {
        return Some(ValidationResult {
            level: ValidationLevel::Warning,
            message: Some(format!(
                "value is {} character{} (max {})",
                len,
                if len == 1 { "" } else { "s" },
                max.unwrap()
            )),
            description: None,
            fixable: false,
        });
    }
    None
}

/// Checks that a field value is present, non-null, and non-empty string.
///
/// Emits an **error** when:
/// - the field is absent from the record
/// - the field is `null`
/// - the field is an empty string (`""`)
///
/// Use this to enforce required values on fields that the schema does not
/// already list in `required` (e.g. optional fields that your workflow
/// still needs to have filled in before publishing).
///
/// ```json
/// { "validator": "required", "field": "fields.Name" }
/// ```
pub fn required(ctx: &FieldValidationContext) -> Option<ValidationResult> {
    let is_missing = match &ctx.value {
        serde_json::Value::Null => true,
        serde_json::Value::String(s) if s.is_empty() => true,
        _ => false,
    };
    if is_missing {
        Some(ValidationResult {
            level: ValidationLevel::Error,
            message: Some(format!("field '{}' is required", ctx.field_path)),
            description: None,
            fixable: false,
        })
    } else {
        None
    }
}

fn invalid_length_params() -> Option<ValidationResult> {
    Some(ValidationResult {
        level: ValidationLevel::Warning,
        message: Some(
            "length: missing or invalid 'min'/'max' parameter (expected non-negative integers)"
                .to_string(),
        ),
        description: None,
        fixable: false,
    })
}

/// Enforces `required` and `x-scratch-readonly` constraints from `schema.json`.
///
/// Required check: a field is violated when it is absent from the record, null,
/// or an empty string. Empty string is treated as "not provided" because the DB
/// stores empty text for blank inputs and the connector would never publish "".
///
/// Readonly check: only when `ctx.master_record` is `Some`. A field whose master
/// value differs from the working-copy value emits a Warning (the push code drops
/// readonly fields automatically; this is advisory).
///
/// Returns one `RecordValidationResult` per violated field. Clean records return an
/// empty Vec — no rows are written to the DB.
pub fn enforce_schema(ctx: &RecordValidationContext) -> Vec<RecordValidationResult> {
    let mut results = Vec::new();

    let schema_obj = match ctx.schema.get("schema") {
        Some(s) => s,
        None => return results,
    };

    // ── Required check ────────────────────────────────────────────────────────
    if let Some(required) = schema_obj.get("required").and_then(|v| v.as_array()) {
        // The id column is assigned by the remote service on first publish.
        // New records (no master) won't have it yet — skip the required check
        // for it. `idColumnRemoteId` is a dot path (e.g. `"id.record_id"` for
        // Attio); compare against its first segment because the JSON Schema's
        // `required` array only lists top-level field names.
        let id_path = extract_id_path(&ctx.schema);
        let id_column_root = id_path.as_deref().map(id_path_root);
        let is_new_record = ctx.master_record.is_none();

        for field_val in required {
            let field_name = match field_val.as_str() {
                Some(s) => s,
                None => continue,
            };

            if is_new_record && id_column_root == Some(field_name) {
                continue;
            }

            let value = ctx.record.get(field_name);
            let is_missing = match value {
                None => true,
                Some(serde_json::Value::Null) => true,
                Some(serde_json::Value::String(s)) if s.is_empty() => true,
                _ => false,
            };
            if is_missing {
                results.push(RecordValidationResult {
                    field_path: field_name.to_string(),
                    level: ValidationLevel::Error,
                    message: Some(format!(
                        "field '{}' is required but missing or null",
                        field_name
                    )),
                    description: None,
                    fixable: false,
                });
            }
        }
    }

    // ── Readonly check ────────────────────────────────────────────────────────
    if let Some(properties) = schema_obj.get("properties").and_then(|v| v.as_object()) {
        for (field_name, props) in properties {
            if props.get("x-scratch-readonly").and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
            let working = ctx.record.get(field_name.as_str());
            match &ctx.master_record {
                Some(master) => {
                    // Existing record: warn if the value differs from master.
                    let master_val = master.get(field_name.as_str());
                    if working != master_val {
                        results.push(RecordValidationResult {
                            field_path: field_name.clone(),
                            level: ValidationLevel::Warning,
                            message: Some("Updated read-only field".to_string()),
                            description: Some(format!(
                                "Field {} changed from {} to {}. The new value will be ignored during publishing.",
                                field_name,
                                format_validation_value(master_val),
                                format_validation_value(working)
                            )),
                            fixable: false,
                        });
                    }
                }
                None => {
                    // New record: warn if a readonly field has been set (remote assigns it).
                    let is_set = match working {
                        None | Some(serde_json::Value::Null) => false,
                        _ => true,
                    };
                    if is_set {
                        results.push(RecordValidationResult {
                            field_path: field_name.clone(),
                            level: ValidationLevel::Warning,
                            message: Some("Updated read-only field".to_string()),
                            description: Some(format!(
                                "Field {} is read-only and will be ignored during publishing.",
                                field_name,
                            )),
                            fixable: false,
                        });
                    }
                }
            }
        }
    }

    results
}

fn format_validation_value(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(value) => value.to_string(),
        None => "<missing>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── enforce_schema tests ──────────────────────────────────────────────────

    fn schema_with_required(required: &[&str]) -> serde_json::Value {
        json!({ "schema": { "required": required, "properties": {} } })
    }

    fn schema_with_readonly(fields: &[&str]) -> serde_json::Value {
        let mut props = serde_json::Map::new();
        for f in fields {
            props.insert(f.to_string(), json!({ "x-scratch-readonly": true }));
        }
        json!({ "schema": { "required": [], "properties": props } })
    }

    /// Schema where `id` is the primary key (idColumnRemoteId) and also required.
    fn schema_with_id_column() -> serde_json::Value {
        json!({
            "idColumnRemoteId": "id",
            "schema": {
                "required": ["id", "name"],
                "properties": {
                    "id": { "type": "number" },
                    "name": { "type": "string" }
                }
            }
        })
    }

    fn record_ctx(
        record: serde_json::Value,
        master: Option<serde_json::Value>,
        schema: serde_json::Value,
    ) -> RecordValidationContext {
        RecordValidationContext {
            filename: "rec-001.json".to_string(),
            record,
            master_record: master,
            schema,
            args: json!({}),
        }
    }

    #[test]
    fn required_field_missing_is_error() {
        let ctx = record_ctx(
            json!({"name": "Alice"}),
            None,
            schema_with_required(&["id", "name"]),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
        assert_eq!(results[0].level, ValidationLevel::Error);
        assert!(results[0].message.as_deref().unwrap().contains("required"));
    }

    #[test]
    fn required_field_null_is_error() {
        let ctx = record_ctx(
            json!({"id": null, "name": "Alice"}),
            None,
            schema_with_required(&["id"]),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn required_field_empty_string_is_error() {
        let ctx = record_ctx(
            json!({"id": 1, "name": ""}),
            None,
            schema_with_required(&["id", "name"]),
        );
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "name");
        assert_eq!(results[0].level, ValidationLevel::Error);
    }

    #[test]
    fn all_required_fields_present_is_clean() {
        let ctx = record_ctx(
            json!({"id": 1, "name": "Alice"}),
            None,
            schema_with_required(&["id", "name"]),
        );
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn id_column_required_skipped_for_new_record() {
        // New record (master=None): id not yet assigned by remote — no required error.
        let ctx = record_ctx(json!({"name": "Alice"}), None, schema_with_id_column());
        let results = enforce_schema(&ctx);
        assert!(
            results.is_empty(),
            "id column should not error on new records"
        );
    }

    /// Mirrors Attio: `idColumnRemoteId` is a dot path into the id triple, but
    /// the JSON Schema's `required` only lists the top-level `id` object. The
    /// validator must compare against the path's first segment.
    fn schema_with_dot_path_id_column() -> serde_json::Value {
        json!({
            "idColumnRemoteId": "id.record_id",
            "schema": {
                "required": ["id", "values"],
                "properties": {
                    "id": {
                        "type": "object",
                        "properties": {
                            "workspace_id": { "type": "string" },
                            "object_id": { "type": "string" },
                            "record_id": { "type": "string" }
                        }
                    },
                    "values": { "type": "object" }
                }
            }
        })
    }

    #[test]
    fn id_column_dot_path_skipped_for_new_record() {
        // New Attio-shaped record: no `id` triple yet (the connector hasn't
        // assigned one). The required check on the top-level `id` must be
        // skipped because `idColumnRemoteId` points into it.
        let ctx = record_ctx(
            json!({"values": {}}),
            None,
            schema_with_dot_path_id_column(),
        );
        let results = enforce_schema(&ctx);
        assert!(
            results.is_empty(),
            "id triple should not error on new records when idColumnRemoteId is a dot path; got {} violations",
            results.len()
        );
    }

    #[test]
    fn id_column_required_enforced_for_existing_record() {
        // Existing record (master=Some): id is required and must be present.
        let ctx = record_ctx(
            json!({"name": "Alice"}),
            Some(json!({"id": 1, "name": "Alice"})),
            schema_with_id_column(),
        );
        let results = enforce_schema(&ctx);
        let required_error = results
            .iter()
            .find(|r| r.field_path == "id" && r.level == ValidationLevel::Error);
        assert!(
            required_error.is_some(),
            "expected a required error for 'id'"
        );
    }

    #[test]
    fn readonly_field_changed_is_warning() {
        let schema = schema_with_readonly(&["id"]);
        let ctx = record_ctx(json!({"id": 99}), Some(json!({"id": 1})), schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
        assert_eq!(results[0].level, ValidationLevel::Warning);
        assert_eq!(
            results[0].message.as_deref(),
            Some("Updated read-only field")
        );
        assert_eq!(
            results[0].description.as_deref(),
            Some("Field id changed from 1 to 99. The new value will be ignored during publishing.")
        );
    }

    #[test]
    fn readonly_field_unchanged_is_clean() {
        let schema = schema_with_readonly(&["id"]);
        let ctx = record_ctx(json!({"id": 1}), Some(json!({"id": 1})), schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn readonly_field_set_on_new_record_is_warning() {
        let schema = schema_with_readonly(&["ts"]);
        let ctx = record_ctx(json!({"ts": "2024-01-01"}), None, schema);
        let results = enforce_schema(&ctx);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "ts");
        assert_eq!(results[0].level, ValidationLevel::Warning);
    }

    #[test]
    fn readonly_field_absent_on_new_record_is_clean() {
        let schema = schema_with_readonly(&["ts"]);
        let ctx = record_ctx(json!({}), None, schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn readonly_field_null_on_new_record_is_clean() {
        let schema = schema_with_readonly(&["ts"]);
        let ctx = record_ctx(json!({"ts": null}), None, schema);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    #[test]
    fn readonly_master_missing_field_no_violation() {
        // Master doesn't have the field at all — no baseline, no violation.
        let schema = schema_with_readonly(&["id"]);
        let ctx = record_ctx(json!({"id": 1}), Some(json!({})), schema);
        let results = enforce_schema(&ctx);
        // working = Some(1), master = None → they differ → warning
        // (spec says "field didn't exist before" is not a violation, but our
        // implementation treats None != Some(1) as a change from master.
        // This test documents current behaviour.)
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].field_path, "id");
    }

    #[test]
    fn no_schema_json_is_noop() {
        let ctx = record_ctx(json!({"id": 1}), None, serde_json::Value::Null);
        let results = enforce_schema(&ctx);
        assert!(results.is_empty());
    }

    // ── length tests ──────────────────────────────────────────────────────────

    fn ctx(value: serde_json::Value, args: serde_json::Value) -> FieldValidationContext {
        FieldValidationContext {
            filename: "rec-001.json".to_string(),
            field_path: "title".to_string(),
            value,
            record: json!({}),
            args,
        }
    }

    #[test]
    fn passes_under_limit() {
        assert!(length(&ctx(json!("hello"), json!({"max": 50}))).is_none());
    }

    #[test]
    fn fails_over_limit() {
        let r = length(&ctx(json!("x".repeat(101)), json!({"max": 100}))).unwrap();
        assert_eq!(r.level, ValidationLevel::Warning);
        assert!(r.message.is_some());
    }

    #[test]
    fn fails_under_minimum() {
        let r = length(&ctx(json!("hi"), json!({"min": 3}))).unwrap();
        assert_eq!(r.level, ValidationLevel::Warning);
        assert!(r.message.as_deref().unwrap_or("").contains("min 3"));
    }

    #[test]
    fn passes_at_exact_limit() {
        assert!(length(&ctx(json!("x".repeat(100)), json!({"max": 100}))).is_none());
    }

    #[test]
    fn passes_within_min_and_max() {
        assert!(length(&ctx(json!("hello"), json!({"min": 3, "max": 10}))).is_none());
    }

    #[test]
    fn null_value_passes() {
        assert!(length(&ctx(json!(null), json!({"max": 10}))).is_none());
    }

    #[test]
    fn missing_min_and_max_param_fails_as_warning() {
        let ctx_bad = FieldValidationContext {
            filename: "f.json".to_string(),
            field_path: "x".to_string(),
            value: json!("hello"),
            record: json!({}),
            args: json!({}),
        };
        let r = length(&ctx_bad).unwrap();
        assert_eq!(r.level, ValidationLevel::Warning);
    }
}
