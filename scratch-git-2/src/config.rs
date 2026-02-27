use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub repos_dir: PathBuf,
    pub build_version: String,
}

impl Config {
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3100);

        let repos_dir = env::var("GIT_REPOS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("repos"));

        let repos_dir = if repos_dir.is_absolute() {
            repos_dir
        } else {
            env::current_dir().unwrap_or_default().join(repos_dir)
        };

        let build_version =
            env::var("BUILD_VERSION").unwrap_or_else(|_| "0.0.0-local".to_string());

        Self {
            port,
            repos_dir,
            build_version,
        }
    }
}
