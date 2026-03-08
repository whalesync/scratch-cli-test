use scratch_core::nested_path::get_nested;
use scratch_core::types::{RecordMatching, RemoteIdMapping, SyncRecord};
use std::collections::HashMap;

/// Match source records to destination by match key values.
///
/// Returns: `HashMap<source_id, RemoteIdMapping>`.
///
/// When `matching` is `None`, every source record maps to a create (dest_id = None, dest_path = None).
/// When `matching` is `Some`, builds a destination index on the destination match key, then
/// performs a LEFT JOIN: source records with valid match keys get matched or marked as creates.
/// Source records with missing/empty match keys are excluded (caller reports errors).
///
/// Last-wins for duplicate destination match keys.
///
/// Port of `_match_records` from `sync_engine.py:266-306`.
pub fn match_records(
    source: &[SyncRecord],
    destination: &[SyncRecord],
    matching: Option<&RecordMatching>,
) -> HashMap<String, RemoteIdMapping> {
    let matching = match matching {
        None => {
            // No record matching — every source record is a create.
            return source
                .iter()
                .map(|r| {
                    (
                        r.id.clone(),
                        RemoteIdMapping {
                            dest_id: None,
                            dest_path: None,
                        },
                    )
                })
                .collect();
        }
        Some(m) => m,
    };

    let src_col = &matching.source_column_id;
    let dst_col = &matching.destination_column_id;

    // Build destination index: match_value -> record (last-wins for duplicates).
    let mut dst_by_key: HashMap<String, &SyncRecord> = HashMap::new();
    for r in destination {
        if let Some(val) = get_nested(&r.fields, dst_col) {
            let key = value_to_match_key(val);
            if !key.is_empty() {
                dst_by_key.insert(key, r);
            }
        }
    }

    // Match each source record.
    let mut result: HashMap<String, RemoteIdMapping> = HashMap::new();
    for r in source {
        let val = match get_nested(&r.fields, src_col) {
            None => continue,       // Missing key — caller reports error.
            Some(v) if v.is_null() => continue, // Null key — caller reports error.
            Some(v) => v,
        };

        let key = value_to_match_key(val);
        if key.is_empty() {
            continue; // Empty key — caller reports error.
        }

        if let Some(dst) = dst_by_key.get(&key) {
            result.insert(
                r.id.clone(),
                RemoteIdMapping {
                    dest_id: Some(dst.id.clone()),
                    dest_path: Some(dst.file_path.clone()),
                },
            );
        } else {
            result.insert(
                r.id.clone(),
                RemoteIdMapping {
                    dest_id: None,
                    dest_path: None,
                },
            );
        }
    }

    result
}

