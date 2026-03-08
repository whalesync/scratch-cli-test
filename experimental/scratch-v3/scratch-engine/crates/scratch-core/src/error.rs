use thiserror::Error;

#[derive(Error, Debug)]
pub enum EngineError {
    #[error("Transform failed for \"{field}\": {message}")]
    TransformFailed { field: String, message: String },

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Schema not found: {0}")]
    SchemaNotFound(String),

    #[error("Missing match key: {0}")]
    MissingMatchKey(String),

    #[error("Empty or invalid match key: {0}")]
    EmptyMatchKey(String),

    #[error("Folder not found: {0}")]
    FolderNotFound(String),

    #[error("Git client error: {0}")]
    GitClient(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}
