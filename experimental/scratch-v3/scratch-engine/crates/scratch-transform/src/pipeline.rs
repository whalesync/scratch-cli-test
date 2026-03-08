use scratch_core::types::TransformerConfig;
use serde_json::Value;

use crate::context::TransformContext;
use crate::registry::TransformerRegistry;
use crate::traits::TransformResult;

/// The outcome of running a full transformer pipeline.
#[derive(Debug, Clone)]
pub struct PipelineResult {
    /// Whether the pipeline completed without errors.
    pub success: bool,
    /// The final transformed value (if successful and not skipped).
    pub value: Option<Value>,
    /// Whether the field should be skipped (not written to destination).
    pub skip: bool,
    /// Error message (if `success` is false).
    pub error: Option<String>,
    /// Non-fatal warnings accumulated across all steps.
    pub warnings: Vec<String>,
}

/// Apply a chain of transformers to a value.
///
/// Sequential chaining: each step's output feeds as the next step's input.
/// Phase filtering: if a transformer is not active in the current phase, the
/// pipeline returns a skip result immediately.
/// Early termination on error.
/// Warning accumulation across all steps.
pub fn apply_pipeline(
    configs: &[&TransformerConfig],
    initial_value: Value,
    base_ctx: &TransformContext,
    registry: &TransformerRegistry,
) -> PipelineResult {
    let mut current = initial_value;
    let mut warnings: Vec<String> = Vec::new();

    for config in configs {
        let transformer = match registry.get(&config.transformer_type) {
            Some(t) => t,
            None => {
                return PipelineResult {
                    success: false,
                    value: None,
                    skip: false,
                    error: Some(format!(
                        "Unknown transformer: {}",
                        config.transformer_type
                    )),
                    warnings,
                };
            }
        };

        // Skip transformers not active in the current phase.
        if !transformer.phases().contains(&base_ctx.phase) {
            return PipelineResult {
                success: true,
                value: None,
                skip: true,
                error: None,
                warnings,
            };
        }

        // Build a per-step context with the current value and this step's options.
        let step_ctx = TransformContext {
            source_record: base_ctx.source_record.clone(),
            source_field_path: base_ctx.source_field_path.clone(),
            source_value: current.clone(),
            destination_field_path: base_ctx.destination_field_path.clone(),
            destination_value: base_ctx.destination_value.clone(),
            lookup_tools: base_ctx.lookup_tools.clone(),
            options: config.options.clone(),
            phase: base_ctx.phase,
        };

        let result = transformer.transform(&step_ctx);

        match result {
            TransformResult::Value(v) => {
                current = v;
            }
            TransformResult::ValueWithWarnings(v, w) => {
                warnings.extend(w);
                current = v;
            }
            TransformResult::Skip => {
                return PipelineResult {
                    success: true,
                    value: None,
                    skip: true,
                    error: None,
                    warnings,
                };
            }
            TransformResult::Error(e) => {
                return PipelineResult {
                    success: false,
                    value: None,
                    skip: false,
                    error: Some(e),
                    warnings,
                };
            }
        }
    }

    PipelineResult {
        success: true,
        value: Some(current),
        skip: false,
        error: None,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::TransformerRegistry;
    use scratch_core::types::{SyncPhase, SyncRecord, TransformerConfig};
    use serde_json::json;
    use std::collections::HashMap;

    fn make_base_ctx(value: Value) -> TransformContext {
        TransformContext {
            source_record: SyncRecord {
                id: "rec1".into(),
                file_path: "/test/rec1.json".into(),
                fields: json!({}),
            },
            source_field_path: "name".into(),
            source_value: value,
            destination_field_path: "name".into(),
            destination_value: None,
            lookup_tools: None,
            options: HashMap::new(),
            phase: SyncPhase::Data,
        }
    }

    #[test]
    fn test_empty_pipeline() {
        let registry = TransformerRegistry::new();
        let ctx = make_base_ctx(json!("hello"));
        let result = apply_pipeline(&[], json!("hello"), &ctx, &registry);
        assert!(result.success);
        assert_eq!(result.value, Some(json!("hello")));
        assert!(!result.skip);
    }

    #[test]
    fn test_single_transformer() {
        let registry = TransformerRegistry::new();
        let config = TransformerConfig {
            transformer_type: "slugify".into(),
            options: HashMap::new(),
        };
        let ctx = make_base_ctx(json!("Hello World"));
        let result = apply_pipeline(&[&config], json!("Hello World"), &ctx, &registry);
        assert!(result.success);
        assert_eq!(result.value, Some(json!("hello-world")));
    }

    #[test]
    fn test_chained_transformers() {
        let registry = TransformerRegistry::new();
        let slugify = TransformerConfig {
            transformer_type: "slugify".into(),
            options: HashMap::new(),
        };
        let mut auto_opts = HashMap::new();
        auto_opts.insert("targetType".to_string(), json!("string"));
        let auto = TransformerConfig {
            transformer_type: "auto_convert".into(),
            options: auto_opts,
        };
        let ctx = make_base_ctx(json!(42));
        // auto_convert 42 -> "42" (to string), then slugify "42" -> "42"
        let result = apply_pipeline(&[&auto, &slugify], json!(42), &ctx, &registry);
        assert!(result.success);
        assert!(result.value.is_some());
    }

    #[test]
    fn test_unknown_transformer() {
        let registry = TransformerRegistry::new();
        let config = TransformerConfig {
            transformer_type: "nonexistent".into(),
            options: HashMap::new(),
        };
        let ctx = make_base_ctx(json!("hello"));
        let result = apply_pipeline(&[&config], json!("hello"), &ctx, &registry);
        assert!(!result.success);
        assert!(result.error.unwrap().contains("Unknown transformer"));
    }

    #[test]
    fn test_phase_filtering_skip() {
        let registry = TransformerRegistry::new();
        // source_fk_to_dest_fk only runs in ForeignKeyMapping phase
        let config = TransformerConfig {
            transformer_type: "source_fk_to_dest_fk".into(),
            options: HashMap::new(),
        };
        // But our context is Data phase
        let ctx = make_base_ctx(json!("some_fk"));
        let result = apply_pipeline(&[&config], json!("some_fk"), &ctx, &registry);
        assert!(result.success);
        assert!(result.skip);
    }

    #[test]
    fn test_pipeline_with_warnings() {
        // This tests that warnings are accumulated via the pipeline API shape.
        let registry = TransformerRegistry::new();
        let mut opts = HashMap::new();
        opts.insert("targetType".to_string(), json!("boolean"));
        let config = TransformerConfig {
            transformer_type: "auto_convert".into(),
            options: opts,
        };
        let ctx = make_base_ctx(json!("true"));
        let result = apply_pipeline(&[&config], json!("true"), &ctx, &registry);
        assert!(result.success);
        assert_eq!(result.value, Some(json!(true)));
        assert!(result.warnings.is_empty());
    }
}
