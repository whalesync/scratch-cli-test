use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};
use serde_json::Value;
use serde_json_path::JsonPath;

/// JSONPath transformer that extracts values from complex JSON structures
/// using RFC 9535 JSONPath expressions.
///
/// If the source value is a string, it attempts to JSON parse it first.
///
/// Options:
/// - `expression` (string): JSONPath expression (e.g. "$.data.items[*].name").
///   If it doesn't start with `$`, `$.` is prepended.
/// - `path` (string): Alias for `expression` (legacy dot-path support).
/// - `arrayHandling` (string): How to handle multiple matches:
///   - "first" (default): Return first match
///   - "array": Return all matches as array
///   - "join_space": Join with space
///   - "join_comma": Join with comma+space
///   - "concat": Join without separator
pub struct JsonPathTransformer;

impl Transformer for JsonPathTransformer {
    fn name(&self) -> &str {
        "jsonpath"
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let expression = ctx
            .options
            .get("expression")
            .or_else(|| ctx.options.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let array_handling = ctx
            .options
            .get("arrayHandling")
            .and_then(|v| v.as_str())
            .unwrap_or("first");

        let value = &ctx.source_value;

        if value.is_null() {
            return TransformResult::Value(Value::Null);
        }

        if expression.is_empty() {
            return TransformResult::Value(value.clone());
        }

        // Auto-parse strings as JSON
        let document = if let Some(s) = value.as_str() {
            match serde_json::from_str::<Value>(s) {
                Ok(parsed) => parsed,
                Err(_) => {
                    return TransformResult::Error(
                        "Source value is a string that is not valid JSON".into(),
                    );
                }
            }
        } else {
            value.clone()
        };

        // If expression doesn't use JSONPath syntax, try legacy dot-path first
        // for backwards compatibility, then fall back to JSONPath
        let expr = if expression.starts_with('$') {
            expression.to_string()
        } else {
            format!("$.{}", expression)
        };

        let path = match JsonPath::parse(&expr) {
            Ok(p) => p,
            Err(e) => {
                // Fall back to simple dot-path traversal for legacy expressions
                // that may not be valid JSONPath
                return match scratch_core::nested_path::get_nested(&document, expression) {
                    Some(v) => TransformResult::Value(v.clone()),
                    None => TransformResult::Error(format!(
                        "Invalid JSONPath expression: {}",
                        e
                    )),
                };
            }
        };

        let node_list = path.query(&document);
        let results: Vec<&Value> = node_list.all();

        if results.is_empty() {
            return TransformResult::Error(format!(
                "JSONPath expression \"{}\" matched no values",
                expr
            ));
        }

        if results.len() == 1 {
            return TransformResult::Value(results[0].clone());
        }

        match array_handling {
            "array" => {
                let arr: Vec<Value> = results.into_iter().cloned().collect();
                TransformResult::Value(Value::Array(arr))
            }
            "join_space" => {
                let joined = results
                    .iter()
                    .map(|v| value_to_string(v))
                    .collect::<Vec<_>>()
                    .join(" ");
                TransformResult::Value(Value::String(joined))
            }
            "join_comma" => {
                let joined = results
                    .iter()
                    .map(|v| value_to_string(v))
                    .collect::<Vec<_>>()
                    .join(", ");
                TransformResult::Value(Value::String(joined))
            }
            "concat" => {
                let joined = results
                    .iter()
                    .map(|v| value_to_string(v))
                    .collect::<Vec<_>>()
                    .join("");
                TransformResult::Value(Value::String(joined))
            }
            // "first" or default
            _ => TransformResult::Value(results[0].clone()),
        }
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scratch_core::types::{SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;

    fn run_with_opts(value: Value, opts: HashMap<String, Value>) -> TransformResult {
        let ctx = TransformContext {
            source_record: SyncRecord {
                id: "r1".into(),
                file_path: "/t.json".into(),
                fields: json!({}),
            },
            source_field_path: "f".into(),
            source_value: value,
            destination_field_path: "f".into(),
            destination_value: None,
            lookup_tools: None,
            options: opts,
            phase: SyncPhase::Data,
        };
        JsonPathTransformer.transform(&ctx)
    }

    fn run_expr(value: Value, expression: &str) -> TransformResult {
        let mut opts = HashMap::new();
        opts.insert("expression".into(), json!(expression));
        run_with_opts(value, opts)
    }

    fn run_path(value: Value, path: &str) -> TransformResult {
        let mut opts = HashMap::new();
        opts.insert("path".into(), json!(path));
        run_with_opts(value, opts)
    }

    fn expect_value(result: TransformResult) -> Value {
        match result {
            TransformResult::Value(v) => v,
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    // --- Basic JSONPath ---
    #[test]
    fn simple_property() {
        let obj = json!({"name": "Alice", "age": 30});
        assert_eq!(expect_value(run_expr(obj, "$.name")), json!("Alice"));
    }

    #[test]
    fn nested_property() {
        let obj = json!({"a": {"b": {"c": 42}}});
        assert_eq!(expect_value(run_expr(obj, "$.a.b.c")), json!(42));
    }

    #[test]
    fn array_index() {
        let obj = json!({"items": [{"name": "first"}, {"name": "second"}]});
        assert_eq!(
            expect_value(run_expr(obj, "$.items[0].name")),
            json!("first")
        );
    }

    #[test]
    fn wildcard() {
        let obj = json!({"items": [{"name": "a"}, {"name": "b"}, {"name": "c"}]});
        let mut opts = HashMap::new();
        opts.insert("expression".into(), json!("$.items[*].name"));
        opts.insert("arrayHandling".into(), json!("array"));
        assert_eq!(
            expect_value(run_with_opts(obj, opts)),
            json!(["a", "b", "c"])
        );
    }

    // --- Legacy dot-path via `path` option ---
    #[test]
    fn legacy_dot_path() {
        let obj = json!({"name": "Alice"});
        assert_eq!(expect_value(run_path(obj, "name")), json!("Alice"));
    }

    #[test]
    fn legacy_nested_dot_path() {
        let obj = json!({"a": {"b": {"c": 42}}});
        assert_eq!(expect_value(run_path(obj, "a.b.c")), json!(42));
    }

    // --- Auto-parse strings ---
    #[test]
    fn auto_parse_json_string() {
        let s = json!(r#"{"data": {"value": 42}}"#);
        assert_eq!(expect_value(run_expr(s, "$.data.value")), json!(42));
    }

    #[test]
    fn non_json_string_is_error() {
        match run_expr(json!("not json"), "$.foo") {
            TransformResult::Error(e) => assert!(e.contains("not valid JSON")),
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    // --- Array handling ---
    #[test]
    fn array_handling_first() {
        let obj = json!({"items": [1, 2, 3]});
        let mut opts = HashMap::new();
        opts.insert("expression".into(), json!("$.items[*]"));
        opts.insert("arrayHandling".into(), json!("first"));
        assert_eq!(expect_value(run_with_opts(obj, opts)), json!(1));
    }

    #[test]
    fn array_handling_join_comma() {
        let obj = json!({"items": ["a", "b", "c"]});
        let mut opts = HashMap::new();
        opts.insert("expression".into(), json!("$.items[*]"));
        opts.insert("arrayHandling".into(), json!("join_comma"));
        assert_eq!(
            expect_value(run_with_opts(obj, opts)),
            json!("a, b, c")
        );
    }

    // --- Null handling ---
    #[test]
    fn null_returns_null() {
        assert_eq!(expect_value(run_expr(json!(null), "$.foo")), json!(null));
    }

    // --- No matches ---
    #[test]
    fn no_match_is_error() {
        let obj = json!({"a": 1});
        match run_expr(obj, "$.nonexistent") {
            TransformResult::Error(e) => assert!(e.contains("matched no values")),
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    // --- Empty expression passthrough ---
    #[test]
    fn empty_expression_passthrough() {
        let obj = json!({"a": 1});
        assert_eq!(expect_value(run_expr(obj.clone(), "")), obj);
    }
}
