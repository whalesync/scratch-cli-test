use scratch_core::types::RemoteIdMapping;
use serde_json::Value;
use std::collections::HashMap;

/// Accumulated state across sync phases (replaces SQL tables).
///
/// This struct is ephemeral — it only lives in memory during a single sync run.
/// Tuple keys don't serialize well with serde, so we skip Serialize/Deserialize.
#[derive(Debug, Clone, Default)]
pub struct SyncContext {
    /// (source_folder_id, source_remote_id) -> RemoteIdMapping
    /// Replaces SyncMatchKeys + SyncRemoteIdMapping tables.
    pub remote_id_mappings: HashMap<(String, String), RemoteIdMapping>,
    /// (referenced_folder_id, fk_value) -> record fields
    /// Replaces SyncForeignKeyRecord table.
    pub fk_record_cache: HashMap<(String, String), Value>,
}
