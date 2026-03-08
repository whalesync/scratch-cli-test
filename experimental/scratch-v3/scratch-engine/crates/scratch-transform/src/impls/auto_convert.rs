use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};
use serde_json::Value;

/// Directed type-conversion transformer using `options.targetType`.
///
/// Converts source values to the specified target type: 'string', 'number',
/// 'integer', 'boolean', or 'array'. Returns an error for unknown target types.
pub struct AutoConvertTransformer;

impl Transformer for AutoConvertTransformer {
    fn name(&self) -> &str {
        "auto_convert"
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let target_type = ctx
            .options
            .get("targetType")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let value = &ctx.source_value;

        if value.is_null() {
            return TransformResult::Value(Value::Null);
        }

        match target_type {
            "string" => convert_to_string(value),
            "number" => convert_to_number(value),
            "integer" => convert_to_integer(value),
            "boolean" => convert_to_boolean(value),
            "array" => convert_to_array(value),
            _ => TransformResult::Error(format!(
                "Unable to convert automatically to destination type: {}",
                target_type
            )),
        }
    }
}

fn convert_to_string(value: &Value) -> TransformResult {
    match value {
        Value::String(_) => TransformResult::Value(value.clone()),
        Value::Number(n) => TransformResult::Value(Value::String(n.to_string())),
        Value::Bool(b) => TransformResult::Value(Value::String(b.to_string())),
        Value::Array(arr) => {
            if arr.is_empty() {
                TransformResult::Value(Value::String(String::new()))
            } else if arr.len() == 1 {
                TransformResult::Value(Value::String(value_to_string(&arr[0])))
            } else {
                let joined = arr.iter().map(|v| value_to_string(v)).collect::<Vec<_>>().join(", ");
                TransformResult::Value(Value::String(joined))
            }
        }
        _ => TransformResult::Error(format!("Cannot convert {} to string", value_type_name(value))),
    }
}

fn convert_to_number(value: &Value) -> TransformResult {
    match value {
        Value::Number(_) => TransformResult::Value(value.clone()),
        Value::Bool(b) => TransformResult::Value(Value::Number(if *b { 1.into() } else { 0.into() })),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return TransformResult::Value(Value::Null);
            }
            match trimmed.parse::<f64>() {
                Ok(f) if f.fract() == 0.0 && f.abs() < (i64::MAX as f64) => {
                    TransformResult::Value(Value::Number((f as i64).into()))
                }
                Ok(f) => match serde_json::Number::from_f64(f) {
                    Some(n) => TransformResult::Value(Value::Number(n)),
                    None => TransformResult::Error(format!("Cannot convert \"{}\" to number", s)),
                },
                Err(_) => TransformResult::Error(format!("Cannot convert \"{}\" to number", s)),
            }
        }
        Value::Array(arr) => {
            if arr.len() == 1 {
                convert_to_number(&arr[0])
            } else {
                TransformResult::Error(format!(
                    "Cannot convert array with {} elements to number",
                    arr.len()
                ))
            }
        }
        _ => TransformResult::Error(format!("Cannot convert {} to number", value_type_name(value))),
    }
}

fn convert_to_integer(value: &Value) -> TransformResult {
    let result = convert_to_number(value);
    match result {
        TransformResult::Value(Value::Number(ref n)) => {
            if let Some(f) = n.as_f64() {
                TransformResult::Value(Value::Number((f.trunc() as i64).into()))
            } else {
                result
            }
        }
        _ => result,
    }
}

fn convert_to_boolean(value: &Value) -> TransformResult {
    match value {
        Value::Bool(_) => TransformResult::Value(value.clone()),
        Value::Number(n) => {
            let is_nonzero = n.as_f64().map(|f| f != 0.0).unwrap_or(false);
            TransformResult::Value(Value::Bool(is_nonzero))
        }
        Value::String(s) => {
            let lower = s.trim().to_lowercase();
            if lower.is_empty() {
                return TransformResult::Value(Value::Null);
            }
            match lower.as_str() {
                "true" | "yes" | "1" => TransformResult::Value(Value::Bool(true)),
                "false" | "no" | "0" => TransformResult::Value(Value::Bool(false)),
                _ => TransformResult::Error(format!("Cannot convert \"{}\" to boolean", s)),
            }
        }
        Value::Array(arr) => {
            if arr.len() == 1 {
                convert_to_boolean(&arr[0])
            } else {
                TransformResult::Error(format!(
                    "Cannot convert array with {} elements to boolean",
                    arr.len()
                ))
            }
        }
        _ => TransformResult::Error(format!("Cannot convert {} to boolean", value_type_name(value))),
    }
}

