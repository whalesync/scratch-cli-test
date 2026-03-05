use anyhow::Result;
use serde::Deserialize;

use super::Client;

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct JobProgress {
    #[serde(rename = "bullJobId")]
    pub bull_job_id: String,
    pub state: String,
    #[serde(rename = "type", default)]
    pub job_type: String,
    #[serde(rename = "failedReason")]
    pub failed_reason: Option<String>,
    #[serde(rename = "finishedOn")]
    pub finished_on: Option<String>,
}

impl Client {
    pub fn get_job_progress(&self, job_id: &str) -> Result<JobProgress> {
        let resp = self.get(&format!("/jobs/{}/progress", job_id))?;
        Ok(resp.json()?)
    }
}
