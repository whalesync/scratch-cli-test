//! Lodash-style dot-path access into `serde_json::Value` trees.
//!
//! Mirrors the TypeScript `IdPath` contract on the server (see
//! `server/src/remote-service/connectors/types.ts`). A connector schema
//! declares `idColumnRemoteId` as a dot path into a record file (e.g. `"id"`
//! for flat ids, `"id.record_id"` for Attio's id triple); both sides must
//! traverse it the same way.
//!
//! Path syntax:
//! * Segments are separated by `.`.
//! * An empty path returns the value itself.
//! * Traversal stops (returns `None`) at any non-object intermediate or
//!   missing segment.
//!
//! Bracket notation and array indices are intentionally not supported —
//! `idColumnRemoteId` only ever points at object-shaped ids.

use serde_json::Value;

/// Default id path used when a folder's schema.json doesn't declare its own
/// `idColumnRemoteId`. Mirrors the TypeScript fallback in
/// `getIdColumnFromSchema`.
pub const DEFAULT_ID_PATH: &str = "id";

/// Return the first segment of a dot path. Useful for matching a path against
/// a JSON Schema `required` array — those only list top-level field names, so
/// `"id.record_id"` reduces to `"id"` for that comparison.
pub fn id_path_root(path: &str) -> &str {
    path.split('.').next().unwrap_or(path)
}

/// Look up a value at a lodash-style dot path. Returns `None` if any segment
/// is missing or hits a non-object intermediate.
pub fn get_by_dot_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(value);
    }
    let mut current = value;
    for segment in path.split('.') {
        match current {
            Value::Object(map) => match map.get(segment) {
                Some(next) => current = next,
                None => return None,
            },
            _ => return None,
        }
    }
    Some(current)
}

/// Read the value at a record's id path and coerce it to a `String` suitable
/// for use as a file-index key. Returns `None` when the value is missing or
/// is neither a string nor a finite number — mirrors the TS
/// `readRecordIdAsString` helper.
pub fn read_record_id_as_string(record: &Value, id_path: &str) -> Option<String> {
    match get_by_dot_path(record, id_path)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => {
            // Reject NaN/inf — same gate as the TS helper's `Number.isFinite`.
            if n.is_f64() && !n.as_f64().is_some_and(f64::is_finite) {
                None
            } else {
                Some(n.to_string())
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn top_level_string_id() {
        let v = json!({ "id": "rec_123", "name": "x" });
        assert_eq!(get_by_dot_path(&v, "id"), Some(&json!("rec_123")));
    }

    #[test]
    fn nested_id_triple() {
        let v = json!({
            "id": { "workspace_id": "w", "object_id": "o", "record_id": "r" }
        });
        assert_eq!(get_by_dot_path(&v, "id.record_id"), Some(&json!("r")));
    }

    #[test]
    fn missing_path_returns_none() {
        let v = json!({ "id": "rec_123" });
        assert!(get_by_dot_path(&v, "id.record_id").is_none());
        assert!(get_by_dot_path(&v, "missing").is_none());
        assert!(get_by_dot_path(&v, "missing.deeper").is_none());
    }

    #[test]
    fn non_object_intermediate_returns_none() {
        // `id` is a string, can't traverse into it.
        let v = json!({ "id": "rec_123" });
        assert!(get_by_dot_path(&v, "id.foo").is_none());

        // Arrays are not objects either.
        let v = json!({ "id": ["a", "b"] });
        assert!(get_by_dot_path(&v, "id.0").is_none());
    }

    #[test]
    fn empty_path_returns_value() {
        let v = json!({ "id": "rec_123" });
        assert_eq!(get_by_dot_path(&v, ""), Some(&v));
    }

    #[test]
    fn read_id_as_string_handles_strings_and_numbers() {
        let v = json!({ "id": "rec_123" });
        assert_eq!(
            read_record_id_as_string(&v, "id"),
            Some("rec_123".to_string())
        );

        let v = json!({ "id": 42 });
        assert_eq!(read_record_id_as_string(&v, "id"), Some("42".to_string()));

        let v = json!({ "id": { "record_id": "r_1" } });
        assert_eq!(
            read_record_id_as_string(&v, "id.record_id"),
            Some("r_1".to_string())
        );
    }

    #[test]
    fn id_path_root_returns_first_segment() {
        assert_eq!(id_path_root("id"), "id");
        assert_eq!(id_path_root("id.record_id"), "id");
        assert_eq!(id_path_root("a.b.c"), "a");
        assert_eq!(id_path_root(""), "");
    }

    #[test]
    fn read_id_as_string_rejects_objects_and_arrays() {
        let v = json!({ "id": { "record_id": "r_1" } });
        // The whole id triple is an object — can't be coerced to a string id.
        assert_eq!(read_record_id_as_string(&v, "id"), None);

        let v = json!({ "id": ["a"] });
        assert_eq!(read_record_id_as_string(&v, "id"), None);

        let v = json!({ "id": null });
        assert_eq!(read_record_id_as_string(&v, "id"), None);

        let v = json!({});
        assert_eq!(read_record_id_as_string(&v, "id"), None);
    }
}
