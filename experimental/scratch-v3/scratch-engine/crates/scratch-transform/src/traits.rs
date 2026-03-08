use scratch_core::types::SyncPhase;
use serde_json::Value;

use crate::context::TransformContext;

/// The result of a single transformer invocation.
#[derive(Debug)]
pub enum TransformResult {
    /// Successfully produced a value.
    Value(Value),
    /// Skip this field entirely (do not set destination).
    Skip,
    /// Transformer encountered an error.
    Error(String),
    /// Produced a value but with non-fatal warnings.
    ValueWithWarnings(Value, Vec<String>),
}

/// A transformer converts a source value into a destination value.
///
/// Simple transformers only need to implement `transform`. Complex ones (FK lookups)
/// override `transform` and use `ctx.lookup_tools`.
pub trait Transformer: Send + Sync {
    /// Unique key, e.g. "slugify".
    fn name(&self) -> &str;

    /// Sync phases this transformer runs in. Default: `[SyncPhase::Data]`.
    fn phases(&self) -> &[SyncPhase] {
        &[SyncPhase::Data]
    }

    /// Transform a value given the full context.
    fn transform(&self, ctx: &TransformContext) -> TransformResult;
}
