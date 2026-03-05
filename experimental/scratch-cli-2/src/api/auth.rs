use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::Client;

#[derive(Deserialize)]
pub struct AuthInitiateResponse {
    #[serde(rename = "userCode")]
    pub user_code: String,
    #[serde(rename = "pollingCode")]
    pub polling_code: String,
    #[serde(rename = "verificationUrl")]
    pub verification_url: String,
    #[serde(rename = "expiresIn")]
    pub expires_in: u64,
    #[serde(default)]
    pub interval: u64,
    #[serde(default)]
    pub error: String,
}

#[derive(Deserialize)]
pub struct AuthPollResponse {
    pub status: String,
    #[serde(rename = "apiToken", default)]
    pub api_token: String,
    #[serde(rename = "userEmail", default)]
    pub user_email: String,
    #[serde(rename = "tokenExpiresAt", default)]
    pub token_expires_at: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Serialize)]
struct PollBody {
    #[serde(rename = "pollingCode")]
    polling_code: String,
}

impl Client {
    pub fn initiate_auth(&self) -> Result<AuthInitiateResponse> {
        let resp = self.post_empty("/auth/initiate")?;
        Ok(resp.json()?)
    }

    pub fn poll_auth(&self, polling_code: &str) -> Result<AuthPollResponse> {
        let body = PollBody {
            polling_code: polling_code.to_string(),
        };
        let resp = self.post("/auth/poll", &body)?;
        Ok(resp.json()?)
    }
}
