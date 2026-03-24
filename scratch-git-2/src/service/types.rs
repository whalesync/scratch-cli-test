use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirtyFile {
    pub path: String,
    pub status: String, // "added", "modified", "deleted"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
    #[serde(rename = "type")]
    pub change_type: ChangeType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Add,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CommitStats {
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub unchanged: Vec<String>,
}

pub const MAIN_BRANCH: &str = "main";
pub const DIRTY_BRANCH: &str = "dirty";
pub const DEFAULT_AUTHOR_NAME: &str = "Scratch";
pub const DEFAULT_AUTHOR_EMAIL: &str = "scratch@example.com";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StripPrefixResult {
    pub case: String,
    pub prefix_stripped: String,
    pub new_main: String,
    pub new_dirty: String,
    pub new_merge_base: String,
}
