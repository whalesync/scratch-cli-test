use crate::traits::{ValidateContext, ValidationIssue, Validator};

/// Validates a record against its JSON Schema.
///
/// Wraps the `jsonschema` crate. If no schema is present in the context,
/// returns no issues (nothing to check).
pub struct JsonSchemaValidator;

impl Validator for JsonSchemaValidator {
    fn name(&self) -> &str {
        "json_schema"
    }

    fn validate(&self, ctx: &ValidateContext) -> Vec<ValidationIssue> {
        let Some(ref schema) = ctx.schema else {
            return vec![];
        };

        let validator = match jsonschema::validator_for(schema) {
            Ok(v) => v,
            Err(e) => {
                return vec![ValidationIssue {
                    path: String::new(),
                    message: format!("Failed to compile schema: {e}"),
                    warning: false,
                }];
            }
        };

        validator
            .iter_errors(&ctx.record)
            .map(|err| {
                let path = err
                    .instance_path
                    .into_iter()
                    .map(|segment| segment.to_string())
                    .collect::<Vec<_>>()
                    .join("/");
                ValidationIssue {
                    path: if path.is_empty() {
                        String::new()
                    } else {
                        format!("/{path}")
                    },
                    message: err.to_string(),
                    warning: false,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn ctx_with_schema(record: serde_json::Value, schema: serde_json::Value) -> ValidateContext {
        ValidateContext {
            record,
            original_record: None,
            schema: Some(schema),
            folder_records: HashMap::new(),
            options: HashMap::new(),
            file_path: "/test/record.json".into(),
        }
    }

    #[test]
    fn valid_record() {
        let v = JsonSchemaValidator;
        let ctx = ctx_with_schema(
            json!({"name": "Alice", "age": 30}),
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "integer"}
                },
                "required": ["name"]
            }),
        );
        assert!(v.validate(&ctx).is_empty());
    }

    #[test]
    fn missing_required_field() {
        let v = JsonSchemaValidator;
        let ctx = ctx_with_schema(
            json!({"age": 30}),
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                },
                "required": ["name"]
            }),
        );
        let issues = v.validate(&ctx);
        assert!(!issues.is_empty());
        assert!(issues.iter().any(|i| i.message.contains("name")));
        assert!(issues.iter().all(|i| !i.warning));
    }

    #[test]
    fn wrong_type() {
        let v = JsonSchemaValidator;
        let ctx = ctx_with_schema(
            json!({"name": 123}),
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }),
        );
        let issues = v.validate(&ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, "/name");
    }

    #[test]
    fn no_schema_returns_empty() {
        let v = JsonSchemaValidator;
        let ctx = ValidateContext {
            record: json!({"anything": "goes"}),
            original_record: None,
            schema: None,
            folder_records: HashMap::new(),
            options: HashMap::new(),
            file_path: "/test/record.json".into(),
        };
        assert!(v.validate(&ctx).is_empty());
    }
}
