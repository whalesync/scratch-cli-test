use crate::registry::ValidatorRegistry;
use crate::traits::{ValidateContext, ValidationIssue};

/// The outcome of running all validators against a record.
#[derive(Debug, Clone)]
pub struct ValidationResult {
    /// Whether all validators passed (no errors — warnings are allowed).
    pub valid: bool,
    /// All issues found across all validators.
    pub issues: Vec<ValidationIssue>,
    /// Number of errors (non-warning issues).
    pub error_count: usize,
    /// Number of warnings.
    pub warning_count: usize,
}

/// Run all registered validators against a record.
///
/// Unlike the transformer pipeline (which chains sequentially), validators run
/// independently — each sees the same input and contributes its own issues.
/// All issues are collected; nothing short-circuits.
pub fn validate(ctx: &ValidateContext, registry: &ValidatorRegistry) -> ValidationResult {
    let mut issues = Vec::new();

    for validator in registry.all() {
        let validator_issues = validator.validate(ctx);
        issues.extend(validator_issues);
    }

    let error_count = issues.iter().filter(|i| !i.warning).count();
    let warning_count = issues.iter().filter(|i| i.warning).count();

    ValidationResult {
        valid: error_count == 0,
        issues,
        error_count,
        warning_count,
    }
}

/// Run only the named validators against a record.
///
/// Validators not found in the registry are silently skipped.
pub fn validate_with(
    ctx: &ValidateContext,
    registry: &ValidatorRegistry,
    validator_names: &[&str],
) -> ValidationResult {
    let mut issues = Vec::new();

    for name in validator_names {
        if let Some(validator) = registry.get(name) {
            let validator_issues = validator.validate(ctx);
            issues.extend(validator_issues);
        }
    }

    let error_count = issues.iter().filter(|i| !i.warning).count();
    let warning_count = issues.iter().filter(|i| i.warning).count();

    ValidationResult {
        valid: error_count == 0,
        issues,
        error_count,
        warning_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn make_ctx(record: serde_json::Value, schema: Option<serde_json::Value>) -> ValidateContext {
        ValidateContext {
            record,
            original_record: None,
            schema,
            folder_records: HashMap::new(),
            options: HashMap::new(),
            file_path: "/test/record.json".into(),
        }
    }

    #[test]
    fn valid_record_passes_all() {
        let registry = ValidatorRegistry::new();
        let ctx = make_ctx(
            json!({"name": "Alice"}),
            Some(json!({
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"]
            })),
        );
        let result = validate(&ctx, &registry);
        assert!(result.valid);
        assert_eq!(result.error_count, 0);
        assert!(result.issues.is_empty());
    }

    #[test]
    fn schema_violation_reported() {
        let registry = ValidatorRegistry::new();
        let ctx = make_ctx(
            json!({"name": 123}),
            Some(json!({
                "type": "object",
                "properties": {"name": {"type": "string"}}
            })),
        );
        let result = validate(&ctx, &registry);
        assert!(!result.valid);
        assert!(result.error_count > 0);
    }

    #[test]
    fn no_schema_no_errors() {
        let registry = ValidatorRegistry::new();
        let ctx = make_ctx(json!({"anything": "goes"}), None);
        let result = validate(&ctx, &registry);
        assert!(result.valid);
    }

    #[test]
    fn validate_with_specific_validators() {
        let registry = ValidatorRegistry::new();
        let ctx = make_ctx(
            json!({"name": 123}),
            Some(json!({
                "type": "object",
                "properties": {"name": {"type": "string"}}
            })),
        );

        // Only run readonly — should pass (no original to compare)
        let result = validate_with(&ctx, &registry, &["readonly_fields"]);
        assert!(result.valid);

        // Run json_schema — should fail
        let result = validate_with(&ctx, &registry, &["json_schema"]);
        assert!(!result.valid);
    }

    #[test]
    fn validate_with_unknown_validator_skips() {
        let registry = ValidatorRegistry::new();
        let ctx = make_ctx(json!({}), None);
        let result = validate_with(&ctx, &registry, &["nonexistent"]);
        assert!(result.valid);
        assert!(result.issues.is_empty());
    }
}
