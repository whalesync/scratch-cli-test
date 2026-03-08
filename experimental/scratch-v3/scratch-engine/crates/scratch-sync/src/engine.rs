use scratch_core::filename::{resolve_filename, temp_publish_id};
use scratch_core::nested_path::{get_nested, set_nested};
use scratch_core::schema::id_column;
use scratch_core::types::*;
use scratch_transform::{LookupTools, TransformerRegistry};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::context::SyncContext;
use super::matching::match_records;
use super::transform_record::transform_record;

/// Pure sync function: records in, file writes + results out.
///
/// No I/O — the caller is responsible for reading source/dest records from git
/// and writing the output files. This function only performs matching, transformation,
/// and diff detection.
///
/// Port of `_sync_table_mapping` from `sync_engine.py:128-258` (the pure logic parts).
pub fn sync_table_mapping(
    table_mapping: &TableMapping,
    source_records: &[SyncRecord],
    dest_records: &[SyncRecord],
    _source_schema: Option<&Value>,
    dest_schema: Option<&Value>,
    phase: SyncPhase,
    ctx: &mut SyncContext,
    registry: &TransformerRegistry,
) -> SyncOutput {
    let mut result = SyncResult::default();
    let src_folder_id = &table_mapping.source_data_folder_id;
    let dst_folder_id = &table_mapping.destination_data_folder_id;

    // 1. Build dest lookup by path, track used filenames.
    let dst_by_path: HashMap<&str, &SyncRecord> =
        dest_records.iter().map(|r| (r.file_path.as_str(), r)).collect();
    let mut used_filenames: HashSet<String> = dest_records
        .iter()
        .filter_map(|r| r.file_path.rsplit('/').next().map(|s| s.to_string()))
        .collect();

    // 2. Match records and populate ctx.remote_id_mappings (DATA phase only).
    let column_mappings = &table_mapping.column_mappings;

    if phase == SyncPhase::Data {
        let local_mappings = match_records(
            source_records,
            dest_records,
            table_mapping.record_matching.as_ref(),
        );
        for (src_id, mapping) in &local_mappings {
            ctx.remote_id_mappings
                .insert((src_folder_id.clone(), src_id.clone()), mapping.clone());
        }

        // 3. Report match key errors for source records not in the mapping.
        if let Some(ref matching) = table_mapping.record_matching {
            let match_col = &matching.source_column_id;
            for r in source_records {
                if !local_mappings.contains_key(&r.id) {
                    let val = get_nested(&r.fields, match_col);
                    let msg = match val {
                        None | Some(&Value::Null) => {
                            format!("Missing match key: {}", match_col)
                        }
                        _ => {
                            format!("Empty or invalid match key: {}", match_col)
                        }
                    };
                    result.errors.push(SyncError {
                        source_id: r.id.clone(),
                        error: msg,
                    });
                }
            }
        }
    }

    // 4. Build lookup tools from context.
    let lookup_tools = build_lookup_tools(ctx);

    // 5. Determine the destination ID column.
    let dst_id_col = id_column(dest_schema);

    // 6. Determine the destination folder path (for constructing file paths).
    let dst_folder_path = dst_folder_id_to_path(dst_folder_id);

    // 7. Transform and accumulate files to write.
    let mut files_to_write: Vec<FileWrite> = Vec::new();

    for src_record in source_records {
        let mapping = match ctx
            .remote_id_mappings
            .get(&(src_folder_id.clone(), src_record.id.clone()))
        {
            Some(m) => m.clone(),
            None => continue, // Missing match key — error already reported in step 3.
        };

        let transform_result = (|| -> Result<(), String> {
            let dest_path = mapping.dest_path.as_deref();
            let base_fields = dest_path
                .and_then(|p| dst_by_path.get(p))
                .map(|r| &r.fields);

            let (fields, transform_warnings) = transform_record(
                src_record,
                column_mappings,
                Some(lookup_tools.clone()),
                phase,
                base_fields.map(|v| v as &Value),
                registry,
            )?;

            for w in transform_warnings {
                result.warnings.push(SyncWarning {
                    source_id: src_record.id.clone(),
                    warning: w,
                });
            }

            let (final_dest_path, fields) = if dest_path.is_none() {
                // --- New record ---
                let mut fields = fields;
                let existing_id = get_nested(&fields, dst_id_col);
                let temp_id = match existing_id {
                    None | Some(&Value::Null) => {
                        let tid = temp_publish_id();
                        set_nested(&mut fields, dst_id_col, Value::String(tid.clone()));
                        tid
                    }
                    Some(v) => value_to_string(v),
                };

                let slug_col = dest_schema.and_then(|s| {
                    s.get("slugColumnRemoteId")
                        .and_then(|v| v.as_str())
                });
                let slug_val = slug_col.and_then(|col| {
                    get_nested(&fields, col).and_then(|v| {
                        v.as_str().map(|s| s.to_string())
                    })
                });

                let filename = resolve_filename(
                    slug_val.as_deref(),
                    &temp_id,
                    &mut used_filenames,
                );
                let computed_path = if dst_folder_path.is_empty() {
                    filename
                } else {
                    format!("{}/{}", dst_folder_path, filename)
                };

                // Update mapping so FK phase can find this record.
                ctx.remote_id_mappings.insert(
                    (src_folder_id.clone(), src_record.id.clone()),
                    RemoteIdMapping {
                        dest_id: Some(temp_id),
                        dest_path: Some(computed_path.clone()),
                    },
                );

                result.created += 1;
                result.created_paths.push(computed_path.clone());
                (computed_path, fields)
            } else {
                // --- Existing record — skip if unchanged ---
                let dest_path = dest_path.unwrap().to_string();
                if let Some(existing) = dst_by_path.get(dest_path.as_str()) {
                    if fields == existing.fields {
                        return Ok(()); // No changes — skip.
                    }
                }

                result.updated += 1;
                result.updated_paths.push(dest_path.clone());
                (dest_path, fields)
            };

            // JSON output: pretty-printed with 2-space indent + trailing newline.
            let content = serde_json::to_string_pretty(&fields)
                .map_err(|e| format!("JSON serialization failed: {}", e))?
                + "\n";

            files_to_write.push(FileWrite {
                path: final_dest_path,
                content,
            });

            Ok(())
        })();

        if let Err(e) = transform_result {
            result.errors.push(SyncError {
                source_id: src_record.id.clone(),
                error: e,
            });
        }
    }

    SyncOutput {
        files_to_write,
        result,
    }
}

