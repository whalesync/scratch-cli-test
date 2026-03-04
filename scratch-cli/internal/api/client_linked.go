package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// --- Linked Table Types ---

// TablePreviewID is a table identifier that may arrive from the server as a
// simple string or as a structured object {"wsId":"...","remoteId":["...","..."]}.
// It is stored and displayed as a comma-separated string (e.g. "siteId,collectionId").
type TablePreviewID string

// UnmarshalJSON handles both plain string IDs and structured {wsId, remoteId} objects.
func (t *TablePreviewID) UnmarshalJSON(data []byte) error {
	// Try plain string first.
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		*t = TablePreviewID(s)
		return nil
	}

	// Try structured object with remoteId array.
	var obj struct {
		RemoteID []string `json:"remoteId"`
	}
	if err := json.Unmarshal(data, &obj); err == nil && len(obj.RemoteID) > 0 {
		*t = TablePreviewID(strings.Join(obj.RemoteID, ","))
		return nil
	}

	return fmt.Errorf("cannot unmarshal table ID: %s", string(data))
}

// Parts splits the comma-separated ID back into its component strings.
func (t TablePreviewID) Parts() []string {
	return strings.Split(string(t), ",")
}

// String returns the comma-separated representation.
func (t TablePreviewID) String() string {
	return string(t)
}

// TablePreview represents a table available from a connector.
type TablePreview struct {
	ID              TablePreviewID         `json:"id"`
	DisplayName     string                 `json:"displayName"`
	Disabled        bool                   `json:"disabled,omitempty"`
	DisabledCreates bool                   `json:"disabledCreates,omitempty"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`
}

// TableList represents the response from listing tables for a single connection.
type TableList struct {
	Tables        []TablePreview `json:"tables"`
	DiscoveryMode string         `json:"discoveryMode"`
}

// TableSearchResult represents the response from searching tables for a connection.
type TableSearchResult struct {
	Tables  []TablePreview `json:"tables"`
	HasMore bool           `json:"hasMore"`
}

// LinkedTable represents a linked data folder in a workbook.
type LinkedTable struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	CreatedAt            string   `json:"createdAt"`
	UpdatedAt            string   `json:"updatedAt"`
	WorkbookID           string   `json:"workbookId"`
	ConnectorAccountID   *string  `json:"connectorAccountId"`
	ConnectorDisplayName *string  `json:"connectorDisplayName"`
	ConnectorService     *string  `json:"connectorService"`
	LastSyncTime         *string  `json:"lastSyncTime"`
	Lock                 *string  `json:"lock"`
	Path                 *string  `json:"path"`
	TableID              []string `json:"tableId"`
}

// LinkedTableGroup represents a group of linked tables from a connector.
type LinkedTableGroup struct {
	Name        string        `json:"name"`
	Service     *string       `json:"service"`
	DataFolders []LinkedTable `json:"dataFolders"`
}

// LinkedTableDetail represents a linked table with publish status info.
type LinkedTableDetail struct {
	LinkedTable
	Creates    int  `json:"creates"`
	Updates    int  `json:"updates"`
	Deletes    int  `json:"deletes"`
	HasChanges bool `json:"hasChanges"`
}

// CreateLinkedTableRequest represents the request body for linking a new table.
type CreateLinkedTableRequest struct {
	Name               string   `json:"name"`
	ConnectorAccountID string   `json:"connectorAccountId"`
	TableID            []string `json:"tableId"`
	Filter             string   `json:"filter,omitempty"`
}

// JobResponse represents a response containing a job ID.
type JobResponse struct {
	JobID string `json:"jobId"`
}

// --- Linked Table Methods ---

// ListConnectionTables lists tables available from a specific connection.
func (c *Client) ListConnectionTables(workbookID string, connectionID string) (*TableList, error) {
	var result TableList
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/connections/"+connectionID+"/tables", nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// SearchConnectionTables searches for tables in a specific connection.
func (c *Client) SearchConnectionTables(workbookID string, connectionID string, searchTerm string) (*TableSearchResult, error) {
	var result TableSearchResult
	query := url.Values{"searchTerm": {searchTerm}}
	if err := c.doRequestWithQuery(http.MethodGet, "workbooks/"+workbookID+"/connections/"+connectionID+"/tables/search", query, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ListLinkedTables lists linked tables in a workbook, grouped by connector.
func (c *Client) ListLinkedTables(workbookID string) ([]LinkedTableGroup, error) {
	var result []LinkedTableGroup
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/linked", nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// CreateLinkedTable links a new table to a workbook.
func (c *Client) CreateLinkedTable(workbookID string, req *CreateLinkedTableRequest) (*LinkedTable, error) {
	var result LinkedTable
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/linked", req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// DeleteLinkedTable unlinks a table from a workbook.
func (c *Client) DeleteLinkedTable(workbookID, folderID string) error {
	var result map[string]interface{}
	if err := c.doRequest(http.MethodDelete, "workbooks/"+workbookID+"/linked/"+folderID, nil, &result); err != nil {
		return err
	}
	return nil
}

// GetLinkedTable returns details for a linked table including publish status.
func (c *Client) GetLinkedTable(workbookID, folderID string) (*LinkedTableDetail, error) {
	var result LinkedTableDetail
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/linked/"+folderID, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// PullLinkedTable pulls CRM changes into the workbook for a specific linked table.
func (c *Client) PullLinkedTable(workbookID, folderID string) (*JobResponse, error) {
	var result JobResponse
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/linked/"+folderID+"/pull", nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// PullLinkedTableFiles pulls specific files from the remote source for a linked table.
func (c *Client) PullLinkedTableFiles(workbookID, folderID string, filePaths []string) (*JobResponse, error) {
	var result JobResponse
	body := map[string]interface{}{"filePaths": filePaths}
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/linked/"+folderID+"/pull-files", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// PublishLinkedTable publishes changes from the workbook to the CRM for a specific linked table.
func (c *Client) PublishLinkedTable(workbookID, folderID string) (*JobResponse, error) {
	var result JobResponse
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/linked/"+folderID+"/publish", nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
