use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::Client;

#[derive(Deserialize, Serialize)]
pub struct SyncTablePair {
    pub id: String,
    #[serde(rename = "syncId")]
    pub sync_id: String,
    #[serde(rename = "sourceDataFolderId")]
    pub source_data_folder_id: String,
    #[serde(rename = "destinationDataFolderId")]
    pub destination_data_folder_id: String,
}

#[derive(Deserialize, Serialize)]
pub struct Sync {
    pub id: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(rename = "displayOrder", default)]
    pub display_order: i32,
    #[serde(default)]
    pub mappings: serde_json::Value,
    #[serde(rename = "syncState", default)]
    pub sync_state: String,
    #[serde(rename = "syncStateLastChanged")]
    pub sync_state_last_changed: Option<String>,
    #[serde(rename = "lastSyncTime")]
    pub last_sync_time: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
    #[serde(rename = "syncTablePairs", default)]
    pub sync_table_pairs: Vec<SyncTablePair>,
}

#[derive(Deserialize, Serialize)]
pub struct RunSyncResponse {
    pub success: bool,
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(default)]
    pub message: String,
}

impl Client {
    pub fn list_syncs(&self, workbook_id: &str) -> Result<Vec<Sync>> {
        let resp = self.get(&format!("/workbooks/{}/syncs", workbook_id))?;
        Ok(resp.json()?)
    }

    pub fn get_sync(&self, workbook_id: &str, sync_id: &str) -> Result<Sync> {
        let resp = self.get(&format!("/workbooks/{}/syncs/{}", workbook_id, sync_id))?;
        Ok(resp.json()?)
    }

    pub fn get_sync_raw(&self, workbook_id: &str, sync_id: &str) -> Result<serde_json::Value> {
        let resp = self.get(&format!("/workbooks/{}/syncs/{}", workbook_id, sync_id))?;
        Ok(resp.json()?)
    }

    pub fn create_sync(
        &self,
        workbook_id: &str,
        body: &serde_json::Value,
    ) -> Result<Sync> {
        let resp = self.post(&format!("/workbooks/{}/syncs", workbook_id), body)?;
        Ok(resp.json()?)
    }

    pub fn update_sync(
        &self,
        workbook_id: &str,
        sync_id: &str,
        body: &serde_json::Value,
    ) -> Result<Sync> {
        let resp = self.patch(
            &format!("/workbooks/{}/syncs/{}", workbook_id, sync_id),
            body,
        )?;
        Ok(resp.json()?)
    }

    pub fn delete_sync(&self, workbook_id: &str, sync_id: &str) -> Result<()> {
        self.delete(&format!("/workbooks/{}/syncs/{}", workbook_id, sync_id))?;
        Ok(())
    }

    pub fn run_sync(&self, workbook_id: &str, sync_id: &str) -> Result<RunSyncResponse> {
        let resp = self.post_empty(&format!(
            "/workbooks/{}/syncs/{}/run",
            workbook_id, sync_id
        ))?;
        Ok(resp.json()?)
    }
}
