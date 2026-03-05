use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::Client;

#[derive(Deserialize, Serialize)]
pub struct TablePreview {
    pub id: serde_json::Value,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "disabledCreates", default)]
    pub disabled_creates: bool,
}

#[derive(Deserialize, Serialize)]
pub struct TableList {
    pub tables: Vec<TablePreview>,
    #[serde(rename = "discoveryMode", default)]
    pub discovery_mode: String,
}

#[derive(Deserialize, Serialize)]
pub struct TableSearchResult {
    pub tables: Vec<TablePreview>,
    #[serde(rename = "hasMore", default)]
    pub has_more: bool,
}

#[derive(Deserialize, Serialize)]
pub struct LinkedTable {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
    #[serde(rename = "workbookId", default)]
    pub workbook_id: String,
    #[serde(rename = "connectorAccountId")]
    pub connector_account_id: Option<String>,
    #[serde(rename = "connectorDisplayName")]
    pub connector_display_name: Option<String>,
    #[serde(rename = "connectorService")]
    pub connector_service: Option<String>,
    #[serde(rename = "lastSyncTime")]
    pub last_sync_time: Option<String>,
    pub lock: Option<String>,
    pub path: Option<String>,
    #[serde(rename = "tableId", default)]
    pub table_id: Vec<String>,
}

#[derive(Deserialize, Serialize)]
pub struct LinkedTableGroup {
    pub name: String,
    pub service: Option<String>,
    #[serde(rename = "dataFolders")]
    pub data_folders: Vec<LinkedTable>,
}

#[derive(Deserialize, Serialize)]
pub struct LinkedTableDetail {
    #[serde(flatten)]
    pub linked_table: LinkedTable,
    #[serde(default)]
    pub creates: i32,
    #[serde(default)]
    pub updates: i32,
    #[serde(default)]
    pub deletes: i32,
    #[serde(rename = "hasChanges", default)]
    pub has_changes: bool,
}

#[derive(Serialize)]
struct CreateLinkedTableRequest {
    name: String,
    #[serde(rename = "connectorAccountId")]
    connector_account_id: String,
    #[serde(rename = "tableId")]
    table_id: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filter: Option<String>,
}

#[derive(Deserialize)]
pub struct JobResponse {
    #[serde(rename = "jobId")]
    pub job_id: String,
}

impl Client {
    pub fn list_connection_tables(
        &self,
        workbook_id: &str,
        connection_id: &str,
    ) -> Result<TableList> {
        let resp = self.get(&format!(
            "/workbooks/{}/connections/{}/tables",
            workbook_id, connection_id
        ))?;
        Ok(resp.json()?)
    }

    pub fn search_connection_tables(
        &self,
        workbook_id: &str,
        connection_id: &str,
        search_term: &str,
    ) -> Result<TableSearchResult> {
        let resp = self.get_with_query(
            &format!(
                "/workbooks/{}/connections/{}/tables/search",
                workbook_id, connection_id
            ),
            &[("searchTerm", search_term)],
        )?;
        Ok(resp.json()?)
    }

    pub fn list_linked_tables(&self, workbook_id: &str) -> Result<Vec<LinkedTableGroup>> {
        let resp = self.get(&format!("/workbooks/{}/linked", workbook_id))?;
        Ok(resp.json()?)
    }

    pub fn create_linked_table(
        &self,
        workbook_id: &str,
        name: &str,
        connector_account_id: &str,
        table_id: Vec<String>,
    ) -> Result<LinkedTable> {
        let body = CreateLinkedTableRequest {
            name: name.to_string(),
            connector_account_id: connector_account_id.to_string(),
            table_id,
            filter: None,
        };
        let resp = self.post(&format!("/workbooks/{}/linked", workbook_id), &body)?;
        Ok(resp.json()?)
    }

    pub fn delete_linked_table(&self, workbook_id: &str, folder_id: &str) -> Result<()> {
        self.delete(&format!("/workbooks/{}/linked/{}", workbook_id, folder_id))?;
        Ok(())
    }

    pub fn get_linked_table(
        &self,
        workbook_id: &str,
        folder_id: &str,
    ) -> Result<LinkedTableDetail> {
        let resp = self.get(&format!("/workbooks/{}/linked/{}", workbook_id, folder_id))?;
        Ok(resp.json()?)
    }

    pub fn pull_linked_table(
        &self,
        workbook_id: &str,
        folder_id: &str,
    ) -> Result<JobResponse> {
        let resp = self.post_empty(&format!(
            "/workbooks/{}/linked/{}/pull",
            workbook_id, folder_id
        ))?;
        Ok(resp.json()?)
    }

    pub fn pull_linked_table_files(
        &self,
        workbook_id: &str,
        folder_id: &str,
        file_paths: &[String],
    ) -> Result<JobResponse> {
        let body = serde_json::json!({ "filePaths": file_paths });
        let resp = self.post(
            &format!(
                "/workbooks/{}/linked/{}/pull-files",
                workbook_id, folder_id
            ),
            &body,
        )?;
        Ok(resp.json()?)
    }

    pub fn publish_linked_table(
        &self,
        workbook_id: &str,
        folder_id: &str,
    ) -> Result<JobResponse> {
        let resp = self.post_empty(&format!(
            "/workbooks/{}/linked/{}/publish",
            workbook_id, folder_id
        ))?;
        Ok(resp.json()?)
    }
}
