package api

import (
	"net/http"
)

// Connection represents a connector account (connection) in the system.
type Connection struct {
	ID                  string  `json:"id"`
	Service             string  `json:"service"`
	DisplayName         string  `json:"displayName"`
	AuthType            string  `json:"authType"`
	RepoPath            string  `json:"repoPath,omitempty"`
	HealthStatus        *string `json:"healthStatus"`
	HealthStatusMessage *string `json:"healthStatusMessage"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
}

// CreateConnectionRequest is the request body for creating a new connection.
type CreateConnectionRequest struct {
	Service            string            `json:"service"`
	DisplayName        string            `json:"displayName,omitempty"`
	UserProvidedParams map[string]string `json:"userProvidedParams"`
}

// ListConnections returns all connections for a workbook.
func (c *Client) ListConnections(workbookID string) ([]Connection, error) {
	var result []Connection
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/connections", nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// GetConnection retrieves a single connection by ID.
func (c *Client) GetConnection(workbookID, connectionID string) (*Connection, error) {
	var result Connection
	if err := c.doRequest(http.MethodGet, "workbooks/"+workbookID+"/connections/"+connectionID, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateConnection creates a new connection with user-provided credentials.
func (c *Client) CreateConnection(workbookID string, req *CreateConnectionRequest) (*Connection, error) {
	var result Connection
	if err := c.doRequest(http.MethodPost, "workbooks/"+workbookID+"/connections", req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// DeleteConnection deletes a connection by ID.
func (c *Client) DeleteConnection(workbookID, connectionID string) error {
	return c.doRequest(http.MethodDelete, "workbooks/"+workbookID+"/connections/"+connectionID, nil, nil)
}
