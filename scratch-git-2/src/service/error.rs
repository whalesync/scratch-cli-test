use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),

    #[error("File not found")]
    NotFound(String),

    #[error("GC already in progress")]
    Conflict(String),

    /// 507: the request needs disk the service has budgeted away (e.g. the Live Export run store
    /// byte budget, `GIT_LE_RUN_STORE_MAX_BYTES`). The message says which budget and by how much.
    #[error("{0}")]
    InsufficientStorage(String),

    #[error("{0}")]
    Internal(String),

    #[error(transparent)]
    Git(#[from] gix::open::Error),
}

impl AppError {
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Internal(msg.into())
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError::BadRequest(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError::Conflict(msg.into())
    }

    pub fn insufficient_storage(msg: impl Into<String>) -> Self {
        AppError::InsufficientStorage(msg.into())
    }

    pub fn status_code(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::InsufficientStorage(_) => StatusCode::INSUFFICIENT_STORAGE,
            AppError::Internal(_) | AppError::Git(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let body = json!({ "error": self.to_string() });
        (status, axum::Json(body)).into_response()
    }
}
