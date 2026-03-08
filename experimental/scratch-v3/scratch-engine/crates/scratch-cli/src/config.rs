use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::api_client::ApiClient;

const DEFAULT_API_URL: &str = "http://localhost:8000";

/// Workspace configuration stored in `.scratch/config.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub api_url: String,
    pub workbook_id: String,
    pub org_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
}

impl WorkspaceConfig {
    /// Load configuration from `.scratch/config.json` in the given workspace root,
    /// falling back to environment variables.
    pub fn load(workspace_root: &Path) -> Result<Self, String> {
        let config_path = workspace_root.join(".scratch/config.json");

        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("Failed to read config file: {e}"))?;
            let config: WorkspaceConfig = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config file: {e}"))?;
            return Ok(config);
        }

        // Fall back to environment variables
        let api_url = std::env::var("SCRATCH_API_URL").unwrap_or_else(|_| DEFAULT_API_URL.to_string());
        let workbook_id =
            std::env::var("SCRATCH_WORKBOOK_ID").map_err(|_| "SCRATCH_WORKBOOK_ID not set and no .scratch/config.json found".to_string())?;
        let org_id =
            std::env::var("SCRATCH_ORG_ID").map_err(|_| "SCRATCH_ORG_ID not set and no .scratch/config.json found".to_string())?;
        let auth_token = std::env::var("SCRATCH_AUTH_TOKEN").ok();

        Ok(Self {
            api_url,
            workbook_id,
            org_id,
            auth_token,
        })
    }

    /// Save the configuration to `.scratch/config.json`.
    pub fn save(&self, workspace_root: &Path) -> Result<(), String> {
        let scratch_dir = workspace_root.join(".scratch");
        std::fs::create_dir_all(&scratch_dir)
            .map_err(|e| format!("Failed to create .scratch directory: {e}"))?;

        let config_path = scratch_dir.join("config.json");
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {e}"))?;
        std::fs::write(&config_path, format!("{content}\n"))
            .map_err(|e| format!("Failed to write config file: {e}"))?;

        Ok(())
    }

    /// Resolve the effective API URL, with CLI flag taking priority over config.
    pub fn effective_api_url(&self, cli_override: Option<&str>) -> String {
        cli_override
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.api_url.clone())
    }

    /// Build an `ApiClient` from this config, with CLI overrides applied.
    ///
    /// Token priority: config file `auth_token` > `SCRATCH_AUTH_TOKEN` env var.
    pub fn api_client(&self, api_url_override: Option<&str>) -> ApiClient {
        let url = self.effective_api_url(api_url_override);
        let token = self
            .auth_token
            .clone()
            .or_else(|| std::env::var("SCRATCH_AUTH_TOKEN").ok());
        ApiClient::with_token(&url, token)
    }
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            api_url: DEFAULT_API_URL.to_string(),
            workbook_id: String::new(),
            org_id: String::new(),
            auth_token: None,
        }
    }
}
