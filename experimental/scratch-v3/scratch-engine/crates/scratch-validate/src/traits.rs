use serde_json::Value;
use std::collections::HashMap;

/// A single validation finding — either an error or a warning.
#[derive(Debug, Clone)]
pub struct ValidationIssue {
    /// JSON pointer to the problematic field (e.g. "/address/zip").
    pub path: String,
    /// Human-readable description of the issue.
    pub message: String,
    /// Severity: `true` for warnings (non-blocking), `false` for errors.
    pub warning: bool,
}

/// Context passed to each validator in the pipeline.
pub struct ValidateContext {
    /// The record being validated.
    pub record: Value,
    /// The record before edits (for change-detection validators like readonly).
    /// `None` when validating a brand-new record.
    pub original_record: Option<Value>,
    /// JSON Schema for this record's folder/table (if available).
    pub schema: Option<Value>,
    /// All sibling records in the same folder, keyed by filename.
    /// Used for cross-record validators (e.g. record-ref resolution).
    pub folder_records: HashMap<String, Value>,
    /// Per-validator options from configuration.
    pub options: HashMap<String, Value>,
    /// File path of the record being validated (for error reporting).
    pub file_path: String,
}

/// A validator checks a record and returns zero or more issues.
///
/// Each validator does one thing well. They compose into a pipeline:
/// run all validators, collect all issues.
pub trait Validator: Send + Sync {
    /// Unique key, e.g. "json_schema", "readonly_fields".
    fn name(&self) -> &str;

    /// Validate a record and return any issues found.
    fn validate(&self, ctx: &ValidateContext) -> Vec<ValidationIssue>;
}
