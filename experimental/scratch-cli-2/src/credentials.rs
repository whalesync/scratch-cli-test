use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

const CREDENTIALS_DIR: &str = ".scratchmd";
const CREDENTIALS_FILE: &str = "credentials.yaml";
const CREDENTIALS_VERSION: &str = "2.0.0";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct EnvironmentCredentials {
    #[serde(rename = "apiToken", default, skip_serializing_if = "String::is_empty")]
    pub api_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub email: String,
    #[serde(rename = "expiresAt", default, skip_serializing_if = "String::is_empty")]
    pub expires_at: String,
}

#[derive(Serialize, Deserialize)]
struct CredentialsFile {
    #[serde(default)]
    version: String,
    #[serde(default)]
    environments: HashMap<String, EnvironmentCredentials>,
}

/// Old v1 format for migration
#[derive(Deserialize)]
struct LegacyCredentials {
    #[serde(rename = "apiToken", default)]
    api_token: String,
    #[serde(default)]
    email: String,
    #[serde(rename = "expiresAt", default)]
    expires_at: String,
}

fn credentials_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("failed to get home directory")?;
    Ok(home.join(CREDENTIALS_DIR).join(CREDENTIALS_FILE))
}

/// Normalize a server URL to just the hostname for use as a credentials key.
fn normalize_server_url(server_url: &str) -> String {
    if let Ok(parsed) = Url::parse(server_url) {
        if let Some(host) = parsed.host_str() {
            return host.to_string();
        }
    }
    server_url.to_string()
}

fn load_credentials_file() -> Result<CredentialsFile> {
    let path = credentials_path()?;

    if !path.exists() {
        return Ok(CredentialsFile {
            version: CREDENTIALS_VERSION.to_string(),
            environments: HashMap::new(),
        });
    }

    let data = std::fs::read_to_string(&path).context("failed to read credentials file")?;

    // Try new multi-environment format
    let mut creds_file: CredentialsFile =
        serde_yaml::from_str(&data).context("failed to parse credentials file")?;

    // Check for old single-environment format (apiToken at root level)
    if let Ok(old) = serde_yaml::from_str::<LegacyCredentials>(&data) {
        if !old.api_token.is_empty() && creds_file.environments.is_empty() {
            creds_file = CredentialsFile {
                version: CREDENTIALS_VERSION.to_string(),
                environments: HashMap::from([(
                    "default".to_string(),
                    EnvironmentCredentials {
                        api_token: old.api_token,
                        email: old.email,
                        expires_at: old.expires_at,
                    },
                )]),
            };
        }
    }

    if creds_file.version.is_empty() {
        creds_file.version = CREDENTIALS_VERSION.to_string();
    }

    Ok(creds_file)
}

fn save_credentials_file(creds_file: &CredentialsFile) -> Result<()> {
    let path = credentials_path()?;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("failed to create credentials directory")?;
    }

    let yaml = serde_yaml::to_string(creds_file).context("failed to serialize credentials")?;
    let content = format!(
        "# scratchmd user credentials\n# This file contains your API tokens for authenticated CLI operations\n# Credentials are stored per server environment\n\n{}",
        yaml
    );

    std::fs::write(&path, content).context("failed to write credentials file")?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

fn env_key(server_url: &str) -> String {
    if server_url.is_empty() {
        "default".to_string()
    } else {
        normalize_server_url(server_url)
    }
}

/// Load credentials for a specific server URL.
pub fn load_credentials(server_url: &str) -> Result<EnvironmentCredentials> {
    let creds_file = load_credentials_file()?;
    let key = env_key(server_url);

    Ok(creds_file
        .environments
        .get(&key)
        .cloned()
        .unwrap_or_default())
}

/// Save credentials for a specific server URL.
pub fn save_credentials(server_url: &str, creds: &EnvironmentCredentials) -> Result<()> {
    let mut creds_file = load_credentials_file()?;
    let key = env_key(server_url);
    creds_file.environments.insert(key, creds.clone());
    save_credentials_file(&creds_file)
}

/// Remove credentials for a specific server URL.
pub fn clear_credentials(server_url: &str) -> Result<()> {
    let mut creds_file = load_credentials_file()?;
    let key = env_key(server_url);
    creds_file.environments.remove(&key);
    save_credentials_file(&creds_file)
}

