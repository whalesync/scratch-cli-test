use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("git error: {0}")]
    Git(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("{0}")]
    Other(String),
}

impl From<gix::init::Error> for Error {
    fn from(e: gix::init::Error) -> Self {
        Error::Git(e.to_string())
    }
}

impl From<gix::open::Error> for Error {
    fn from(e: gix::open::Error) -> Self {
        Error::Git(e.to_string())
    }
}

// Axum requires errors to implement IntoResponse
impl axum::response::IntoResponse for Error {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({ "error": self.to_string() });
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(body),
        )
            .into_response()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
