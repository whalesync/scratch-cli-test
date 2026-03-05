use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::Client;

#[derive(Deserialize, Serialize, Clone)]
pub struct DataFolder {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ConnectorAccount {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub service: String,
    #[serde(rename = "gitUrl", default)]
    pub git_url: String,
    #[serde(rename = "dataFolders", default)]
    pub data_folders: Vec<DataFolder>,
}

#[derive(Deserialize, Serialize)]
pub struct Workbook {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
    #[serde(rename = "tableCount", default)]
    pub table_count: i32,
    #[serde(default)]
    pub version: i32,
    #[serde(rename = "dataFolders", default)]
    pub data_folders: Vec<DataFolder>,
    #[serde(rename = "connectorAccounts", default)]
    pub connector_accounts: Vec<ConnectorAccount>,
    #[serde(rename = "gitUrl", default)]
    pub git_url: String,
}

#[derive(Deserialize, Serialize)]
pub struct WorkbookListResponse {
    pub workbooks: Vec<Workbook>,
}

#[derive(Serialize)]
struct CreateWorkbookRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl Client {
    pub fn list_workbooks(
        &self,
        sort_by: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<WorkbookListResponse> {
        let mut query = Vec::new();
        if let Some(sb) = sort_by {
            query.push(("sortBy", sb));
        }
        if let Some(so) = sort_order {
            query.push(("sortOrder", so));
        }

        let resp = if query.is_empty() {
            self.get("/workbooks")?
        } else {
            self.get_with_query("/workbooks", &query)?
        };
        Ok(resp.json()?)
    }

    pub fn create_workbook(&self, name: Option<&str>) -> Result<Workbook> {
        let body = CreateWorkbookRequest {
            name: name.map(|s| s.to_string()),
        };
        let resp = self.post("/workbooks", &body)?;
        Ok(resp.json()?)
    }

    pub fn get_workbook(&self, id: &str) -> Result<Workbook> {
        let resp = self.get(&format!("/workbooks/{}", id))?;
        Ok(resp.json()?)
    }

    pub fn delete_workbook(&self, id: &str) -> Result<()> {
        self.delete(&format!("/workbooks/{}", id))?;
        Ok(())
    }
}