/// Check if credentials exist for a specific server URL.
pub fn is_logged_in(server_url: &str) -> bool {
    load_credentials(server_url)
        .map(|c| !c.api_token.is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- normalize_server_url ----

    #[test]
    fn normalize_http_url() {
        assert_eq!(
            normalize_server_url("http://localhost:3010"),
            "localhost"
        );
    }

    #[test]
    fn normalize_https_url() {
        assert_eq!(
            normalize_server_url("https://api.scratch.md"),
            "api.scratch.md"
        );
    }

    #[test]
    fn normalize_url_with_path() {
        assert_eq!(
            normalize_server_url("https://api.scratch.md/v1/foo"),
            "api.scratch.md"
        );
    }

    #[test]
    fn normalize_url_strips_port() {
        assert_eq!(
            normalize_server_url("http://example.com:8080"),
            "example.com"
        );
    }

    #[test]
    fn normalize_invalid_url_returns_as_is() {
        assert_eq!(normalize_server_url("not-a-url"), "not-a-url");
    }

    #[test]
    fn normalize_empty_string() {
        assert_eq!(normalize_server_url(""), "");
    }

    // ---- env_key ----

    #[test]
    fn env_key_empty_returns_default() {
        assert_eq!(env_key(""), "default");
    }

    #[test]
    fn env_key_url_returns_hostname() {
        assert_eq!(env_key("https://api.scratch.md"), "api.scratch.md");
    }

    #[test]
    fn env_key_localhost() {
        assert_eq!(env_key("http://localhost:3010"), "localhost");
    }

    // ---- CredentialsFile parsing ----

    #[test]
    fn parse_v2_credentials_file() {
        let yaml = r#"
version: "2.0.0"
environments:
  localhost:
    apiToken: "test-token-123"
    email: "user@example.com"
    expiresAt: "2026-12-31T00:00:00Z"
  api.scratch.md:
    apiToken: "prod-token-456"
    email: "prod@example.com"
"#;
        let creds: CredentialsFile = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(creds.version, "2.0.0");
        assert_eq!(creds.environments.len(), 2);

        let local = creds.environments.get("localhost").unwrap();
        assert_eq!(local.api_token, "test-token-123");
        assert_eq!(local.email, "user@example.com");
        assert_eq!(local.expires_at, "2026-12-31T00:00:00Z");

        let prod = creds.environments.get("api.scratch.md").unwrap();
        assert_eq!(prod.api_token, "prod-token-456");
        assert_eq!(prod.email, "prod@example.com");
    }

    #[test]
    fn parse_legacy_credentials() {
        let yaml = r#"
apiToken: "legacy-token"
email: "old@example.com"
expiresAt: "2025-01-01T00:00:00Z"
"#;
        let old: LegacyCredentials = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(old.api_token, "legacy-token");
        assert_eq!(old.email, "old@example.com");
        assert_eq!(old.expires_at, "2025-01-01T00:00:00Z");
    }

    #[test]
    fn empty_credentials_file_parses() {
        let yaml = "";
        let creds: CredentialsFile = serde_yaml::from_str(yaml).unwrap();
        assert!(creds.version.is_empty());
        assert!(creds.environments.is_empty());
    }

    #[test]
    fn credentials_file_missing_version() {
        let yaml = r#"
environments:
  localhost:
    apiToken: "token"
"#;
        let creds: CredentialsFile = serde_yaml::from_str(yaml).unwrap();
        assert!(creds.version.is_empty());
        assert_eq!(creds.environments.len(), 1);
    }

    // ---- EnvironmentCredentials serde ----

    #[test]
    fn environment_credentials_defaults() {
        let creds = EnvironmentCredentials::default();
        assert!(creds.api_token.is_empty());
        assert!(creds.email.is_empty());
        assert!(creds.expires_at.is_empty());
    }

    #[test]
    fn environment_credentials_roundtrip() {
        let creds = EnvironmentCredentials {
            api_token: "tok".into(),
            email: "e@e.com".into(),
            expires_at: "2026-01-01".into(),
        };
        let yaml = serde_yaml::to_string(&creds).unwrap();
        let parsed: EnvironmentCredentials = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.api_token, "tok");
        assert_eq!(parsed.email, "e@e.com");
        assert_eq!(parsed.expires_at, "2026-01-01");
    }

    #[test]
    fn environment_credentials_skip_empty_fields() {
        let creds = EnvironmentCredentials {
            api_token: "tok".into(),
            email: String::new(),
            expires_at: String::new(),
        };
        let yaml = serde_yaml::to_string(&creds).unwrap();
        assert!(!yaml.contains("email"));
        assert!(!yaml.contains("expiresAt"));
        assert!(yaml.contains("apiToken"));
    }
}
