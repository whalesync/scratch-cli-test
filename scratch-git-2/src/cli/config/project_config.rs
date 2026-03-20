use serde::Deserialize;

const CONFIG_FILE_NAME: &str = "scratchmd.config.yaml";

#[derive(Debug, Default, Deserialize)]
struct ConfigFile {
    #[serde(default)]
    settings: ConfigSettings,
}

#[derive(Debug, Default, Deserialize)]
struct ConfigSettings {
    #[serde(rename = "scratchServerUrl", default)]
    scratch_server_url: String,
}

/// Load the project config file and return the server URL it specifies, if any.
///
/// Looks for `scratchmd.config.yaml` (or the path from `--config`) in the current directory.
/// Returns `None` if the file doesn't exist or has no `scratchServerUrl` set.
pub fn load_server_url(config_path: Option<&str>) -> Option<String> {
    let path = match config_path {
        Some(p) => std::path::PathBuf::from(p),
        None => std::env::current_dir().ok()?.join(CONFIG_FILE_NAME),
    };

    let content = std::fs::read_to_string(&path).ok()?;
    let cfg: ConfigFile = serde_yaml::from_str(&content).ok()?;

    if cfg.settings.scratch_server_url.is_empty() {
        None
    } else {
        Some(cfg.settings.scratch_server_url)
    }
}
