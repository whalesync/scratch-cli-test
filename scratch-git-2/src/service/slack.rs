//! Optional Slack incoming webhook notification on service startup.

use reqwest::Client;
use std::time::Duration;

pub async fn send_startup_notification(webhook_url: &str, build_version: &str) {
    let client = match Client::builder().timeout(Duration::from_secs(10)).build() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Failed to build HTTP client for Slack notification: {e}");
            return;
        }
    };

    let body = serde_json::json!({
        "text": format!(
            "🌩️ Scratch Git server is starting (build version: {})",
            build_version
        )
    });

    match client
        .post(webhook_url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                tracing::warn!("Slack startup notification failed: HTTP {}", resp.status());
            }
        }
        Err(e) => tracing::warn!("Slack startup notification request failed: {e}"),
    }
}
