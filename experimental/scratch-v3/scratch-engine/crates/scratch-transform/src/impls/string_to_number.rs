use crate::context::TransformContext;
use crate::traits::{TransformResult, Transformer};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static CURRENCY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[$€£¥₹₽₩₴₸₪฿₫₦₵₲]").unwrap());

/// Convert a string to a number.
///
/// Options:
/// - `stripCurrency` (bool): Remove currency symbols and commas before parsing.
/// - `parseInteger` (bool): Use integer parsing (truncates decimals).
///
/// Returns null for null/empty input, error for unparseable values.
pub struct StringToNumberTransformer;

impl Transformer for StringToNumberTransformer {
    fn name(&self) -> &str {
        "string_to_number"
    }

    fn transform(&self, ctx: &TransformContext) -> TransformResult {
        let value = &ctx.source_value;

        let strip_currency = ctx
            .options
            .get("stripCurrency")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let parse_integer = ctx
            .options
            .get("parseInteger")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Handle null
        if value.is_null() {
            return TransformResult::Value(Value::Null);
        }

        // Already a number — optionally truncate for parseInteger
        if value.is_i64() || value.is_u64() || value.is_f64() {
            if parse_integer {
                if let Some(f) = value.as_f64() {
                    return TransformResult::Value(Value::Number((f.floor() as i64).into()));
                }
            }
            return TransformResult::Value(value.clone());
        }

        // Must be a string to transform
        let raw = match value.as_str() {
            Some(s) => s.to_string(),
            None => {
                return TransformResult::Error(format!(
                    "Expected string or number, got {}",
                    match value {
                        Value::Bool(_) => "boolean",
                        Value::Array(_) => "array",
                        Value::Object(_) => "object",
                        _ => "unknown",
                    }
                ));
            }
        };

        let mut cleaned = raw.trim().to_string();

        // Strip currency symbols if requested
        if strip_currency {
            cleaned = CURRENCY_RE.replace_all(&cleaned, "").to_string();
            cleaned = cleaned.replace(',', "");
            cleaned = cleaned.trim().to_string();
        }

        // Empty string after cleaning → null
        if cleaned.is_empty() {
            return TransformResult::Value(Value::Null);
        }

        if parse_integer {
            // parseInt behavior: parse prefix
            match cleaned.parse::<i64>() {
                Ok(n) => return TransformResult::Value(Value::Number(n.into())),
                Err(_) => {
                    // Try parsing as float and truncating
                    match cleaned.parse::<f64>() {
                        Ok(f) if f.is_finite() => {
                            return TransformResult::Value(Value::Number((f.trunc() as i64).into()));
                        }
                        _ => {}
                    }
                }
            }
        } else {
            // Strip commas even without stripCurrency for basic thousands separator support
            let s = cleaned.replace(',', "");

            // Try int
            if let Ok(n) = s.parse::<i64>() {
                return TransformResult::Value(Value::Number(n.into()));
            }

            // Try float
            if let Ok(f) = s.parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(f) {
                    return TransformResult::Value(Value::Number(n));
                }
            }
        }

        // Unparseable → error
        TransformResult::Error(format!("Could not parse \"{}\" as a number", raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scratch_core::types::{SyncPhase, SyncRecord};
    use serde_json::json;
    use std::collections::HashMap;

    fn ctx_with_opts(value: Value, opts: HashMap<String, Value>) -> TransformContext {
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

    fn run(value: Value) -> TransformResult {
        let ctx = ctx_with_opts(value, HashMap::new());
        StringToNumberTransformer.transform(&ctx)
    }

    fn run_with_opts(value: Value, strip_currency: bool, parse_integer: bool) -> TransformResult {
        let mut opts = HashMap::new();
        if strip_currency {
            opts.insert("stripCurrency".into(), json!(true));
        }
        if parse_integer {
            opts.insert("parseInteger".into(), json!(true));
        }
        let ctx = ctx_with_opts(value, opts);
        StringToNumberTransformer.transform(&ctx)
    }

    fn expect_value(result: TransformResult) -> Value {
        match result {
            TransformResult::Value(v) => v,
            other => panic!("Expected Value, got {:?}", other),
        }
    }

    fn expect_error(result: TransformResult) -> String {
        match result {
            TransformResult::Error(e) => e,
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn null_passthrough() {
        assert_eq!(expect_value(run(json!(null))), json!(null));
    }

    #[test]
    fn int_string() {
        assert_eq!(expect_value(run(json!("42"))), json!(42));
        assert_eq!(expect_value(run(json!("-7"))), json!(-7));
    }

    #[test]
    fn float_string() {
        assert_eq!(expect_value(run(json!("3.14"))), json!(3.14));
    }

    #[test]
    fn comma_separated() {
        assert_eq!(expect_value(run(json!("1,000"))), json!(1000));
        assert_eq!(expect_value(run(json!("1,234,567"))), json!(1234567));
    }

    #[test]
    fn already_number() {
        assert_eq!(expect_value(run(json!(42))), json!(42));
        assert_eq!(expect_value(run(json!(3.14))), json!(3.14));
    }

    #[test]
    fn non_numeric_is_error() {
        expect_error(run(json!("hello")));
        expect_error(run(json!("abc123")));
    }

    #[test]
    fn empty_string_is_null() {
        assert_eq!(expect_value(run(json!(""))), json!(null));
        assert_eq!(expect_value(run(json!("  "))), json!(null));
    }

    #[test]
    fn whitespace_trimming() {
        assert_eq!(expect_value(run(json!("  42  "))), json!(42));
    }

    #[test]
    fn strip_currency_option() {
        assert_eq!(expect_value(run_with_opts(json!("$42.50"), true, false)), json!(42.5));
        assert_eq!(expect_value(run_with_opts(json!("€1,234"), true, false)), json!(1234));
        assert_eq!(expect_value(run_with_opts(json!("£10"), true, false)), json!(10));
    }

    #[test]
    fn parse_integer_option() {
        assert_eq!(expect_value(run_with_opts(json!("3.7"), false, true)), json!(3));
        assert_eq!(expect_value(run_with_opts(json!(3.7), false, true)), json!(3));
    }

    #[test]
    fn non_string_non_number_is_error() {
        expect_error(run(json!(true)));
        expect_error(run(json!([1, 2])));
    }
}
