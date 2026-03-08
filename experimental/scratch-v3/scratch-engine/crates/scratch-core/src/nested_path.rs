use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static BRACKET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[(\d+)\]").unwrap());

/// Get a nested value by dot.path[0] notation.
///
/// Returns `None` if the path doesn't exist in the object (equivalent to Python's `_MISSING`).
/// Returns `Some(&Value::Null)` if the value is explicitly null.
pub fn get_nested<'a>(obj: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return None;
    }

    let expanded = BRACKET_RE.replace_all(path, ".$1");
    let parts: Vec<&str> = expanded.split('.').collect();

    let mut cur = obj;
    for part in parts {
        match cur {
            Value::Object(map) => {
                cur = map.get(part)?;
            }
            Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                cur = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(cur)
}

/// Set a nested value by dot.path notation. Creates intermediate objects as needed.
pub fn set_nested(obj: &mut Value, path: &str, value: Value) {
    if path.is_empty() {
        return;
    }

    let expanded = BRACKET_RE.replace_all(path, ".$1");
    let parts: Vec<&str> = expanded.split('.').collect();

    let mut cur = obj;
    for part in &parts[..parts.len() - 1] {
        match cur {
            Value::Object(map) => {
                cur = map
                    .entry(part.to_string())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()));
            }
            Value::Array(arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    if idx < arr.len() {
                        cur = &mut arr[idx];
                    } else {
                        return;
                    }
                } else {
                    return;
                }
            }
            _ => return,
        }
    }

    let last = parts[parts.len() - 1];
    match cur {
        Value::Object(map) => {
            map.insert(last.to_string(), value);
        }
        Value::Array(arr) => {
            if let Ok(idx) = last.parse::<usize>() {
                if idx < arr.len() {
                    arr[idx] = value;
                }
            }
        }
        _ => {}
    }
}

/// Build a nested object from parallel lists of dot-paths and values.
/// Like lodash `zipObjectDeep`.
pub fn zip_deep(paths: &[String], values: &[Value]) -> Value {
    let mut result = Value::Object(serde_json::Map::new());
    for (path, value) in paths.iter().zip(values.iter()) {
        set_nested(&mut result, path, value.clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_get_nested_simple() {
        let obj = json!({"name": "Alice", "age": 30});
        assert_eq!(get_nested(&obj, "name"), Some(&json!("Alice")));
        assert_eq!(get_nested(&obj, "age"), Some(&json!(30)));
        assert_eq!(get_nested(&obj, "missing"), None);
    }

    #[test]
    fn test_get_nested_deep() {
        let obj = json!({"a": {"b": {"c": 42}}});
        assert_eq!(get_nested(&obj, "a.b.c"), Some(&json!(42)));
        assert_eq!(get_nested(&obj, "a.b"), Some(&json!({"c": 42})));
        assert_eq!(get_nested(&obj, "a.b.d"), None);
    }

    #[test]
    fn test_get_nested_array() {
        let obj = json!({"items": [{"name": "first"}, {"name": "second"}]});
        assert_eq!(get_nested(&obj, "items[0].name"), Some(&json!("first")));
        assert_eq!(get_nested(&obj, "items[1].name"), Some(&json!("second")));
        assert_eq!(get_nested(&obj, "items[2].name"), None);
    }

    #[test]
    fn test_get_nested_null() {
        let obj = json!({"value": null});
        assert_eq!(get_nested(&obj, "value"), Some(&Value::Null));
    }

    #[test]
    fn test_get_nested_empty_path() {
        let obj = json!({"a": 1});
        assert_eq!(get_nested(&obj, ""), None);
    }

    #[test]
    fn test_set_nested_simple() {
        let mut obj = json!({});
        set_nested(&mut obj, "name", json!("Alice"));
        assert_eq!(obj, json!({"name": "Alice"}));
    }

    #[test]
    fn test_set_nested_deep() {
        let mut obj = json!({});
        set_nested(&mut obj, "a.b.c", json!(42));
        assert_eq!(obj, json!({"a": {"b": {"c": 42}}}));
    }

    #[test]
    fn test_set_nested_overwrite() {
        let mut obj = json!({"a": {"b": 1}});
        set_nested(&mut obj, "a.b", json!(2));
        assert_eq!(obj, json!({"a": {"b": 2}}));
    }

    #[test]
    fn test_set_nested_array() {
        let mut obj = json!({"items": [1, 2, 3]});
        set_nested(&mut obj, "items[1]", json!(99));
        assert_eq!(obj, json!({"items": [1, 99, 3]}));
    }

    #[test]
    fn test_set_nested_preserves_existing() {
        let mut obj = json!({"a": {"x": 1}});
        set_nested(&mut obj, "a.y", json!(2));
        assert_eq!(obj, json!({"a": {"x": 1, "y": 2}}));
    }

    #[test]
    fn test_zip_deep() {
        let paths = vec!["a.b".to_string(), "a.c".to_string(), "d".to_string()];
        let values = vec![json!(1), json!(2), json!(3)];
        let result = zip_deep(&paths, &values);
        assert_eq!(result, json!({"a": {"b": 1, "c": 2}, "d": 3}));
    }

    #[test]
    fn test_zip_deep_single() {
        let paths = vec!["name".to_string()];
        let values = vec![json!("Alice")];
        let result = zip_deep(&paths, &values);
        assert_eq!(result, json!({"name": "Alice"}));
    }

    #[test]
    fn test_zip_deep_empty() {
        let result = zip_deep(&[], &[]);
        assert_eq!(result, json!({}));
    }

    #[test]
    fn test_get_nested_non_dict() {
        let obj = json!("string");
        assert_eq!(get_nested(&obj, "anything"), None);
    }
}
