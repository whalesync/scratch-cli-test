use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub git_backend_port: u16,
    pub repos_dir: PathBuf,
    pub index_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub build_version: String,
    /// When set, POST a startup message to this Slack incoming webhook URL.
    pub slack_notification_webhook_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3100);

        let git_backend_port = env::var("GIT_BACKEND_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3101);

        let repos_dir = env::var("GIT_REPOS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("repos"));

        let repos_dir = if repos_dir.is_absolute() {
            repos_dir
        } else {
            env::current_dir().unwrap_or_default().join(repos_dir)
        };

        let index_dir = env::var("GIT_INDEX_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| repos_dir.clone());

        let staging_dir = env::var("GIT_STAGING_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| repos_dir.parent().unwrap_or(&repos_dir).join("staging"));

        let build_version = env::var("BUILD_VERSION").unwrap_or_else(|_| "0.0.0-local".to_string());

        let slack_notification_webhook_url = env::var("SLACK_NOTIFICATION_WEBHOOK_URL")
            .ok()
            .and_then(|s| {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            });

        Self {
            port,
            git_backend_port,
            repos_dir,
            index_dir,
            staging_dir,
            build_version,
            slack_notification_webhook_url,
        }
    }
}