/// Check if any column mapping uses FK-related transformers.
///
/// Port of `_has_fk_transformers` from `sync_engine.py:604-610`.
pub fn has_fk_transformers(table_mapping: &TableMapping) -> bool {
    for mapping in &table_mapping.column_mappings {
        for config in mapping.transformer_configs() {
            if config.transformer_type == "source_fk_to_dest_fk"
                || config.transformer_type == "lookup_field"
            {
                return true;
            }
        }
    }
    false
}

/// Collect referenced folder IDs from column mappings (for FK cache population).
///
/// Scans column mappings for `lookup_field` transformers and extracts the
/// `referencedDataFolderId` option from each.
pub fn collect_referenced_folder_ids(column_mappings: &[ColumnMapping]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for mapping in column_mappings {
        for config in mapping.transformer_configs() {
            if config.transformer_type == "lookup_field" {
                if let Some(folder_id) = config.options.get("referencedDataFolderId") {
                    if let Some(s) = folder_id.as_str() {
                        ids.insert(s.to_string());
                    }
                }
            }
        }
    }
    ids
}

/// Build lookup tools from the SyncContext caches.
///
/// Port of `_build_lookup_tools` from `sync_engine.py:427-440`.
fn build_lookup_tools(ctx: &SyncContext) -> Arc<LookupTools> {
    let mappings = ctx.remote_id_mappings.clone();
    let fk_cache = ctx.fk_record_cache.clone();

    Arc::new(LookupTools {
        get_dest_mapping: Box::new(move |fk_value: &str, referenced_folder_id: &str| {
            mappings
                .get(&(referenced_folder_id.to_string(), fk_value.to_string()))
                .cloned()
        }),
        lookup_field: Box::new(move |fk_value: &str, referenced_folder_id: &str, field_path: &str| {
            let fields = fk_cache.get(&(referenced_folder_id.to_string(), fk_value.to_string()))?;
            get_nested(fields, field_path).cloned()
        }),
    })
}

