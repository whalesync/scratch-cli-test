use scratch_core::error::EngineError;
use scratch_core::nested_path::get_nested;
use scratch_core::schema::id_column;
use scratch_core::types::SyncRecord;
use serde_json::Value;

use crate::client::GitClient;

const BATCH_SIZE: usize = 200;

impl GitClient {
    /// Read all JSON records from a git folder → `Vec<SyncRecord>`.
    ///
    /// Lists files, filters to `.json` (skipping dotfiles), batch-reads contents,
    /// parses each to a `SyncRecord` using the given `id_col` for ID extraction.
    pub async fn read_folder_records(
        &self,
        repo_id: &str,
        folder_path: &str,
        branch: &str,
        id_col: &str,
    ) -> Result<Vec<SyncRecord>, EngineError> {
        let items = match self.list_files(repo_id, folder_path, branch).await {
            Ok(items) => items,
            Err(_) => return Ok(vec![]),
        };

        // Filter to .json files, skip dotfiles and non-files
        let paths: Vec<String> = items
            .iter()
            .filter(|item| {
                let is_file = item.get("type").and_then(|v| v.as_str()) == Some("file");
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                is_file && name.ends_with(".json") && !name.starts_with('.')
            })
            .filter_map(|item| item.get("path").and_then(|v| v.as_str()).map(String::from))
            .collect();

        if paths.is_empty() {
            return Ok(vec![]);
        }

        let mut records = Vec::with_capacity(paths.len());

        for chunk in paths.chunks(BATCH_SIZE) {
            let batch = match self
                .read_files_batch(repo_id, &chunk.to_vec(), branch)
                .await
            {
                Ok(batch) => batch,
                Err(_) => continue,
            };

            for item in &batch {
                let fields = match parse_file_content(item) {
                    Some(f) => f,
                    None => continue,
                };

                let record_id = match get_nested(&fields, id_col) {
                    Some(v) if !v.is_null() => value_to_string(v),
                    _ => continue,
                };

                let file_path = item
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                records.push(SyncRecord {
                    id: record_id,
                    file_path,
                    fields,
                });
            }
        }

        Ok(records)
    }

    /// Read `.scratch/schema.json` from a folder. Returns `None` if missing.
    pub async fn read_schema(
        &self,
        repo_id: &str,
        folder_path: &str,
        branch: &str,
    ) -> Result<Option<Value>, EngineError> {
        let stripped = folder_path.trim_start_matches('/');
        let schema_path = if stripped.is_empty() {
            ".scratch/schema.json".to_string()
        } else {
            format!("{stripped}/.scratch/schema.json")
        };

        match self.read_file(repo_id, &schema_path, branch).await {
            Ok(data) => Ok(parse_file_content(&data)),
            Err(_) => Ok(None),
        }
    }

    /// Read the ID column name from a folder's schema. Defaults to `"id"`.
    pub async fn read_id_column(
        &self,
        repo_id: &str,
        folder_path: &str,
        branch: &str,
    ) -> Result<String, EngineError> {
        let schema = self.read_schema(repo_id, folder_path, branch).await?;
        Ok(id_column(schema.as_ref()).to_string())
    }
}

/// Parse the `"content"` field of a git file entry into a JSON Value.
/// Handles both string content (needs JSON parse) and already-parsed objects.
fn parse_file_content(item: &Value) -> Option<Value> {
    match item.get("content") {
        Some(Value::String(s)) => serde_json::from_str(s).ok(),
        Some(v @ Value::Object(_)) => Some(v.clone()),
        _ => None,
    }
}

/// Convert a JSON value to a string for use as a record ID.
fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_file_content_string() {
        let item = json!({"path": "a.json", "content": "{\"id\": \"1\", \"name\": \"Alice\"}"});
        let result = parse_file_content(&item).unwrap();
        assert_eq!(result, json!({"id": "1", "name": "Alice"}));
    }

    #[test]
    fn test_parse_file_content_object() {
        let item = json!({"path": "a.json", "content": {"id": "1", "name": "Bob"}});
        let result = parse_file_content(&item).unwrap();
        assert_eq!(result, json!({"id": "1", "name": "Bob"}));
    }

    #[test]
    fn test_parse_file_content_missing() {
        let item = json!({"path": "a.json"});
        assert!(parse_file_content(&item).is_none());
    }

    #[test]
    fn test_parse_file_content_invalid_json() {
        let item = json!({"path": "a.json", "content": "not json"});
        assert!(parse_file_content(&item).is_none());
    }

    #[test]
    fn test_value_to_string_str() {
        assert_eq!(value_to_string(&json!("abc")), "abc");
    }

    #[test]
    fn test_value_to_string_number() {
        assert_eq!(value_to_string(&json!(42)), "42");
    }

    #[test]
    fn test_value_to_string_bool() {
        assert_eq!(value_to_string(&json!(true)), "true");
    }
}
