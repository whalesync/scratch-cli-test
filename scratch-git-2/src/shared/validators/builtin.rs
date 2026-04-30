use super::{FieldValidationContext, ValidationResult};

/// Validates that a field value's string length does not exceed `max` characters.
/// Non-string values are coerced to their JSON representation for length measurement.
pub fn max_length(ctx: &FieldValidationContext) -> ValidationResult {
    let max = match ctx.args.get("max").and_then(|v| v.as_u64()) {
        Some(v) => v as usize,
        None => {
            return ValidationResult {
                is_valid: false,
                message: Some(
                    "max_length: missing or invalid 'max' parameter (expected a non-negative integer)".to_string(),
                ),
            };
        }
    };

    let len = match &ctx.value {
        serde_json::Value::String(s) => s.chars().count(),
        serde_json::Value::Null => 0,
        other => other.to_string().len(),
    };

    if len <= max {
        ValidationResult {
            is_valid: true,
            message: None,
        }
    } else {
        ValidationResult {
            is_valid: false,
            message: Some(format!(
                "value is {} character{} (max {})",
                len,
                if len == 1 { "" } else { "s" },
                max
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(value: serde_json::Value, max: u64) -> FieldValidationContext {
        FieldValidationContext {
            table: "Products".to_string(),
            filename: "rec-001.json".to_string(),
            field_path: "title".to_string(),
            value,
            record: json!({}),
            args: json!({ "max": max }),
        }
    }

    #[test]
    fn passes_under_limit() {
        let r = max_length(&ctx(json!("hello"), 50));
        assert!(r.is_valid);
        assert!(r.message.is_none());
    }

    #[test]
    fn fails_over_limit() {
        let r = max_length(&ctx(json!("x".repeat(101)), 100));
        assert!(!r.is_valid);
        assert!(r.message.is_some());
    }

    #[test]
    fn passes_at_exact_limit() {
        let r = max_length(&ctx(json!("x".repeat(100)), 100));
        assert!(r.is_valid);
    }

    #[test]
    fn null_value_passes() {
        let r = max_length(&ctx(json!(null), 10));
        assert!(r.is_valid);
    }

    #[test]
    fn missing_max_param_fails() {
        let ctx_bad = FieldValidationContext {
            table: "T".to_string(),
            filename: "f.json".to_string(),
            field_path: "x".to_string(),
            value: json!("hello"),
            record: json!({}),
            args: json!({}),
        };
        let r = max_length(&ctx_bad);
        assert!(!r.is_valid);
    }
}
