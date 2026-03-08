use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// A record read from a git-backed folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub id: String,
    pub file_path: String,
    pub fields: Value,
}

/// A file to write to git.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    pub path: String,
    pub content: String,
}

/// Result of a sync operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub created: usize,
    pub updated: usize,
    pub created_paths: Vec<String>,
    pub updated_paths: Vec<String>,
    pub errors: Vec<SyncError>,
    pub warnings: Vec<SyncWarning>,
}

impl SyncResult {
    pub fn merge(&mut self, other: SyncResult) {
        self.created += other.created;
        self.updated += other.updated;
        self.created_paths.extend(other.created_paths);
        self.updated_paths.extend(other.updated_paths);
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub source_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWarning {
    pub source_id: String,
    pub warning: String,
}

/// A change detected in git status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: FileChangeStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeStatus {
    Added,
    Modified,
    Deleted,
}

/// A publish operation in a publish plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOperation {
    pub phase: PublishPhase,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_folder_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PublishPhase {
    Edit,
    Create,
    Delete,
    Backfill,
    RenameFiles,
}

/// Sync phase (DATA or FOREIGN_KEY_MAPPING).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SyncPhase {
    Data,
    ForeignKeyMapping,
}

/// A complete sync mapping configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMapping {
    pub table_mappings: Vec<TableMapping>,
}

/// A mapping between source and destination folders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMapping {
    pub source_data_folder_id: String,
    pub destination_data_folder_id: String,
    #[serde(default)]
    pub column_mappings: Vec<ColumnMapping>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_matching: Option<RecordMatching>,
}

/// A column mapping with optional transformers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub source_column_id: String,
    pub destination_column_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transformers: Vec<TransformerConfig>,
    /// Legacy single transformer field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transformer: Option<TransformerConfig>,
}

impl ColumnMapping {
    /// Get all transformer configs, handling both `transformers` list and legacy `transformer` field.
    pub fn transformer_configs(&self) -> Vec<&TransformerConfig> {
        if !self.transformers.is_empty() {
            self.transformers.iter().collect()
        } else if let Some(ref t) = self.transformer {
            vec![t]
        } else {
            vec![]
        }
    }
}

/// Configuration for a single transformer step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformerConfig {
    #[serde(rename = "type")]
    pub transformer_type: String,
    #[serde(default)]
    pub options: HashMap<String, Value>,
}

/// Record matching configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMatching {
    pub source_column_id: String,
    pub destination_column_id: String,
}

/// Table specification from a schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_column_remote_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug_column_remote_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
}

/// Remote ID mapping for sync context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIdMapping {
    pub dest_id: Option<String>,
    pub dest_path: Option<String>,
}

/// Output of a sync run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutput {
    pub files_to_write: Vec<FileWrite>,
    pub result: SyncResult,
}

/// A publish plan — list of ordered operations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPlan {
    pub operations: Vec<PublishOperation>,
}
