use crate::service::error::AppError;

/// 3-way merge of file contents with conflict resolution using "ours" strategy.
pub fn merge_file_contents(base: &str, ours: &str, theirs: &str) -> Result<String, AppError> {
    crate::shared::merge::merge_file_contents(base, ours, theirs)
        .map_err(|e| AppError::internal(e))
}