/// Extract the folder path from a folder ID. In the pure engine, the folder path
/// is passed through the table_mapping's destination_data_folder_id. The caller
/// should pass the real folder path here; for the engine, we use it as-is but
/// strip leading `/`.
fn dst_folder_id_to_path(folder_id: &str) -> String {
    folder_id.trim_start_matches('/').to_string()
}

/// Convert a JSON value to a string (for temp ID fallback).
fn value_to_string(val: &Value) -> String {
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
    use serde_json::json;
    use std::collections::HashMap;

    fn make_record(id: &str, path: &str, fields: Value) -> SyncRecord {
        SyncRecord {
            id: id.to_string(),
            file_path: path.to_string(),
            fields,
        }
    }

    fn make_table_mapping(
        src_folder: &str,
        dst_folder: &str,
        col_mappings: Vec<ColumnMapping>,
        record_matching: Option<RecordMatching>,
    ) -> TableMapping {
        TableMapping {
            source_data_folder_id: src_folder.to_string(),
            destination_data_folder_id: dst_folder.to_string(),
            column_mappings: col_mappings,
            record_matching,
        }
    }

    fn simple_mapping(src: &str, dst: &str) -> ColumnMapping {
        ColumnMapping {
            source_column_id: src.to_string(),
            destination_column_id: dst.to_string(),
            transformers: vec![],
            transformer: None,
        }
    }

    #[test]
    fn test_create_flow_no_matching() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![
            make_record("s1", "src/s1.json", json!({"name": "Alice", "id": "s1"})),
            make_record("s2", "src/s2.json", json!({"name": "Bob", "id": "s2"})),
        ];
        let dest: Vec<SyncRecord> = vec![];

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![
                simple_mapping("name", "name"),
                simple_mapping("id", "id"),
            ],
            None, // No matching -> all creates.
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.created, 2);
        assert_eq!(output.result.updated, 0);
        assert_eq!(output.files_to_write.len(), 2);
        assert_eq!(output.result.errors.len(), 0);

        // Each file should have JSON content with trailing newline.
        for fw in &output.files_to_write {
            assert!(fw.content.ends_with('\n'));
            let parsed: Value = serde_json::from_str(&fw.content).unwrap();
            assert!(parsed.get("name").is_some());
        }
    }

    #[test]
    fn test_update_flow_with_matching() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![
            make_record("s1", "src/s1.json", json!({"email": "alice@test.com", "name": "Alice New"})),
        ];
        let dest = vec![
            make_record("d1", "dst/d1.json", json!({"email": "alice@test.com", "name": "Alice Old"})),
        ];

        let tm = make_table_mapping(
            "src_folder",
            "dst",
            vec![
                simple_mapping("email", "email"),
                simple_mapping("name", "name"),
            ],
            Some(RecordMatching {
                source_column_id: "email".to_string(),
                destination_column_id: "email".to_string(),
            }),
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.created, 0);
        assert_eq!(output.result.updated, 1);
        assert_eq!(output.files_to_write.len(), 1);

        let fw = &output.files_to_write[0];
        assert_eq!(fw.path, "dst/d1.json");
        let parsed: Value = serde_json::from_str(&fw.content).unwrap();
        assert_eq!(parsed["name"], json!("Alice New"));
    }

    #[test]
    fn test_unchanged_skip() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let fields = json!({"email": "alice@test.com", "name": "Alice"});
        let source = vec![make_record("s1", "src/s1.json", fields.clone())];
        let dest = vec![make_record("d1", "dst/d1.json", fields.clone())];

        let tm = make_table_mapping(
            "src_folder",
            "dst",
            vec![
                simple_mapping("email", "email"),
                simple_mapping("name", "name"),
            ],
            Some(RecordMatching {
                source_column_id: "email".to_string(),
                destination_column_id: "email".to_string(),
            }),
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        // Record is unchanged — should be skipped.
        assert_eq!(output.result.created, 0);
        assert_eq!(output.result.updated, 0);
        assert_eq!(output.files_to_write.len(), 0);
    }

    #[test]
    fn test_create_assigns_temp_id() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        // Source record has no "id" field, so the engine should generate a spub_* temp ID.
        let source = vec![make_record("s1", "src/s1.json", json!({"name": "Alice"}))];
        let dest: Vec<SyncRecord> = vec![];

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![simple_mapping("name", "name")],
            None,
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.created, 1);
        assert_eq!(output.files_to_write.len(), 1);

        let parsed: Value = serde_json::from_str(&output.files_to_write[0].content).unwrap();
        let id_val = parsed["id"].as_str().unwrap();
        assert!(id_val.starts_with("spub_"), "Expected spub_ prefix, got: {}", id_val);
    }

    #[test]
    fn test_create_preserves_existing_id() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        // Source record already has an "id" field -> should be preserved.
        let source = vec![make_record("s1", "src/s1.json", json!({"name": "Alice", "id": "custom-id"}))];
        let dest: Vec<SyncRecord> = vec![];

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![
                simple_mapping("name", "name"),
                simple_mapping("id", "id"),
            ],
            None,
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.created, 1);
        let parsed: Value = serde_json::from_str(&output.files_to_write[0].content).unwrap();
        assert_eq!(parsed["id"], json!("custom-id"));
    }

    #[test]
    fn test_missing_match_key_errors() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![
            make_record("s1", "src/s1.json", json!({"name": "Alice"})), // No email
            make_record("s2", "src/s2.json", json!({"email": null, "name": "Bob"})), // Null email
            make_record("s3", "src/s3.json", json!({"email": "valid@test.com", "name": "Charlie"})),
        ];
        let dest: Vec<SyncRecord> = vec![];

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![
                simple_mapping("email", "email"),
                simple_mapping("name", "name"),
            ],
            Some(RecordMatching {
                source_column_id: "email".to_string(),
                destination_column_id: "email".to_string(),
            }),
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        // s1 and s2 should have errors, s3 should be created.
        assert_eq!(output.result.created, 1);
        assert_eq!(output.result.errors.len(), 2);
        assert!(output.result.errors.iter().any(|e| e.source_id == "s1"));
        assert!(output.result.errors.iter().any(|e| e.source_id == "s2"));
    }

    #[test]
    fn test_has_fk_transformers_true() {
        let tm = make_table_mapping(
            "src",
            "dst",
            vec![ColumnMapping {
                source_column_id: "fk_field".to_string(),
                destination_column_id: "fk_field".to_string(),
                transformers: vec![TransformerConfig {
                    transformer_type: "source_fk_to_dest_fk".to_string(),
                    options: HashMap::new(),
                }],
                transformer: None,
            }],
            None,
        );

        assert!(has_fk_transformers(&tm));
    }

    #[test]
    fn test_has_fk_transformers_false() {
        let tm = make_table_mapping(
            "src",
            "dst",
            vec![simple_mapping("name", "name")],
            None,
        );

        assert!(!has_fk_transformers(&tm));
    }

    #[test]
    fn test_has_fk_transformers_lookup_field() {
        let tm = make_table_mapping(
            "src",
            "dst",
            vec![ColumnMapping {
                source_column_id: "ref".to_string(),
                destination_column_id: "ref".to_string(),
                transformers: vec![TransformerConfig {
                    transformer_type: "lookup_field".to_string(),
                    options: HashMap::new(),
                }],
                transformer: None,
            }],
            None,
        );

        assert!(has_fk_transformers(&tm));
    }

    #[test]
    fn test_collect_referenced_folder_ids() {
        let mappings = vec![
            ColumnMapping {
                source_column_id: "ref".to_string(),
                destination_column_id: "ref".to_string(),
                transformers: vec![TransformerConfig {
                    transformer_type: "lookup_field".to_string(),
                    options: {
                        let mut m = HashMap::new();
                        m.insert(
                            "referencedDataFolderId".to_string(),
                            json!("folder-123"),
                        );
                        m
                    },
                }],
                transformer: None,
            },
            simple_mapping("name", "name"),
        ];

        let ids = collect_referenced_folder_ids(&mappings);
        assert_eq!(ids.len(), 1);
        assert!(ids.contains("folder-123"));
    }

    #[test]
    fn test_collect_referenced_folder_ids_empty() {
        let mappings = vec![simple_mapping("name", "name")];
        let ids = collect_referenced_folder_ids(&mappings);
        assert!(ids.is_empty());
    }

    #[test]
    fn test_slug_column_used_for_filename() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![make_record(
            "s1",
            "src/s1.json",
            json!({"name": "Hello World", "slug": "hello-world"}),
        )];
        let dest: Vec<SyncRecord> = vec![];

        let dest_schema = json!({
            "idColumnRemoteId": "id",
            "slugColumnRemoteId": "slug"
        });

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![
                simple_mapping("name", "name"),
                simple_mapping("slug", "slug"),
            ],
            None,
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            Some(&dest_schema),
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.created, 1);
        // The filename should be based on the slug value.
        assert!(
            output.files_to_write[0].path.contains("hello-world"),
            "Expected filename to contain 'hello-world', got: {}",
            output.files_to_write[0].path
        );
    }

    #[test]
    fn test_fk_two_phase_sync() {
        // This test verifies that the FK phase can read mappings created during the DATA phase.
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        // DATA phase: create a record with a known mapping.
        let source = vec![make_record("s1", "src/s1.json", json!({"name": "Alice", "id": "s1"}))];
        let dest: Vec<SyncRecord> = vec![];

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![
                simple_mapping("name", "name"),
                simple_mapping("id", "id"),
            ],
            None,
        );

        let data_output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(data_output.result.created, 1);

        // Verify the mapping was stored in context.
        let mapping = ctx
            .remote_id_mappings
            .get(&("src_folder".to_string(), "s1".to_string()));
        assert!(mapping.is_some(), "Mapping should exist in context after DATA phase");
        let mapping = mapping.unwrap();
        assert!(mapping.dest_path.is_some());
        assert!(mapping.dest_id.is_some());
    }

    #[test]
    fn test_update_preserves_extra_fields() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![make_record(
            "s1",
            "src/s1.json",
            json!({"email": "alice@test.com", "name": "Alice Updated"}),
        )];
        let dest = vec![make_record(
            "d1",
            "dst/d1.json",
            json!({"email": "alice@test.com", "name": "Alice", "extra_field": "should_stay"}),
        )];

        let tm = make_table_mapping(
            "src_folder",
            "dst",
            vec![
                simple_mapping("email", "email"),
                simple_mapping("name", "name"),
            ],
            Some(RecordMatching {
                source_column_id: "email".to_string(),
                destination_column_id: "email".to_string(),
            }),
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.updated, 1);
        let parsed: Value = serde_json::from_str(&output.files_to_write[0].content).unwrap();
        // Extra field from destination should be preserved.
        assert_eq!(parsed["extra_field"], json!("should_stay"));
        // Name should be updated.
        assert_eq!(parsed["name"], json!("Alice Updated"));
    }

    #[test]
    fn test_json_output_format() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![make_record("s1", "src/s1.json", json!({"name": "Alice"}))];
        let dest: Vec<SyncRecord> = vec![];

        let tm = make_table_mapping(
            "src_folder",
            "",
            vec![simple_mapping("name", "name")],
            None,
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.files_to_write.len(), 1);
        let content = &output.files_to_write[0].content;

        // Should end with trailing newline.
        assert!(content.ends_with('\n'));

        // Should be pretty-printed with 2-space indent.
        assert!(content.contains("  "), "Expected 2-space indent in JSON output");

        // Should be valid JSON.
        let _: Value = serde_json::from_str(content).unwrap();
    }

    #[test]
    fn test_mixed_creates_and_updates() {
        let registry = TransformerRegistry::new();
        let mut ctx = SyncContext::default();

        let source = vec![
            make_record("s1", "src/s1.json", json!({"email": "alice@test.com", "name": "Alice New"})),
            make_record("s2", "src/s2.json", json!({"email": "new@test.com", "name": "New Person"})),
        ];
        let dest = vec![
            make_record("d1", "dst/d1.json", json!({"email": "alice@test.com", "name": "Alice Old"})),
        ];

        let tm = make_table_mapping(
            "src_folder",
            "dst",
            vec![
                simple_mapping("email", "email"),
                simple_mapping("name", "name"),
            ],
            Some(RecordMatching {
                source_column_id: "email".to_string(),
                destination_column_id: "email".to_string(),
            }),
        );

        let output = sync_table_mapping(
            &tm,
            &source,
            &dest,
            None,
            None,
            SyncPhase::Data,
            &mut ctx,
            &registry,
        );

        assert_eq!(output.result.created, 1);
        assert_eq!(output.result.updated, 1);
        assert_eq!(output.files_to_write.len(), 2);
    }
}
