package api

import (
	"net/http"
	"net/url"
)

// DataFolder represents a data folder in the CLI response format.
type DataFolder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ConnectorAccount represents a connector account in a V2 workbook.
type ConnectorAccount struct {
	ID          string       `json:"id"`
	DisplayName string       `json:"displayName"`
	Service     string       `json:"service"`
	RepoPath    string       `json:"repoPath,omitempty"`
	GitUrl      string       `json:"gitUrl"`
	DataFolders []DataFolder `json:"dataFolders"`
}

// Workbook represents a workbook in the CLI response format.
type Workbook struct {
	ID                string             `json:"id"`
	Name              string             `json:"name"`
	CreatedAt         string             `json:"createdAt"`
	UpdatedAt         string             `json:"updatedAt"`
	TableCount        int                `json:"tableCount"`
	Version           int                `json:"version"`
	DataFolders       []DataFolder       `json:"dataFolders"`
	ConnectorAccounts []ConnectorAccount `json:"connectorAccounts"`
	GitUrl            string             `json:"gitUrl"`
}

// WorkbookListResponse represents the response from the list workbooks endpoint.
type WorkbookListResponse struct {
	Workbooks []Workbook `json:"workbooks"`
}

// CreateWorkbookRequest represents the request body for creating a workbook.
type CreateWorkbookRequest struct {
	Name string `json:"name,omitempty"`
}

// DeleteWorkbookResponse represents the response from deleting a workbook.
type DeleteWorkbookResponse struct {
	Success bool `json:"success"`
}

// ListWorkbooks returns all workbooks for the authenticated user.
func (c *Client) ListWorkbooks(sortBy, sortOrder string) (*WorkbookListResponse, error) {
	params := url.Values{}
	if sortBy != "" {
		params.Set("sortBy", sortBy)
	}
	if sortOrder != "" {
		params.Set("sortOrder", sortOrder)
	}

	var result WorkbookListResponse
	if err := c.doRequestWithQuery(http.MethodGet, "workbooks", params, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateWorkbook creates a new workbook.
func (c *Client) CreateWorkbook(name string) (*Workbook, error) {
	body := &CreateWorkbookRequest{Name: name}
	var result Workbook
	if err := c.doRequest(http.MethodPost, "workbooks", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetWorkbook retrieves a single workbook by ID.
func (c *Client) GetWorkbook(id string) (*Workbook, error) {
	var result Workbook
	if err := c.doRequest(http.MethodGet, "workbooks/"+id, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// DeleteWorkbook deletes a workbook by ID.
func (c *Client) DeleteWorkbook(id string) error {
	var result DeleteWorkbookResponse
	if err := c.doRequest(http.MethodDelete, "workbooks/"+id, nil, &result); err != nil {
		return err
	}
	return nil
}