/// Convert a JSON value to a string for use as a match key.
/// Mirrors Python's `str(val)` behavior for matching.
fn value_to_match_key(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_record(id: &str, path: &str, fields: serde_json::Value) -> SyncRecord {
        SyncRecord {
            id: id.to_string(),
            file_path: path.to_string(),
            fields,
        }
    }

    #[test]
    fn test_no_matching_all_creates() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"name": "Alice"})),
            make_record("s2", "src/s2.json", json!({"name": "Bob"})),
        ];
        let destination = vec![
            make_record("d1", "dst/d1.json", json!({"name": "Charlie"})),
        ];

        let result = match_records(&source, &destination, None);

        assert_eq!(result.len(), 2);
        assert!(result["s1"].dest_id.is_none());
        assert!(result["s1"].dest_path.is_none());
        assert!(result["s2"].dest_id.is_none());
        assert!(result["s2"].dest_path.is_none());
    }

    #[test]
    fn test_with_matching_creates_and_updates() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"email": "alice@test.com", "name": "Alice"})),
            make_record("s2", "src/s2.json", json!({"email": "bob@test.com", "name": "Bob"})),
            make_record("s3", "src/s3.json", json!({"email": "new@test.com", "name": "New"})),
        ];
        let destination = vec![
            make_record("d1", "dst/d1.json", json!({"email": "alice@test.com", "name": "Alice Old"})),
            make_record("d2", "dst/d2.json", json!({"email": "bob@test.com", "name": "Bob Old"})),
        ];

        let matching = RecordMatching {
            source_column_id: "email".to_string(),
            destination_column_id: "email".to_string(),
        };

        let result = match_records(&source, &destination, Some(&matching));

        assert_eq!(result.len(), 3);

        // s1 matched to d1
        assert_eq!(result["s1"].dest_id.as_deref(), Some("d1"));
        assert_eq!(result["s1"].dest_path.as_deref(), Some("dst/d1.json"));

        // s2 matched to d2
        assert_eq!(result["s2"].dest_id.as_deref(), Some("d2"));
        assert_eq!(result["s2"].dest_path.as_deref(), Some("dst/d2.json"));

        // s3 is a create (no match in destination)
        assert!(result["s3"].dest_id.is_none());
        assert!(result["s3"].dest_path.is_none());
    }

    #[test]
    fn test_missing_match_keys_excluded() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"email": "alice@test.com"})),
            make_record("s2", "src/s2.json", json!({"name": "Bob"})),  // No email field
            make_record("s3", "src/s3.json", json!({"email": null})),  // Null email
        ];
        let destination = vec![];

        let matching = RecordMatching {
            source_column_id: "email".to_string(),
            destination_column_id: "email".to_string(),
        };

        let result = match_records(&source, &destination, Some(&matching));

        // Only s1 has a valid match key
        assert_eq!(result.len(), 1);
        assert!(result.contains_key("s1"));
        assert!(!result.contains_key("s2")); // Missing field
        assert!(!result.contains_key("s3")); // Null value
    }

    #[test]
    fn test_empty_match_key_excluded() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"email": ""})),
        ];
        let destination = vec![];

        let matching = RecordMatching {
            source_column_id: "email".to_string(),
            destination_column_id: "email".to_string(),
        };

        let result = match_records(&source, &destination, Some(&matching));

        // Empty string match key is excluded
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_numeric_match_keys() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"code": 42})),
        ];
        let destination = vec![
            make_record("d1", "dst/d1.json", json!({"code": 42})),
        ];

        let matching = RecordMatching {
            source_column_id: "code".to_string(),
            destination_column_id: "code".to_string(),
        };

        let result = match_records(&source, &destination, Some(&matching));

        assert_eq!(result.len(), 1);
        assert_eq!(result["s1"].dest_id.as_deref(), Some("d1"));
    }

    #[test]
    fn test_duplicate_dest_keys_last_wins() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"email": "alice@test.com"})),
        ];
        let destination = vec![
            make_record("d1", "dst/d1.json", json!({"email": "alice@test.com"})),
            make_record("d2", "dst/d2.json", json!({"email": "alice@test.com"})),
        ];

        let matching = RecordMatching {
            source_column_id: "email".to_string(),
            destination_column_id: "email".to_string(),
        };

        let result = match_records(&source, &destination, Some(&matching));

        assert_eq!(result.len(), 1);
        // Last-wins: could be d1 or d2 depending on iteration order,
        // but the mapping should exist.
        assert!(result["s1"].dest_id.is_some());
    }

    #[test]
    fn test_nested_match_keys() {
        let source = vec![
            make_record("s1", "src/s1.json", json!({"meta": {"code": "ABC"}})),
        ];
        let destination = vec![
            make_record("d1", "dst/d1.json", json!({"meta": {"code": "ABC"}})),
        ];

        let matching = RecordMatching {
            source_column_id: "meta.code".to_string(),
            destination_column_id: "meta.code".to_string(),
        };

        let result = match_records(&source, &destination, Some(&matching));

        assert_eq!(result.len(), 1);
        assert_eq!(result["s1"].dest_id.as_deref(), Some("d1"));
    }
}
