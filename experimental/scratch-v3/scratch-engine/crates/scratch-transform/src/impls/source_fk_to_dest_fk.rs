use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};
use scratch_core::filename::is_pending_publish_id;
use scratch_core::types::SyncPhase;
use serde_json::Value;

/// Resolve source FK values to destination FK IDs/paths.
///
/// Only runs in FOREIGN_KEY_MAPPING phase -- new records must exist before FKs
/// can reference them.
///
/// Options:
/// - `referencedDataFolderId` (string): The source folder containing the referenced records.
/// - `onUnresolved` (string): "fail" (default) or "ignore". What to do when an FK can't be resolved.
/// - `outputType` (string): "single" or "array" (default "array"). Output format.
pub struct SourceFkToDestFkTransformer;

impl Transformer for SourceFkToDestFkTransformer {
    fn name(&self) -> &str {
        "source_fk_to_dest_fk"
    }

    fn phases(&self) -> &[SyncPhase] {
        &[SyncPhase::ForeignKeyMapping]
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let ref_folder_id = ctx
            .options
            .get("referencedDataFolderId")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let on_unresolved = ctx
            .options
            .get("onUnresolved")
            .and_then(|v| v.as_str())
            .unwrap_or("fail");

        let output_type = ctx
            .options
            .get("outputType")
            .and_then(|v| v.as_str())
            .unwrap_or("array");

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

        // Normalize to list for uniform processing.
        let is_array = source_val.is_array();
        let fk_values: Vec<&Value> = if let Some(arr) = source_val.as_array() {
            arr.iter().collect()
        } else {
            vec![source_val]
        };

        let mut resolved: Vec<Option<String>> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();

        for fk_val in &fk_values {
            if fk_val.is_null() {
                resolved.push(None);
                continue;
            }

            let fk_str = value_to_fk_string(fk_val);
            let mapping = (lookup_tools.get_dest_mapping)(&fk_str, ref_folder_id);

            if let Some(m) = mapping {
                // Use real dest_id if available and not a pending publish ID;
                // otherwise use @/dest_path pseudo-reference.
                let ref_value = match (&m.dest_id, &m.dest_path) {
                    (Some(did), _) if !is_pending_publish_id(did) => Some(did.clone()),
                    (_, Some(dp)) => Some(format!("@/{}", dp.trim_start_matches('/'))),
                    (Some(did), None) => Some(did.clone()),
                    (None, None) => None,
                };
                resolved.push(ref_value);
            } else if on_unresolved == "fail" {
                return TransformResult::Error(format!("Unresolved FK: {}", fk_str));
            } else {
                warnings.push(format!("Unresolved FK: {}", fk_str));
                resolved.push(None);
            }
        }

        // Format output.
        let value = if output_type == "array" || is_array {
            // Filter out Nones and return as array.
            let arr: Vec<Value> = resolved
                .into_iter()
                .filter_map(|v| v.map(|s| Value::String(s)))
                .collect();
            Value::Array(arr)
        } else {
            // Single mode: return first resolved or null.
            match resolved.into_iter().next().flatten() {
                Some(s) => Value::String(s),
                None => Value::Null,
            }
        };

        if warnings.is_empty() {
            TransformResult::Value(value)
        } else {
            TransformResult::ValueWithWarnings(value, warnings)
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
    use scratch_core::types::{RemoteIdMapping, SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn make_lookup_tools() -> Arc<LookupTools> {
        Arc::new(LookupTools {
            get_dest_mapping: Box::new(|fk_val, _folder_id| match fk_val {
                "src1" => Some(RemoteIdMapping {
                    dest_id: Some("dest1".into()),
                    dest_path: Some("/dest/rec1.json".into()),
                }),
                "src2" => Some(RemoteIdMapping {
                    dest_id: Some("dest2".into()),
                    dest_path: Some("/dest/rec2.json".into()),
                }),
                // Pending publish ID — should use @/path pseudo-ref
                "src_pending" => Some(RemoteIdMapping {
                    dest_id: Some("spub_abc123".into()),
                    dest_path: Some("/dest/spub_abc123.json".into()),
                }),
                _ => None,
            }),
            lookup_field: Box::new(|_, _, _| None),
        })
    }

    fn ctx_with_opts(
        value: Value,
        tools: Arc<LookupTools>,
        extra_opts: HashMap<String, Value>,
    ) -> TransformContext {
        let mut opts = HashMap::new();
        opts.insert("referencedDataFolderId".into(), json!("folder1"));
        opts.extend(extra_opts);
        TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "fk_field".into(),
            source_value: value,
            destination_field_path: "fk_field".into(),
            destination_value: None,
            lookup_tools: Some(tools),
            options: opts,
            phase: SyncPhase::ForeignKeyMapping,
        }
    }

    #[test]
    fn scalar_resolve_array_output() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_opts(json!("src1"), tools, HashMap::new());
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(["dest1"])),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn scalar_resolve_single_output() {
        let tools = make_lookup_tools();
        let mut opts = HashMap::new();
        opts.insert("outputType".into(), json!("single"));
        let ctx = ctx_with_opts(json!("src1"), tools, opts);
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("dest1")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn array_resolve() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_opts(json!(["src1", "src2"]), tools, HashMap::new());
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(["dest1", "dest2"])),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn unresolved_ignore_with_warning() {
        let tools = make_lookup_tools();
        let mut opts = HashMap::new();
        opts.insert("onUnresolved".into(), json!("ignore"));
        let ctx = ctx_with_opts(json!(["src1", "unknown"]), tools, opts);
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::ValueWithWarnings(v, w) => {
                assert_eq!(v, json!(["dest1"]));
                assert_eq!(w.len(), 1);
                assert!(w[0].contains("Unresolved FK: unknown"));
            }
            other => panic!("Expected ValueWithWarnings, got {:?}", other),
        }
    }

    #[test]
    fn unresolved_fail_is_default() {
        let tools = make_lookup_tools();
        // Default onUnresolved is "fail" — no need to set it explicitly
        let ctx = ctx_with_opts(json!("unknown"), tools, HashMap::new());
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Error(e) => assert!(e.contains("Unresolved FK: unknown")),
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn pending_publish_id_uses_pseudo_ref() {
        let tools = make_lookup_tools();
        let mut opts = HashMap::new();
        opts.insert("outputType".into(), json!("single"));
        let ctx = ctx_with_opts(json!("src_pending"), tools, opts);
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!("@/dest/spub_abc123.json")),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn null_passthrough() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_opts(json!(null), tools, HashMap::new());
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Value(v) => assert_eq!(v, json!(null)),
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    #[test]
    fn no_lookup_tools_error() {
        let opts: HashMap<String, Value> = HashMap::new();
        let ctx = TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "fk".into(),
            source_value: json!("src1"),
            destination_field_path: "fk".into(),
            destination_value: None,
            lookup_tools: None,
            options: opts,
            phase: SyncPhase::ForeignKeyMapping,
        };
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Error(e) => assert!(e.contains("No lookup tools")),
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn array_with_nulls() {
        let tools = make_lookup_tools();
        let ctx = ctx_with_opts(json!(["src1", null, "src2"]), tools, HashMap::new());
        match SourceFkToDestFkTransformer.transform(&ctx) {
            TransformResult::Value(v) => {
                // Nulls are filtered out in array output
                assert_eq!(v, json!(["dest1", "dest2"]));
            }
            other => panic!("Expected Value, got {:?}", other),
        }
    }
}
