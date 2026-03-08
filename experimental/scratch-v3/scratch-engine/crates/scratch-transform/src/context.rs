use scratch_core::types::{RemoteIdMapping, SyncPhase, SyncRecord};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Closures for FK resolution — passed in by the sync engine when available.
pub struct LookupTools {
    /// Look up the destination mapping for a source FK value.
    /// `get_dest_mapping(fk_value, referenced_folder_id) -> Option<RemoteIdMapping>`
    pub get_dest_mapping:
        Box<dyn Fn(&str, &str) -> Option<RemoteIdMapping> + Send + Sync>,

    /// Look up a field value from a referenced record.
    /// `lookup_field(fk_value, referenced_folder_id, field_path) -> Option<Value>`
    pub lookup_field:
        Box<dyn Fn(&str, &str, &str) -> Option<Value> + Send + Sync>,
}

/// Rich context for a single transformer invocation.
pub struct TransformContext {
    /// The full source record being transformed.
    pub source_record: SyncRecord,
    /// Dot-path of the source field (e.g. "address.city").
    pub source_field_path: String,
    /// Current value to transform (output of the previous step in a pipeline).
    pub source_value: Value,
    /// Dot-path of the destination field.
    pub destination_field_path: String,
    /// Current value at the destination (if any).
    pub destination_value: Option<Value>,
    /// FK lookup closures — `None` when not available (e.g. outside a sync run).
    pub lookup_tools: Option<Arc<LookupTools>>,
    /// Per-transformer options from the `TransformerConfig.options` map.
    pub options: HashMap<String, Value>,
    /// Current sync phase.
    pub phase: SyncPhase,
}
