use scratch_core::nested_path::{get_nested, set_nested, zip_deep};
use scratch_core::types::{ColumnMapping, SyncPhase, SyncRecord};
use scratch_transform::{apply_pipeline, LookupTools, TransformContext, TransformerRegistry};
use serde_json::Value;
use std::sync::Arc;

/// Transform a source record's fields using column mappings and transformer pipeline.
///
/// When `base_fields` is `Some` (updating an existing record): deepcopy + set_nested to
/// write only the mapped fields — this preserves the destination file's JSON key ordering.
/// When `base_fields` is `None` (new record): zip_deep to build a fresh object.
///
/// Returns `(transformed_fields, warnings)` or an error string.
///
/// Port of `_transform_record` from `sync_engine.py:314-382`.
pub fn transform_record(
    source: &SyncRecord,
    column_mappings: &[ColumnMapping],
    lookup_tools: Option<Arc<LookupTools>>,
    phase: SyncPhase,
    base_fields: Option<&Value>,
    registry: &TransformerRegistry,
) -> Result<(Value, Vec<String>), String> {
    let mut defined_paths: Vec<String> = Vec::new();
    let mut defined_values: Vec<Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for mapping in column_mappings {
        let src_path = &mapping.source_column_id;
        let dst_path = &mapping.destination_column_id;
        let source_value = match get_nested(&source.fields, src_path) {
            Some(v) => v.clone(),
            None => continue, // Field doesn't exist in source — skip (not the same as null).
        };

        let configs = mapping.transformer_configs();

        if !configs.is_empty() {
            // Build a TransformContext for the pipeline.
            let dest_value = base_fields.and_then(|bf| get_nested(bf, dst_path).cloned());

            let base_ctx = TransformContext {
                source_record: source.clone(),
                source_field_path: src_path.clone(),
                source_value: source_value.clone(),
                destination_field_path: dst_path.clone(),
                destination_value: dest_value,
                lookup_tools: lookup_tools.clone(),
                options: std::collections::HashMap::new(),
                phase,
            };

            let result = apply_pipeline(&configs, source_value, &base_ctx, registry);

            if result.success {
                if result.skip {
                    continue; // Transformer says skip this field.
                }
                warnings.extend(result.warnings);
                let transformed = result.value.unwrap_or(Value::Null);
                defined_paths.push(dst_path.clone());
                defined_values.push(transformed);
            } else {
                return Err(format!(
                    "Transform failed for \"{}\": {}",
                    src_path,
                    result.error.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }
        } else {
            // No transformers — pass through.
            defined_paths.push(dst_path.clone());
            defined_values.push(source_value);
        }
    }

    // Build output fields — preserve key ordering for updates.
    let fields = if let Some(base) = base_fields {
        let mut fields = base.clone();
        for (path, value) in defined_paths.iter().zip(defined_values.into_iter()) {
            set_nested(&mut fields, path, value);
        }
        fields
    } else {
        zip_deep(&defined_paths, &defined_values)
    };

    Ok((fields, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use scratch_core::types::TransformerConfig;
    use serde_json::json;
    use std::collections::HashMap;

    fn make_record(id: &str, fields: Value) -> SyncRecord {
        SyncRecord {
            id: id.to_string(),
            file_path: format!("src/{}.json", id),
            fields,
        }
    }

    fn make_mapping(src: &str, dst: &str) -> ColumnMapping {
        ColumnMapping {
            source_column_id: src.to_string(),
            destination_column_id: dst.to_string(),
            transformers: vec![],
            transformer: None,
        }
    }

    fn make_mapping_with_transformer(src: &str, dst: &str, transformer_type: &str) -> ColumnMapping {
        ColumnMapping {
            source_column_id: src.to_string(),
            destination_column_id: dst.to_string(),
            transformers: vec![TransformerConfig {
                transformer_type: transformer_type.to_string(),
                options: HashMap::new(),
            }],
            transformer: None,
        }
    }

    #[test]
    fn test_simple_passthrough_no_base() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"name": "Alice", "age": 30}));
        let mappings = vec![
            make_mapping("name", "full_name"),
            make_mapping("age", "years"),
        ];

        let (fields, warnings) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        assert_eq!(fields, json!({"full_name": "Alice", "years": 30}));
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_with_base_fields_preserves_keys() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"name": "Alice Updated"}));
        let mappings = vec![make_mapping("name", "name")];
        let base = json!({"name": "Alice", "extra": "preserved"});

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, Some(&base), &registry)
                .unwrap();

        assert_eq!(fields["name"], json!("Alice Updated"));
        assert_eq!(fields["extra"], json!("preserved"));
    }

    #[test]
    fn test_missing_source_field_skipped() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"name": "Alice"}));
        let mappings = vec![
            make_mapping("name", "name"),
            make_mapping("missing_field", "other"),
        ];

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        // Only "name" should be in the output, "other" is not set since source field is missing.
        assert_eq!(fields, json!({"name": "Alice"}));
    }

    #[test]
    fn test_null_source_field_passed_through() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"name": null}));
        let mappings = vec![make_mapping("name", "name")];

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        assert_eq!(fields, json!({"name": null}));
    }

    #[test]
    fn test_with_slugify_transformer() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"title": "Hello World"}));
        let mappings = vec![make_mapping_with_transformer("title", "slug", "slugify")];

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        assert_eq!(fields["slug"], json!("hello-world"));
    }

    #[test]
    fn test_with_auto_convert_transformer() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"count": "42"}));
        let mut opts = HashMap::new();
        opts.insert("targetType".to_string(), json!("number"));
        let mappings = vec![ColumnMapping {
            source_column_id: "count".to_string(),
            destination_column_id: "count".to_string(),
            transformers: vec![TransformerConfig {
                transformer_type: "auto_convert".to_string(),
                options: opts,
            }],
            transformer: None,
        }];

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        assert_eq!(fields["count"], json!(42));
    }

    #[test]
    fn test_unknown_transformer_errors() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"name": "Alice"}));
        let mappings = vec![make_mapping_with_transformer("name", "name", "nonexistent")];

        let result =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Transform failed"));
    }

    #[test]
    fn test_nested_paths() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"address": {"city": "NYC"}}));
        let mappings = vec![make_mapping("address.city", "location.city")];

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        assert_eq!(fields, json!({"location": {"city": "NYC"}}));
    }

    #[test]
    fn test_multiple_mappings_build_nested_output() {
        let registry = TransformerRegistry::new();
        let source = make_record("s1", json!({"a": 1, "b": 2, "c": 3}));
        let mappings = vec![
            make_mapping("a", "x.a"),
            make_mapping("b", "x.b"),
            make_mapping("c", "y"),
        ];

        let (fields, _) =
            transform_record(&source, &mappings, None, SyncPhase::Data, None, &registry).unwrap();

        assert_eq!(fields, json!({"x": {"a": 1, "b": 2}, "y": 3}));
    }
}