fn convert_to_array(value: &Value) -> TransformResult {
    if value.is_array() {
        TransformResult::Value(value.clone())
    } else {
        TransformResult::Value(Value::Array(vec![value.clone()]))
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

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::TransformContext;
    use scratch_core::types::{SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;

    fn ctx_with_target(value: Value, target_type: &str) -> TransformContext {
        let mut opts = HashMap::new();
        opts.insert("targetType".into(), json!(target_type));
        TransformContext {
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
        }
    }

    fn run(value: Value, target_type: &str) -> TransformResult {
        let c = ctx_with_target(value, target_type);
        AutoConvertTransformer.transform(&c)
    }

    fn expect_value(value: Value, target_type: &str) -> Value {
        match run(value, target_type) {
            TransformResult::Value(v) => v,
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    fn expect_error(value: Value, target_type: &str) -> String {
        match run(value, target_type) {
            TransformResult::Error(e) => e,
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    // --- null passthrough ---
    #[test]
    fn null_passthrough() {
        assert_eq!(expect_value(json!(null), "string"), json!(null));
        assert_eq!(expect_value(json!(null), "number"), json!(null));
        assert_eq!(expect_value(json!(null), "boolean"), json!(null));
        assert_eq!(expect_value(json!(null), "array"), json!(null));
    }

    // --- string target ---
    #[test]
    fn string_from_string() {
        assert_eq!(expect_value(json!("hello"), "string"), json!("hello"));
    }

    #[test]
    fn string_from_number() {
        assert_eq!(expect_value(json!(42), "string"), json!("42"));
    }

    #[test]
    fn string_from_bool() {
        assert_eq!(expect_value(json!(true), "string"), json!("true"));
    }

    #[test]
    fn string_from_empty_array() {
        assert_eq!(expect_value(json!([]), "string"), json!(""));
    }

    #[test]
    fn string_from_single_array() {
        assert_eq!(expect_value(json!(["one"]), "string"), json!("one"));
    }

    #[test]
    fn string_from_multi_array() {
        assert_eq!(expect_value(json!(["a", "b", "c"]), "string"), json!("a, b, c"));
    }

    // --- number target ---
    #[test]
    fn number_from_number() {
        assert_eq!(expect_value(json!(42), "number"), json!(42));
    }

    #[test]
    fn number_from_bool() {
        assert_eq!(expect_value(json!(true), "number"), json!(1));
        assert_eq!(expect_value(json!(false), "number"), json!(0));
    }

    #[test]
    fn number_from_string() {
        assert_eq!(expect_value(json!("42"), "number"), json!(42));
        assert_eq!(expect_value(json!("3.14"), "number"), json!(3.14));
    }

    #[test]
    fn number_from_empty_string_is_null() {
        assert_eq!(expect_value(json!(""), "number"), json!(null));
        assert_eq!(expect_value(json!("  "), "number"), json!(null));
    }

    #[test]
    fn number_from_non_numeric_string_is_error() {
        expect_error(json!("hello"), "number");
    }

    #[test]
    fn number_from_single_array() {
        assert_eq!(expect_value(json!([42]), "number"), json!(42));
    }

    #[test]
    fn number_from_multi_array_is_error() {
        expect_error(json!([1, 2]), "number");
    }

    // --- integer target ---
    #[test]
    fn integer_truncates() {
        assert_eq!(expect_value(json!("3.7"), "integer"), json!(3));
        assert_eq!(expect_value(json!(3.7), "integer"), json!(3));
    }

    // --- boolean target ---
    #[test]
    fn boolean_from_bool() {
        assert_eq!(expect_value(json!(true), "boolean"), json!(true));
    }

    #[test]
    fn boolean_from_number() {
        assert_eq!(expect_value(json!(1), "boolean"), json!(true));
        assert_eq!(expect_value(json!(0), "boolean"), json!(false));
    }

    #[test]
    fn boolean_from_string() {
        assert_eq!(expect_value(json!("true"), "boolean"), json!(true));
        assert_eq!(expect_value(json!("yes"), "boolean"), json!(true));
        assert_eq!(expect_value(json!("false"), "boolean"), json!(false));
        assert_eq!(expect_value(json!("no"), "boolean"), json!(false));
        assert_eq!(expect_value(json!("1"), "boolean"), json!(true));
        assert_eq!(expect_value(json!("0"), "boolean"), json!(false));
    }

    #[test]
    fn boolean_from_empty_string_is_null() {
        assert_eq!(expect_value(json!(""), "boolean"), json!(null));
    }

    #[test]
    fn boolean_from_invalid_string_is_error() {
        expect_error(json!("maybe"), "boolean");
    }

    // --- array target ---
    #[test]
    fn array_from_array() {
        assert_eq!(expect_value(json!([1, 2]), "array"), json!([1, 2]));
    }

    #[test]
    fn array_wraps_scalar() {
        assert_eq!(expect_value(json!("hello"), "array"), json!(["hello"]));
        assert_eq!(expect_value(json!(42), "array"), json!([42]));
    }

    // --- unknown target type ---
    #[test]
    fn unknown_target_type_is_error() {
        expect_error(json!("hello"), "unknown");
    }

    #[test]
    fn empty_target_type_is_error() {
        expect_error(json!("hello"), "");
    }

    // --- directed conversion: string "42" stays "42" with target "string" ---
    #[test]
    fn string_42_stays_string_with_string_target() {
        assert_eq!(expect_value(json!("42"), "string"), json!("42"));
    }

    #[test]
    fn string_42_becomes_number_with_number_target() {
        assert_eq!(expect_value(json!("42"), "number"), json!(42));
    }
}
