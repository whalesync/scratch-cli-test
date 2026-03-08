use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};
use scratch_core::types::SyncPhase;
use serde_json::Value;

/// Look up a field value from a record referenced by a foreign key.
///
/// Only runs in DATA phase. Uses pre-cached FK records from the referenced folder.
///
/// Options:
/// - `referencedDataFolderId` (string): The folder containing the referenced records.
/// - `fieldPath` (string): Dot-path to the field to extract (e.g. "company.name").
///
/// Handles both scalar and array FK values. For arrays, each element is looked up
/// individually and the result is an array.
pub struct LookupFieldTransformer;

impl Transformer for LookupFieldTransformer {
    fn name(&self) -> &str {
        "lookup_field"
    }

    fn phases(&self) -> &[SyncPhase] {
        &[SyncPhase::Data]
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let ref_folder_id = ctx
            .options
            .get("referencedDataFolderId")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let field_path = ctx
            .options
            .get("fieldPath")
            .or_else(|| ctx.options.get("referencedFieldPath"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let lookup_tools = match &ctx.lookup_tools {
            Some(lt) => lt,
            None => {
                return TransformResult::Error("No lookup tools available".into());
            }
        };

        let source_val = &ctx.source_value;

        if source_val.is_null() {
            return TransformResult::Value(Value::Null);
        }

        // Handle arrays — look up each element.
        if let Some(arr) = source_val.as_array() {
            let mut results: Vec<Value> = Vec::new();
            for fk_val in arr {
                if fk_val.is_null() {
                    results.push(Value::Null);
                    continue;
                }
                let fk_str = value_to_fk_string(fk_val);
                match (lookup_tools.lookup_field)(&fk_str, ref_folder_id, field_path) {
                    Some(v) => results.push(v),
                    None => {
                        return TransformResult::Error(format!(
                            "Could not find referenced record \"{}\" in DataFolder {}",
                            fk_str, ref_folder_id
                        ));
                    }
                }
            }
            return TransformResult::Value(Value::Array(results));
        }

        // Validate scalar type
        if !source_val.is_string() && !source_val.is_number() {
            return TransformResult::Error(format!(
                "Expected string, number, or array for FK value, got {}",
                match source_val {
                    Value::Bool(_) => "boolean",
                    Value::Object(_) => "object",
                    _ => "unknown",
                }
            ));
        }

        // Scalar lookup.
        let fk_str = value_to_fk_string(source_val);
        match (lookup_tools.lookup_field)(&fk_str, ref_folder_id, field_path) {
            Some(v) => TransformResult::Value(v),
            None => TransformResult::Error(format!(
                "Could not find referenced record \"{}\" in DataFolder {}",
                fk_str, ref_folder_id
            )),
        }
    }
}

/// Convert a JSON value to its FK string representation.
fn value_to_fk_string(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => val.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::LookupTools;
    use scratch_core::types::{SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn make_lookup_tools() -> Arc<LookupTools> {
        Arc::new(LookupTools {
            get_dest_mapping: Box::new(|_, _| None),
            lookup_field: Box::new(|fk_val, _folder_id, _field_path| {
                match fk_val {
                    "rec1" => Some(json!("Company A")),
                    "rec2" => Some(json!("Company B")),
                    _ => None,
                }
            }),
        })
    }

    fn ctx_with_tools(value: Value, tools: Arc<LookupTools>) -> TransformContext {
        let mut opts = HashMap::new();
        opts.insert("referencedDataFolderId".into(), json!("folder1"));
        opts.insert("fieldPath".into(), json!("company.name"));
        TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "fk_field".into(),
            source_value: value,
            destination_field_path: "company_name".into(),
            destination_value: None,
            lookup_tools: Some(tools),
            options: opts,
            phase: SyncPhase::Data,
        }
    }

    #[test]
    fn scalar_lookup() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_tools(json!("rec1"), tools);
        match LookupFieldTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("Company A")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn array_lookup() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_tools(json!(["rec1", "rec2"]), tools);
        match LookupFieldTransformer.transform(&ctx) {
            TransformResult::Value(v) => {
                assert_eq!(v, json!(["Company A", "Company B"]));
            }
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn null_passthrough() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_tools(json!(null), tools);
        match LookupFieldTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(null)),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn missing_fk_returns_error() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_tools(json!("rec_unknown"), tools);
        match LookupFieldTransformer.transform(&ctx) {
            TransformResult::Error(e) => {
                assert!(e.contains("Could not find referenced record \"rec_unknown\""));
            }
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn no_lookup_tools_error() {
        let mut opts = HashMap::new();
        opts.insert("referencedDataFolderId".into(), json!("folder1"));
        opts.insert("fieldPath".into(), json!("name"));
        let ctx = TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "fk".into(),
            source_value: json!("rec1"),
            destination_field_path: "name".into(),
            destination_value: None,
            lookup_tools: None,
            options: opts,
            phase: SyncPhase::Data,
        };
        match LookupFieldTransformer.transform(&ctx) {
            TransformResult::Error(e) => assert!(e.contains("No lookup tools")),
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn array_with_null_element() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_tools(json!(["rec1", null, "rec2"]), tools);
        match LookupFieldTransformer.transform(&ctx) {
            TransformResult::Value(v) => {
                assert_eq!(v, json!(["Company A", null, "Company B"]));
            }
            other => panic!("Expected Value, got {:?}", other),
        }
    }
}
