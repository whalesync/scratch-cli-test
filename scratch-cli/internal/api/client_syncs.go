package api

import (
	"encoding/json"
	"net/http"
)

// SyncTablePair represents a pair of source/destination data folders in a sync.
type SyncTablePair struct {
	ID                      string `json:"id"`
	SyncID                  string `json:"syncId"`
	SourceDataFolderID      string `json:"sourceDataFolderId"`
	DestinationDataFolderID string `json:"destinationDataFolderId"`
}

// Sync represents a sync configuration.
type Sync struct {
	ID                   string          `json:"id"`
	DisplayName          string          `json:"displayName"`
	DisplayOrder         int             `json:"displayOrder"`
	Mappings             json.RawMessage `json:"mappings"`
	SyncState            string          `json:"syncState"`
	SyncStateLastChanged *string         `json:"syncStateLastChanged"`
	LastSyncTime         *string         `json:"lastSyncTime"`
	CreatedAt            string          `json:"createdAt"`
	UpdatedAt            string          `json:"updatedAt"`
	SyncTablePairs       []SyncTablePair `json:"syncTablePairs"`
}

// RunSyncResponse represents the response from running a sync.
type RunSyncResponse struct {
	Success bool   `json:"success"`
	JobID   string `json:"jobId"`
	Message string `json:"message"`
}

// ListSyncs returns all syncs for a workbook.
func (c *Client) ListSyncs(workbookID string) ([]Sync, error) {
	var result []Sync
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/syncs", nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// GetSync retrieves a single sync by ID.
func (c *Client) GetSync(workbookID, syncID string) (*Sync, error) {
	var result Sync
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/syncs/"+syncID, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetSyncRaw retrieves a single sync by ID as raw JSON.
func (c *Client) GetSyncRaw(workbookID, syncID string) (json.RawMessage, error) {
	var result json.RawMessage
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/syncs/"+syncID, nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// CreateSync creates a new sync in a workbook.
func (c *Client) CreateSync(workbookID string, body json.RawMessage) (*Sync, error) {
	var result Sync
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/syncs", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// UpdateSync updates an existing sync.
func (c *Client) UpdateSync(workbookID, syncID string, body json.RawMessage) (*Sync, error) {
	var result Sync
	if err := c.doRequest(http.MethodPatch, "workbooks/"+workbookID+"/syncs/"+syncID, body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// DeleteSync deletes a sync by ID.
func (c *Client) DeleteSync(workbookID, syncID string) error {
	var result map[string]interface{}
	if err := c.doRequest(http.MethodDelete, "workbooks/"+workbookID+"/syncs/"+syncID, nil, &result); err != nil {
		return err
	}
	return nil
}

// ExportSyncConfig represents a sync configuration in a format compatible with SaveSyncBody for re-import.
type ExportSyncConfig struct {
	ID               string          `json:"id"`
	DisplayName      string          `json:"displayName"`
	Mappings         json.RawMessage `json:"mappings"`
	ValidateMappings bool            `json:"validateMappings"`
	Schedule         string          `json:"schedule"`
	PublishAfterSync bool            `json:"publishAfterSync"`
	Metadata         struct {
		SyncState    string  `json:"syncState"`
		LastSyncTime *string `json:"lastSyncTime"`
		CreatedAt    string  `json:"createdAt"`
		UpdatedAt    string  `json:"updatedAt"`
	} `json:"_metadata"`
}

// ExportSyncs fetches all sync configs for a workbook in export format.
func (c *Client) ExportSyncs(workbookID string) ([]ExportSyncConfig, error) {
	var result []ExportSyncConfig
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/syncs/export", nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// ExportSync fetches a single sync config in export format.
func (c *Client) ExportSync(workbookID, syncID string) ([]ExportSyncConfig, error) {
	var result []ExportSyncConfig
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/syncs/export?syncId="+syncID, nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// RunSync triggers a sync execution and returns the job info.
func (c *Client) RunSync(workbookID, syncID string) (*RunSyncResponse, error) {
	var result RunSyncResponse
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/syncs/"+syncID+"/run", nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
