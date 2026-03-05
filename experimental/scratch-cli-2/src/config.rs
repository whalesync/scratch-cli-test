use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const CONFIG_FILE_NAME: &str = "scratchmd.config.yaml";
const CONFIG_FILE_VERSION: &str = "1";
pub const DEFAULT_SCRATCH_SERVER_URL: &str = "http://localhost:3010";

#[derive(Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(rename = "scratchServerUrl", default)]
    pub scratch_server_url: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub settings: Option<Settings>,
}

impl Config {
    /// Returns the resolved scratch server URL, applying defaults.
    pub fn scratch_server_url(&self) -> &str {
        match &self.settings {
            Some(s) if !s.scratch_server_url.is_empty() => &s.scratch_server_url,
            _ => DEFAULT_SCRATCH_SERVER_URL,
        }
    }
}

/// Load config from the given directory, applying CLI flag overrides.
/// If no config file exists, returns defaults.
pub fn load_config(dir: &Path, scratch_url_override: Option<&str>) -> Result<Config> {
    let path = dir.join(CONFIG_FILE_NAME);

    let mut config = if path.exists() {
        let data = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read config file: {}", path.display()))?;
        let mut config: Config =
            serde_yaml::from_str(&data).context("failed to parse config file")?;

        if config.version.is_empty() {
            config.version = CONFIG_FILE_VERSION.to_string();
        }
        if config.settings.is_none() {
            config.settings = Some(Settings {
                scratch_server_url: DEFAULT_SCRATCH_SERVER_URL.to_string(),
            });
        }
        if let Some(ref mut s) = config.settings {
            if s.scratch_server_url.is_empty() {
                s.scratch_server_url = DEFAULT_SCRATCH_SERVER_URL.to_string();
            }
        }
        config
    } else {
        Config {
            version: CONFIG_FILE_VERSION.to_string(),
            settings: Some(Settings {
                scratch_server_url: DEFAULT_SCRATCH_SERVER_URL.to_string(),
            }),
        }
    };

    // Apply CLI flag override
    if let Some(url) = scratch_url_override {
        if !url.is_empty() {
            config
                .settings
                .get_or_insert_with(|| Settings {
                    scratch_server_url: String::new(),
                })
                .scratch_server_url = url.to_string();
        }
    }

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    // ---- Config defaults ----

    #[test]
    fn no_config_file_returns_defaults() {
        let dir = tmp_dir();
        let config = load_config(dir.path(), None).unwrap();
        assert_eq!(config.scratch_server_url(), DEFAULT_SCRATCH_SERVER_URL);
        assert_eq!(config.version, "1");
    }

    // ---- Config file loading ----

    #[test]
    fn loads_config_from_yaml() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            "version: \"1\"\nsettings:\n  scratchServerUrl: \"https://custom.example.com\"\n",
        )
        .unwrap();
        let config = load_config(dir.path(), None).unwrap();
        assert_eq!(config.scratch_server_url(), "https://custom.example.com");
    }

    #[test]
    fn empty_config_file_gets_defaults() {
        let dir = tmp_dir();
        fs::write(dir.path().join(CONFIG_FILE_NAME), "").unwrap();
        let config = load_config(dir.path(), None).unwrap();
        assert_eq!(config.scratch_server_url(), DEFAULT_SCRATCH_SERVER_URL);
    }

    #[test]
    fn config_with_empty_url_gets_default() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            "version: \"1\"\nsettings:\n  scratchServerUrl: \"\"\n",
        )
        .unwrap();
        let config = load_config(dir.path(), None).unwrap();
        assert_eq!(config.scratch_server_url(), DEFAULT_SCRATCH_SERVER_URL);
    }

    #[test]
    fn config_without_version_gets_default_version() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            "settings:\n  scratchServerUrl: \"https://example.com\"\n",
        )
        .unwrap();
        let config = load_config(dir.path(), None).unwrap();
        assert_eq!(config.version, "1");
    }

    // ---- CLI flag override ----

    #[test]
    fn cli_override_takes_precedence() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            "version: \"1\"\nsettings:\n  scratchServerUrl: \"https://file.example.com\"\n",
        )
        .unwrap();
        let config = load_config(dir.path(), Some("https://override.example.com")).unwrap();
        assert_eq!(
            config.scratch_server_url(),
            "https://override.example.com"
        );
    }

    #[test]
    fn cli_override_without_config_file() {
        let dir = tmp_dir();
        let config = load_config(dir.path(), Some("https://override.example.com")).unwrap();
        assert_eq!(
            config.scratch_server_url(),
            "https://override.example.com"
        );
    }

    #[test]
    fn empty_cli_override_does_not_override() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            "version: \"1\"\nsettings:\n  scratchServerUrl: \"https://file.example.com\"\n",
        )
        .unwrap();
        let config = load_config(dir.path(), Some("")).unwrap();
        assert_eq!(config.scratch_server_url(), "https://file.example.com");
    }

    // ---- Config struct methods ----

    #[test]
    fn scratch_server_url_no_settings() {
        let config = Config {
            version: "1".into(),
            settings: None,
        };
        assert_eq!(config.scratch_server_url(), DEFAULT_SCRATCH_SERVER_URL);
    }

    #[test]
    fn scratch_server_url_empty_settings() {
        let config = Config {
            version: "1".into(),
            settings: Some(Settings {
                scratch_server_url: String::new(),
            }),
        };
        assert_eq!(config.scratch_server_url(), DEFAULT_SCRATCH_SERVER_URL);
    }

    #[test]
    fn scratch_server_url_custom() {
        let config = Config {
            version: "1".into(),
            settings: Some(Settings {
                scratch_server_url: "https://custom.com".into(),
            }),
        };
        assert_eq!(config.scratch_server_url(), "https://custom.com");
    }
}
