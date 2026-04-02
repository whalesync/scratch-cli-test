use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// ~/.scratchmd/credentials.yaml — matches the Go CLI format exactly.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CredentialsFile {
    pub version: String,
    pub environments: HashMap<String, EnvCredentials>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct EnvCredentials {
    #[serde(rename = "apiToken")]
    pub api_token: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub email: String,
    #[serde(
        rename = "expiresAt",
        skip_serializing_if = "String::is_empty",
        default
    )]
    pub expires_at: String,
}

fn credentials_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".scratchmd")
        .join("credentials.yaml")
}

/// Extract the hostname from a server URL for use as the environment key.
/// e.g. "https://api.scratch.md" → "api.scratch.md"
pub fn hostname_from_url(url: &str) -> String {
    url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(url)
        .split(':')
        .next()
        .unwrap_or(url)
        .to_string()
}

fn read_file() -> CredentialsFile {
    let path = credentials_path();
    if !path.exists() {
        return CredentialsFile {
            version: "2.0.0".to_string(),
            environments: HashMap::new(),
        };
    }
    let content = fs::read_to_string(&path).unwrap_or_default();
    serde_yaml::from_str(&content).unwrap_or_else(|_| CredentialsFile {
        version: "2.0.0".to_string(),
        environments: HashMap::new(),
    })
}

fn write_file(file: &CredentialsFile) -> anyhow::Result<()> {
    let path = credentials_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_yaml::to_string(file)?;
    fs::write(&path, content)?;
    // Restrict permissions to owner only
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn get(server_url: &str) -> Option<EnvCredentials> {
    let file = read_file();
    let key = hostname_from_url(server_url);
    // Try hostname key first, then "default" for backward compat
    file.environments
        .get(&key)
        .or_else(|| file.environments.get("default"))
        .cloned()
}

pub fn set(server_url: &str, creds: EnvCredentials) -> anyhow::Result<()> {
    let mut file = read_file();
    file.version = "2.0.0".to_string();
    let key = hostname_from_url(server_url);
    file.environments.insert(key, creds);
    write_file(&file)
}

pub fn clear(server_url: &str) -> anyhow::Result<()> {
    let mut file = read_file();
    let key = hostname_from_url(server_url);
    file.environments.remove(&key);
    file.environments.remove("default");
    write_file(&file)
}

pub fn is_logged_in(server_url: &str) -> bool {
    get(server_url)
        .map(|c| !c.api_token.is_empty())
        .unwrap_or(false)
}
