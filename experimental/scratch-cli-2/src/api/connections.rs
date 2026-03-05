use std::collections::HashMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::Client;

#[derive(Deserialize, Serialize)]
pub struct Connection {
    pub id: String,
    pub service: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(rename = "authType", default)]
    pub auth_type: String,
    #[serde(rename = "healthStatus")]
    pub health_status: Option<String>,
    #[serde(rename = "healthStatusMessage")]
    pub health_status_message: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
}

#[derive(Serialize)]
struct CreateConnectionRequest {
    service: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(rename = "userProvidedParams")]
    user_provided_params: HashMap<String, String>,
}

impl Client {
    pub fn list_connections(&self, workbook_id: &str) -> Result<Vec<Connection>> {
        let resp = self.get(&format!("/workbooks/{}/connections", workbook_id))?;
        Ok(resp.json()?)
    }

    pub fn get_connection(&self, workbook_id: &str, connection_id: &str) -> Result<Connection> {
        let resp = self.get(&format!(
            "/workbooks/{}/connections/{}",
            workbook_id, connection_id
        ))?;
        Ok(resp.json()?)
    }

    pub fn create_connection(
        &self,
        workbook_id: &str,
        service: &str,
        display_name: Option<&str>,
        params: HashMap<String, String>,
    ) -> Result<Connection> {
        let body = CreateConnectionRequest {
            service: service.to_string(),
            display_name: display_name.map(|s| s.to_string()),
            user_provided_params: params,
        };
        let resp = self.post(
            &format!("/workbooks/{}/connections", workbook_id),
            &body,
        )?;
        Ok(resp.json()?)
    }

    pub fn delete_connection(&self, workbook_id: &str, connection_id: &str) -> Result<()> {
        self.delete(&format!(
            "/workbooks/{}/connections/{}",
            workbook_id, connection_id
        ))?;
        Ok(())
    }
}
