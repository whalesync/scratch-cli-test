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
    /// Shared bearer token the NestJS server presents to authenticate to this service
    /// (DEV-10600). When `None` (env var unset/empty), the HTTP APIs are unauthenticated —
    /// today's behavior, used for local dev, tests, and the smoke-test stack. When `Some`,
    /// the `require_auth` middleware enforces it on the `:3100` and `:3101` routers.
    pub shared_auth_token: Option<String>,
    /// Maximum age (in hours) a `{staging_dir}/{jobId}` directory may reach before the age-only
    /// startup sweep reaps it as orphaned (DEV-11317, default 72h). A crash/redeploy between
    /// `stage_files` and the caller's cleanup strands the dir forever; this bounds that leak. The
    /// server-side hourly cron adds a job-liveness gate on top of the same age threshold — this value
    /// is only the git service's own boot-time backstop, deliberately generous (72h) so it never races
    /// the crash-resume design: it covers pulls that legitimately run for days and leaves a window to
    /// debug a failed pull's staging dir before it is swept.
    pub staging_reap_max_age_hours: u64,
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

        let shared_auth_token = env::var("SCRATCH_GIT_AUTH_TOKEN").ok().and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        });

        let staging_reap_max_age_hours = env::var("GIT_STAGING_REAP_MAX_AGE_HOURS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(72);

        Self {
            port,
            git_backend_port,
            repos_dir,
            index_dir,
            staging_dir,
            build_version,
            slack_notification_webhook_url,
            shared_auth_token,
            staging_reap_max_age_hours,
        }
    }
}
