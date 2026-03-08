use serde_json::Value;

/// Extract the ID column name from a schema. Defaults to "id".
///
/// Port of `_id_column` from `sync_engine.py:588-592`.
pub fn id_column(schema: Option<&Value>) -> &str {
    schema
        .and_then(|s| s.get("idColumnRemoteId"))
        .and_then(|v| v.as_str())
        .unwrap_or("id")
}

// Note: `is_pending_publish_id` lives in `filename.rs` — use
// `scratch_core::filename::is_pending_publish_id` instead.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_id_column_default() {
        assert_eq!(id_column(None), "id");
    }

    #[test]
    fn test_id_column_custom() {
        let schema = json!({"idColumnRemoteId": "recordId"});
        assert_eq!(id_column(Some(&schema)), "recordId");
    }

    #[test]
    fn test_id_column_missing_field() {
        let schema = json!({"other": "value"});
        assert_eq!(id_column(Some(&schema)), "id");
    }
}
