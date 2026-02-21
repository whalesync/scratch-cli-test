# Scratch API Documentation

## Overview

This document describes the REST API for Scratch, a data management platform that syncs content between external services (Airtable, Notion, Webflow, Wix) and a git-backed workbook.

### Authentication

All endpoints require authentication via:

- **API Token**: `Authorization: API-Token <token>` header

API tokens are 32-character strings with no prefix. Tokens expire after 6 months.

To obtain an API token, use the CLI authentication flow (see [CLI Authentication](#cli-authentication)).

---

## Endpoints

### System

```
GET    /                                          # Root info
GET    /health                                    # Health check
GET    /connection-test                           # Test Redis and scratch-git connections
GET    /egress-ip                                 # Get server egress IP address
GET    /cli/v1/health                             # CLI health check
```

### CLI Authentication

```
POST   /cli/v1/auth/initiate                      # Start device auth flow
POST   /cli/v1/auth/poll                          # Poll for auth completion
POST   /cli/v1/auth/verify                        # Verify user code (web UI)
```

### Workbooks

```
GET    /workbook                                  # List workbooks
POST   /workbook                                  # Create workbook
GET    /workbook/:id                              # Get workbook
PATCH  /workbook/:id                              # Update workbook
DELETE /workbook/:id                              # Delete workbook
POST   /workbook/:id/pull-files                   # Trigger file pull from external sources
GET    /workbook/:id/data-folders/publish-status  # Get publish status for data folders
```

### Files

```
GET    /workbooks/:workbookId/files/list                # List all files
GET    /workbooks/:workbookId/files/list/details        # List files with content
GET    /workbooks/:workbookId/files/list/by-folder      # List files by folder ID
GET    /workbooks/:workbookId/files/list/by-path        # List files by path
GET    /workbooks/:workbookId/files/find                # Find files by pattern
GET    /workbooks/:workbookId/files/grep                # Search file contents
GET    /workbooks/:workbookId/files/by-path             # Get file by path
GET    /workbooks/:workbookId/files/:fileId             # Get file by ID
POST   /workbooks/:workbookId/files                     # Create file
PUT    /workbooks/:workbookId/files/write-by-path       # Write file by path
PATCH  /workbooks/:workbookId/files/by-path             # Update file by path
PATCH  /workbooks/:workbookId/files/:fileId             # Update file by ID
DELETE /workbooks/:workbookId/files/by-path             # Delete file by path
DELETE /workbooks/:workbookId/files/:fileId             # Delete file by ID
POST   /workbooks/:workbookId/files/:fileId/copy        # Copy file
POST   /workbooks/:workbookId/files/publish             # Publish file
GET    /workbook/public/:id/files/download              # Download file (public, no auth)
GET    /workbook/public/:id/folders/download            # Download folder as zip (public, no auth)
```

### Folders

```
GET    /workbook/:id/data-folders/list                  # List folders in workbook
POST   /workbooks/:workbookId/folders                   # Create folder
PATCH  /workbooks/:workbookId/folders/:folderId         # Update folder
DELETE /workbooks/:workbookId/folders/:folderId         # Delete folder
POST   /data-folder/create                              # Create data folder
POST   /data-folder/publish                             # Publish multiple data folders
GET    /data-folder/:id                                 # Get data folder
DELETE /data-folder/:id                                 # Delete data folder
PATCH  /data-folder/:id/rename                          # Rename data folder
PATCH  /data-folder/:id/move                            # Move data folder
POST   /data-folder/:id/files                           # Create file in folder
POST   /data-folder/:id/publish                         # Publish single data folder
GET    /data-folder/:id/schema-paths                    # Get schema paths for data folder
```

### Connections

```
GET    /connector-accounts                              # List connections
POST   /connector-accounts                              # Create connection
GET    /connector-accounts/:id                          # Get connection
PATCH  /connector-accounts/:id                          # Update connection
DELETE /connector-accounts/:id                          # Delete connection
GET    /connector-accounts/:id/tables                    # List tables for connection
POST   /connector-accounts/:id/test                     # Test connection
```

### Syncs

```
GET    /workbooks/:workbookId/syncs                     # List syncs
GET    /workbooks/:workbookId/syncs/:syncId             # Get sync
POST   /workbooks/:workbookId/syncs                     # Create sync
PATCH  /workbooks/:workbookId/syncs/:syncId             # Update sync
DELETE /workbooks/:workbookId/syncs/:syncId             # Delete sync
POST   /workbooks/:workbookId/syncs/:syncId/run         # Run sync
POST   /workbooks/:workbookId/syncs/validate-mapping    # Validate sync mapping
```

### Jobs

```
GET    /jobs                                            # List jobs
GET    /jobs/:jobId/progress                            # Get job progress
GET    /jobs/:jobId/raw                                 # Get raw job data
POST   /jobs/:jobId/cancel                              # Cancel job
POST   /jobs/bulk-status                                # Get status of multiple jobs
```

### CLI Operations

```
GET    /cli/v1/workbooks                                # List workbooks (CLI)
POST   /cli/v1/workbooks                                # Create workbook (CLI)
GET    /cli/v1/workbooks/:id                            # Get workbook (CLI)
DELETE /cli/v1/workbooks/:id                            # Delete workbook (CLI)
GET    /cli/v1/workbooks/:workbookId/folders            # List folders (CLI)
GET    /cli/v1/folders/:folderId/files                  # Get folder files (CLI)
PUT    /cli/v1/folders/:folderId/files                  # Upload files (CLI)
GET    /cli/v1/test-connection                          # Test connection (CLI)
GET    /cli/v1/list-tables                              # List tables (CLI)
POST   /cli/v1/download                                 # Download from connector (CLI)
POST   /cli/v1/workbooks/:workbookId/pull               # Trigger pull (CLI)
GET    /cli/v1/jobs/:jobId/status                       # Get job status (CLI)
```

---

## Endpoint Details

## CLI Authentication

The CLI uses a device authorization flow similar to `gcloud auth login`. Users authenticate by entering a code in their browser.

### Initiate Auth Flow

```
POST /cli/v1/auth/initiate
```

Starts the authorization flow. Returns a user code for the user to enter in their browser.

**Response:**

```json
{
  "userCode": "ABCD-1234",
  "pollingCode": "abc123xyz...",
  "verificationUrl": "https://app.scratch.io/cli/authorize",
  "expiresIn": 600,
  "interval": 5
}
```

| Field             | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `userCode`        | Code for user to enter in browser (format: `XXXX-XXXX`) |
| `pollingCode`     | Secret code for polling (32 characters)                 |
| `verificationUrl` | URL where user enters the code                          |
| `expiresIn`       | Seconds until codes expire (600 = 10 minutes)           |
| `interval`        | Recommended polling interval in seconds                 |

### Poll for Completion

```
POST /cli/v1/auth/poll
```

Polls for authorization status. Call this every `interval` seconds until status is not `pending`.

**Request Body:**

```json
{
  "pollingCode": "abc123xyz..."
}
```

**Response (pending):**

```json
{
  "status": "pending"
}
```

**Response (approved):**

```json
{
  "status": "approved",
  "apiToken": "abc123...",
  "userEmail": "user@example.com",
  "tokenExpiresAt": "2025-07-19T00:00:00.000Z"
}
```

**Response (denied/expired):**

```json
{
  "status": "denied",
  "error": "Authorization was denied"
}
```

| Status     | Description                      |
| ---------- | -------------------------------- |
| `pending`  | User hasn't entered the code yet |
| `approved` | Success - `apiToken` is included |
| `denied`   | User denied the request          |
| `expired`  | Code expired (10 minute limit)   |

### Verify User Code (Web UI)

```
POST /cli/v1/auth/verify
```

Called from the web UI when a logged-in user enters the code. Requires session authentication.

**Request Body:**

```json
{
  "userCode": "ABCD-1234"
}
```

**Response:**

```json
{
  "success": true
}
```

---

## System Endpoints

### Root Info

```
GET /
```

Returns basic server info.

**Response:**

```json
{
  "server": "Scratchpad API",
  "build_version": "1.2.3"
}
```

### Health Check

```
GET /health
```

Returns server health status.

**Response:**

```json
{
  "status": "alive",
  "timestamp": "2025-01-19T00:00:00.000Z",
  "service": "scratchpad-api",
  "build_version": "1.2.3",
  "in_cloud": true,
  "app_url": "https://app.scratch.md",
  "apptype": "MONOLITH"
}
```

### Connection Test

```
GET /connection-test
```

Tests connections to Redis and scratch-git services. Useful for infrastructure monitoring.

**Response:**

```json
{
  "timestamp": "2025-01-19T00:00:00.000Z",
  "redis": {
    "status": "ok"
  },
  "scratch_git": {
    "status": "ok",
    "url": "https://scratch-git.example.com",
    "build_version": "1.0.0"
  }
}
```

| Status        | Description            |
| ------------- | ---------------------- |
| `ok`          | Connection successful  |
| `error`       | Connection failed      |
| `not_enabled` | Service not configured |

### Egress IP

```
GET /egress-ip
```

Returns the external IP address of the server. Useful for verifying Cloud NAT static IP configuration.

**Response:**

```json
{
  "egress_ip": "34.123.45.67",
  "timestamp": "2025-01-19T00:00:00.000Z",
  "service": "api"
}
```

---

## Workbooks

Workbooks are containers for tables, files, folders, and syncs.

### List Workbooks

```
GET /workbook
```

Returns all workbooks for the authenticated user.

**Query Parameters:**

| Parameter            | Type   | Description                                  |
| -------------------- | ------ | -------------------------------------------- |
| `connectorAccountId` | string | Filter by connection ID                      |
| `sortBy`             | string | Sort field: `name`, `createdAt`, `updatedAt` |
| `sortOrder`          | string | Sort direction: `asc`, `desc`                |

**Response:**

```json
[
  {
    "id": "wkb_abc123",
    "name": "My Workbook",
    "createdAt": "2025-01-19T00:00:00.000Z",
    "updatedAt": "2025-01-19T00:00:00.000Z",
    "snapshotTables": [...],
    "dataFolders": [...]
  }
]
```

### Create Workbook

```
POST /workbook
```

Creates a new workbook.

**Request Body:**

```json
{
  "name": "My Workbook",
  "tables": [
    {
      "connectorAccountId": "conn_123",
      "tableId": "tbl_abc"
    }
  ]
}
```

**Response (201):**

```json
{
  "id": "wkb_abc123",
  "name": "My Workbook",
  "createdAt": "2025-01-19T00:00:00.000Z",
  "updatedAt": "2025-01-19T00:00:00.000Z",
  "snapshotTables": [...],
  "dataFolders": []
}
```

### Get Workbook

```
GET /workbook/:id
```

Returns workbook details.

**Response:**

```json
{
  "id": "wkb_abc123",
  "name": "My Workbook",
  "createdAt": "2025-01-19T00:00:00.000Z",
  "updatedAt": "2025-01-19T00:00:00.000Z",
  "snapshotTables": [
    {
      "id": "tbl_xyz",
      "connectorService": "airtable",
      "connectorDisplayName": "My Airtable",
      "tableSpec": {...},
      "columnSettings": {...},
      "hidden": false,
      "lastSyncTime": "2025-01-19T12:00:00.000Z"
    }
  ],
  "dataFolders": [...]
}
```

### Update Workbook

```
PATCH /workbook/:id
```

Updates workbook properties.

**Request Body:**

```json
{
  "name": "New Name"
}
```

**Response:**

```json
{
  "id": "wkb_abc123",
  "name": "New Name",
  ...
}
```

### Delete Workbook

```
DELETE /workbook/:id
```

Deletes a workbook.

**Response:** `204 No Content`

### Pull Files

```
POST /workbook/:id/pull-files
```

Triggers a pull operation to sync files from external sources.

**Request Body:**

```json
{
  "snapshotTableIds": ["snap_abc", "snap_xyz"]
}
```

| Field              | Type     | Required | Description                      |
| ------------------ | -------- | -------- | -------------------------------- |
| `snapshotTableIds` | string[] | No       | Specific tables to pull (or all) |

**Response:**

```json
{
  "jobId": "job_xyz"
}
```

### Get Data Folders Publish Status

```
GET /workbook/:id/data-folders/publish-status
```

Returns the publish status for all data folders in a workbook.

**Response:**

```json
[
  {
    "dataFolderId": "dfolder_abc",
    "name": "Blog Posts",
    "hasUnpublishedChanges": true,
    "lastPublishedAt": "2025-01-19T12:00:00.000Z"
  }
]
```

---

## Files

Files are version-controlled content stored in git.

### List Files

```
GET /workbooks/:workbookId/files/list
```

Returns all files and folders in the workbook.

**Response:**

```json
{
  "items": [
    {
      "type": "file",
      "id": "file_abc",
      "name": "document.md",
      "parentFolderId": "folder_123",
      "path": "/docs/document.md",
      "dirty": false
    },
    {
      "type": "folder",
      "id": "folder_123",
      "name": "docs",
      "parentFolderId": null,
      "path": "/docs"
    }
  ]
}
```

### List Files with Content

```
GET /workbooks/:workbookId/files/list/details
```

Returns files with their full content.

**Query Parameters:**

| Parameter  | Type   | Description         |
| ---------- | ------ | ------------------- |
| `folderId` | string | Filter by folder ID |

**Response:**

```json
{
  "files": [
    {
      "ref": {
        "type": "file",
        "id": "file_abc",
        "name": "document.md",
        "path": "/docs/document.md"
      },
      "content": "# Hello World\n\nThis is my document.",
      "createdAt": "2025-01-19T00:00:00.000Z",
      "updatedAt": "2025-01-19T00:00:00.000Z"
    }
  ]
}
```

### List Files by Path

```
GET /workbooks/:workbookId/files/list/by-path
```

Lists files at a specific path.

**Query Parameters:**

| Parameter | Type   | Default | Description            |
| --------- | ------ | ------- | ---------------------- |
| `path`    | string | `/`     | Directory path to list |

### Find Files

```
GET /workbooks/:workbookId/files/find
```

Finds files matching a glob pattern.

**Query Parameters:**

| Parameter   | Type    | Required | Description                              |
| ----------- | ------- | -------- | ---------------------------------------- |
| `pattern`   | string  | Yes      | Glob pattern (e.g., `*.md`, `**/*.json`) |
| `path`      | string  | No       | Base path to search from                 |
| `recursive` | boolean | No       | Search recursively                       |

**Response:**

```json
{
  "items": [
    {
      "type": "file",
      "id": "file_abc",
      "name": "readme.md",
      "path": "/docs/readme.md"
    }
  ]
}
```

### Search File Contents

```
GET /workbooks/:workbookId/files/grep
```

Searches file contents for a pattern.

**Query Parameters:**

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `pattern` | string | Yes      | Search pattern (regex)   |
| `path`    | string | No       | Base path to search from |

**Response:**

```json
{
  "matches": [
    {
      "file": {
        "id": "file_abc",
        "name": "document.md",
        "path": "/docs/document.md"
      },
      "matchCount": 3,
      "excerpts": [{ "line": 5, "text": "This line contains the pattern" }]
    }
  ]
}
```

### Get File by Path

```
GET /workbooks/:workbookId/files/by-path
```

Returns a single file by its path.

**Query Parameters:**

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `path`    | string | Yes      | File path   |

**Response:**

```json
{
  "file": {
    "ref": {
      "type": "file",
      "id": "file_abc",
      "name": "document.md",
      "path": "/docs/document.md"
    },
    "content": "# Hello World",
    "createdAt": "2025-01-19T00:00:00.000Z",
    "updatedAt": "2025-01-19T00:00:00.000Z"
  }
}
```

### Get File by ID

```
GET /workbooks/:workbookId/files/:fileId
```

Returns a single file by its ID.

**Response:** Same as "Get File by Path"

### Create File

```
POST /workbooks/:workbookId/files
```

Creates a new file.

**Request Body:**

```json
{
  "name": "new-document.md",
  "parentFolderId": "folder_123",
  "content": "# New Document\n\nContent here.",
  "useTemplate": false
}
```

| Field            | Type    | Required | Description                      |
| ---------------- | ------- | -------- | -------------------------------- |
| `name`           | string  | Yes      | File name with extension         |
| `parentFolderId` | string  | No       | Parent folder ID (null for root) |
| `content`        | string  | No       | Initial file content             |
| `useTemplate`    | boolean | No       | Use default template for content |

**Response:**

```json
{
  "type": "file",
  "id": "file_xyz",
  "name": "new-document.md",
  "parentFolderId": "folder_123",
  "path": "/docs/new-document.md",
  "dirty": false
}
```

### Write File by Path

```
PUT /workbooks/:workbookId/files/write-by-path
```

Creates or updates a file at the specified path.

**Request Body:**

```json
{
  "path": "/docs/document.md",
  "content": "# Updated Content"
}
```

**Response:** Returns file reference.

### Update File

```
PATCH /workbooks/:workbookId/files/:fileId
PATCH /workbooks/:workbookId/files/by-path?path=...
```

Updates file name, location, or content.

**Request Body:**

```json
{
  "name": "renamed.md",
  "parentFolderId": "folder_456",
  "content": "# New Content"
}
```

All fields are optional.

**Response:** `204 No Content`

### Delete File

```
DELETE /workbooks/:workbookId/files/:fileId
DELETE /workbooks/:workbookId/files/by-path?path=...
```

Deletes a file.

**Response:** `204 No Content`

### Copy File

```
POST /workbooks/:workbookId/files/:fileId/copy
```

Copies a file to a target folder.

**Request Body:**

```json
{
  "targetFolderId": "folder_456"
}
```

**Response:** Returns new file reference.

### Publish File

```
POST /workbooks/:workbookId/files/publish
```

Commits a file to the main branch (creates a snapshot).

**Request Body:**

```json
{
  "path": "/docs/document.md"
}
```

**Response:** `204 No Content`

### Download File (Public)

```
GET /workbook/public/:id/files/download
```

Downloads a file as markdown. **No authentication required** - security relies on workbook IDs being unguessable.

**Query Parameters:**

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `fileId`  | string | Yes      | File ID     |

**Response:** Raw markdown file with `Content-Type: text/markdown` and `Content-Disposition: attachment` headers.

### Download Folder (Public)

```
GET /workbook/public/:id/folders/download
```

Downloads a folder as a ZIP archive. **No authentication required** - security relies on workbook IDs being unguessable.

**Query Parameters:**

| Parameter  | Type   | Required | Description |
| ---------- | ------ | -------- | ----------- |
| `folderId` | string | Yes      | Folder ID   |

**Response:** ZIP file stream with `Content-Type: application/zip` and `Content-Disposition: attachment` headers.

---

## Folders

### List Folders

```
GET /workbook/:id/data-folders/list
```

Lists all folders in a workbook, grouped by connection.

**Response:**

```json
[
  {
    "connectorAccountId": "conn_123",
    "connectorService": "airtable",
    "connectorDisplayName": "My Airtable",
    "folders": [
      {
        "id": "dfolder_abc",
        "name": "Blog Posts",
        "path": "/airtable/blog-posts",
        "tableId": ["tbl_xyz"],
        "lastSyncTime": "2025-01-19T12:00:00.000Z"
      }
    ]
  }
]
```

### Create Folder

```
POST /workbooks/:workbookId/folders
```

Creates a new folder in the workbook.

**Request Body:**

```json
{
  "name": "New Folder",
  "parentFolderId": null
}
```

**Response:**

```json
{
  "folder": {
    "id": "folder_xyz",
    "name": "New Folder",
    "parentId": null
  }
}
```

### Create Data Folder

```
POST /data-folder/create
```

Creates a folder connected to an external data source.

**Request Body:**

```json
{
  "name": "Blog Posts",
  "workbookId": "wkb_abc123",
  "connectorAccountId": "conn_123",
  "tableId": ["tbl_posts"],
  "parentFolderId": null
}
```

**Response:**

```json
{
  "id": "dfolder_xyz",
  "name": "Blog Posts",
  "workbookId": "wkb_abc123",
  "connectorAccountId": "conn_123",
  "connectorService": "airtable",
  "tableId": ["tbl_posts"],
  "path": "/airtable/blog-posts",
  "lastSyncTime": null
}
```

### Publish Multiple Data Folders

```
POST /data-folder/publish
```

Publishes multiple data folders in a single job.

**Request Body:**

```json
{
  "workbookId": "wkb_abc123",
  "dataFolderIds": ["dfolder_abc", "dfolder_xyz"]
}
```

| Field           | Type     | Required | Description                         |
| --------------- | -------- | -------- | ----------------------------------- |
| `workbookId`    | string   | Yes      | Workbook ID                         |
| `dataFolderIds` | string[] | Yes      | Array of data folder IDs to publish |

**Response:**

```json
{
  "jobId": "job_xyz"
}
```

**Errors:**

- `400`: At least one data folder ID is required
- `400`: Data folder is locked by another operation
- `404`: Workbook or data folder not found

### Get Data Folder

```
GET /data-folder/:id
```

Returns folder details.

**Response:**

```json
{
  "id": "dfolder_xyz",
  "name": "Blog Posts",
  "workbookId": "wkb_abc123",
  "connectorAccountId": "conn_123",
  "connectorService": "airtable",
  "connectorDisplayName": "My Airtable",
  "tableId": ["tbl_posts"],
  "path": "/airtable/blog-posts",
  "schema": {...},
  "lastSyncTime": "2025-01-19T12:00:00.000Z",
  "version": 3
}
```

### Update Folder

```
PATCH /workbooks/:workbookId/folders/:folderId
```

Updates folder name or moves it to a new parent.

**Request Body:**

```json
{
  "name": "Renamed Folder",
  "parentFolderId": "folder_parent"
}
```

**Response:**

```json
{
  "folder": {
    "id": "folder_xyz",
    "name": "Renamed Folder",
    "parentId": "folder_parent"
  }
}
```

### Rename Data Folder

```
PATCH /data-folder/:id/rename
```

Renames a data folder.

**Request Body:**

```json
{
  "name": "New Name"
}
```

**Response:** Returns updated data folder.

### Move Data Folder

```
PATCH /data-folder/:id/move
```

Moves a data folder to a new parent.

**Request Body:**

```json
{
  "parentFolderId": "dfolder_parent"
}
```

**Response:** Returns updated data folder.

### Delete Folder

```
DELETE /workbooks/:workbookId/folders/:folderId
DELETE /data-folder/:id
```

Deletes a folder and its contents.

**Response:** `204 No Content`

### Create File in Data Folder

```
POST /data-folder/:id/files
```

Creates a new file inside a data folder.

**Request Body:**

```json
{
  "name": "new-post.md",
  "workbookId": "wkb_abc123",
  "useTemplate": true
}
```

**Response:** Returns file reference.

### Publish Data Folder

```
POST /data-folder/:id/publish
```

Publishes all changes in a data folder to the external service.

**Request Body:**

```json
{
  "workbookId": "wkb_abc123"
}
```

**Response:**

```json
{
  "jobId": "job_xyz"
}
```

### Get Schema Paths

```
GET /data-folder/:id/schema-paths
```

Returns the schema paths available for a data folder. Useful for building field mappings.

**Response:**

```json
[
  {
    "path": "title",
    "type": "string"
  },
  {
    "path": "content",
    "type": "string"
  },
  {
    "path": "metadata.author",
    "type": "string"
  }
]
```

---

## Connections

Connections store credentials for external services.

### List Connections

```
GET /connector-accounts
```

Returns all connections for the authenticated user.

**Response:**

```json
[
  {
    "id": "conn_abc123",
    "service": "airtable",
    "displayName": "My Airtable",
    "authType": "oauth",
    "healthStatus": "healthy",
    "healthStatusLastCheckedAt": "2025-01-19T12:00:00.000Z",
    "createdAt": "2025-01-19T00:00:00.000Z",
    "updatedAt": "2025-01-19T00:00:00.000Z"
  }
]
```

### Create Connection

```
POST /connector-accounts
```

Creates a new connection.

**Request Body:**

```json
{
  "service": "airtable",
  "displayName": "My Airtable",
  "authType": "oauth",
  "userProvidedParams": {
    "apiKey": "pat_xxxxx"
  }
}
```

| Field                | Type   | Required | Description                                          |
| -------------------- | ------ | -------- | ---------------------------------------------------- |
| `service`            | string | Yes      | Service type: `airtable`, `notion`, `webflow`, `wix` |
| `displayName`        | string | No       | Display name for the connection                      |
| `authType`           | string | No       | Auth type: `oauth`, `api_key`                        |
| `userProvidedParams` | object | No       | Credentials (varies by service)                      |

**Response (201):**

```json
{
  "id": "conn_abc123",
  "service": "airtable",
  "displayName": "My Airtable",
  "authType": "api_key",
  "healthStatus": "unknown",
  "createdAt": "2025-01-19T00:00:00.000Z"
}
```

### Get Connection

```
GET /connector-accounts/:id
```

Returns connection details.

### Update Connection

```
PATCH /connector-accounts/:id
```

Updates connection properties.

**Request Body:**

```json
{
  "displayName": "Updated Name",
  "userProvidedParams": {
    "apiKey": "new_pat_xxxxx"
  }
}
```

### Delete Connection

```
DELETE /connector-accounts/:id
```

Deletes a connection.

**Response:** `204 No Content`

### List Tables for Connection

```
GET /connector-accounts/:connectorAccountId/tables
```

Lists tables available from a specific connection.

**Response:**

```json
{
  "tables": [
    {
      "id": "tbl_abc",
      "name": "Blog Posts",
      "siteId": "base_xyz",
      "siteName": "Content Database",
      "schema": {...},
      "idField": "id"
    }
  ]
}
```

### Test Connection

```
POST /connector-accounts/:id/test
```

Tests if a connection's credentials are valid.

**Response (healthy):**

```json
{
  "health": "ok"
}
```

**Response (error):**

```json
{
  "health": "error",
  "error": "Invalid API key"
}
```

---

## Syncs

Syncs copy data between folders with field mapping and optional transformers.

### List Syncs

```
GET /workbooks/:workbookId/syncs
```

Returns all syncs for a workbook.

**Response:**

```json
[
  {
    "id": "sync_123",
    "displayName": "Blog to Webflow",
    "mappings": {
      "version": 1,
      "tableMappings": [
        {
          "sourceDataFolderId": "dfolder_airtable",
          "destinationDataFolderId": "dfolder_webflow",
          "columnMappings": [
            { "sourceColumnId": "title", "destinationColumnId": "name" },
            { "sourceColumnId": "body", "destinationColumnId": "content" }
          ],
          "recordMatching": {
            "sourceColumnId": "id",
            "destinationColumnId": "airtable_id"
          }
        }
      ]
    },
    "lastSyncTime": "2025-01-19T12:00:00.000Z",
    "createdAt": "2025-01-19T00:00:00.000Z"
  }
]
```

### Get Sync

```
GET /workbooks/:workbookId/syncs/:syncId
```

Returns a single sync by ID.

**Response:**

```json
{
  "id": "sync_123",
  "displayName": "Blog to Webflow",
  "mappings": {
    "version": 1,
    "tableMappings": [
      {
        "sourceDataFolderId": "dfolder_airtable",
        "destinationDataFolderId": "dfolder_webflow",
        "columnMappings": [
          { "sourceColumnId": "title", "destinationColumnId": "name" },
          { "sourceColumnId": "body", "destinationColumnId": "content" }
        ],
        "recordMatching": {
          "sourceColumnId": "id",
          "destinationColumnId": "airtable_id"
        }
      }
    ]
  },
  "lastSyncTime": "2025-01-19T12:00:00.000Z",
  "createdAt": "2025-01-19T00:00:00.000Z"
}
```

**Errors:**

- `404`: Workbook not found
- `404`: Sync not found

### Create Sync

```
POST /workbooks/:workbookId/syncs
```

Creates a new sync between folders.

**Request Body:**

```json
{
  "displayName": "Blog to Webflow",
  "mappings": {
    "version": 1,
    "tableMappings": [
      {
        "sourceDataFolderId": "dfolder_airtable",
        "destinationDataFolderId": "dfolder_webflow",
        "columnMappings": [
          { "sourceColumnId": "title", "destinationColumnId": "name" },
          { "sourceColumnId": "body", "destinationColumnId": "content" },
          { "sourceColumnId": "slug", "destinationColumnId": "slug" }
        ],
        "recordMatching": {
          "sourceColumnId": "id",
          "destinationColumnId": "airtable_id"
        }
      }
    ]
  }
}
```

| Field                                                           | Type   | Required | Description                             |
| --------------------------------------------------------------- | ------ | -------- | --------------------------------------- |
| `displayName`                                                   | string | Yes      | Sync display name                       |
| `mappings`                                                      | object | Yes      | Sync mapping configuration              |
| `mappings.version`                                              | number | Yes      | Schema version (must be `1`)            |
| `mappings.tableMappings`                                        | array  | Yes      | Array of table mappings                 |
| `mappings.tableMappings[].sourceDataFolderId`                   | string | Yes      | Source data folder ID                   |
| `mappings.tableMappings[].destinationDataFolderId`              | string | Yes      | Destination data folder ID              |
| `mappings.tableMappings[].columnMappings`                       | array  | Yes      | Array of column mappings                |
| `mappings.tableMappings[].columnMappings[].sourceColumnId`      | string | Yes      | Source column/field ID                  |
| `mappings.tableMappings[].columnMappings[].destinationColumnId` | string | Yes      | Destination column/field ID             |
| `mappings.tableMappings[].columnMappings[].transformer`         | object | No       | Transformer configuration               |
| `mappings.tableMappings[].recordMatching`                       | object | No       | Record matching configuration           |
| `mappings.tableMappings[].recordMatching.sourceColumnId`        | string | Yes      | Source field used to match records      |
| `mappings.tableMappings[].recordMatching.destinationColumnId`   | string | Yes      | Destination field used to match records |

**Response (201):** Returns created sync.

### Update Sync

```
PATCH /workbooks/:workbookId/syncs/:syncId
```

Updates an existing sync configuration.

**Request Body:**

```json
{
  "displayName": "Updated Sync Name",
  "mappings": {
    "version": 1,
    "tableMappings": [...]
  }
}
```

**Response:** Returns updated sync.

### Delete Sync

```
DELETE /workbooks/:workbookId/syncs/:syncId
```

Deletes a sync configuration.

**Response:** `204 No Content`

### Run Sync

```
POST /workbooks/:workbookId/syncs/:syncId/run
```

Manually triggers a sync run.

**Response:**

```json
{
  "success": true,
  "jobId": "job_xyz",
  "message": "Sync job queued successfully"
}
```

### Validate Mapping

```
POST /workbooks/:workbookId/syncs/validate-mapping
```

Validates column mappings between a source and destination folder before creating or updating a sync.

**Request Body:**

```json
{
  "sourceId": "dfolder_source",
  "destId": "dfolder_dest",
  "columnMappings": [
    { "sourceColumnId": "title", "destinationColumnId": "name" },
    { "sourceColumnId": "body", "destinationColumnId": "content" }
  ]
}
```

| Field            | Type   | Required | Description                          |
| ---------------- | ------ | -------- | ------------------------------------ |
| `sourceId`       | string | Yes      | Source data folder ID                |
| `destId`         | string | Yes      | Destination data folder ID           |
| `columnMappings` | array  | Yes      | Array of column mappings to validate |

**Response:**

```json
{
  "valid": true
}
```

---

## Jobs

Jobs track async operations like syncs and publishes.

### List Jobs

```
GET /jobs
```

Returns jobs for the authenticated user.

**Query Parameters:**

| Parameter | Type   | Default | Description           |
| --------- | ------ | ------- | --------------------- |
| `limit`   | number | 20      | Max jobs to return    |
| `offset`  | number | 0       | Offset for pagination |

**Response:**

```json
[
  {
    "dbJobId": "job_xyz",
    "bullJobId": "123",
    "type": "publish-data-folder",
    "state": "completed",
    "publicProgress": {
      "totalFiles": 10,
      "processedFiles": 10
    },
    "processedOn": "2025-01-19T12:00:00.000Z",
    "finishedOn": "2025-01-19T12:00:15.000Z",
    "failedReason": null
  }
]
```

| State       | Description               |
| ----------- | ------------------------- |
| `pending`   | Job is queued             |
| `active`    | Job is running            |
| `completed` | Job finished successfully |
| `failed`    | Job failed                |
| `canceled`  | Job was cancelled         |

### Get Job Progress

```
GET /jobs/:jobId/progress
```

Returns detailed progress for a job.

**Response:**

```json
{
  "dbJobId": "job_xyz",
  "type": "pull-files",
  "state": "active",
  "publicProgress": {
    "totalFiles": 100,
    "processedFiles": 45,
    "folders": [
      {
        "id": "dfolder_abc",
        "name": "Blog Posts",
        "files": 25,
        "status": "complete"
      },
      {
        "id": "dfolder_xyz",
        "name": "Products",
        "files": 20,
        "status": "in_progress"
      }
    ]
  },
  "progressTimestamp": 1705665600000
}
```

### Get Raw Job Data

```
GET /jobs/:jobId/raw
```

Returns the raw job data from BullMQ, including internal state and metadata.

**Response:** Raw job object from BullMQ (structure varies by job type).

### Cancel Job

```
POST /jobs/:jobId/cancel
```

Cancels a running job.

**Response:**

```json
{
  "success": true,
  "message": "Job cancelled"
}
```

### Get Bulk Job Status

```
POST /jobs/bulk-status
```

Returns status for multiple jobs in a single request.

**Request Body:**

```json
{
  "jobIds": ["job_abc", "job_xyz", "job_123"]
}
```

**Response:**

```json
[
  {
    "dbJobId": "job_abc",
    "type": "publish-data-folder",
    "state": "completed",
    "publicProgress": {...}
  },
  {
    "dbJobId": "job_xyz",
    "type": "pull-files",
    "state": "active",
    "publicProgress": {...}
  }
]
```

---

## CLI Operations

These endpoints are designed for the Scratch CLI tool.

### List Workbooks (CLI)

```
GET /cli/v1/workbooks
```

Returns workbooks for the authenticated user.

**Query Parameters:**

| Parameter   | Type   | Default     | Description                                  |
| ----------- | ------ | ----------- | -------------------------------------------- |
| `sortBy`    | string | `createdAt` | Sort field: `name`, `createdAt`, `updatedAt` |
| `sortOrder` | string | `desc`      | Sort direction: `asc`, `desc`                |

**Response:**

```json
{
  "workbooks": [
    {
      "id": "wkb_abc123",
      "name": "My Workbook",
      "createdAt": "2025-01-19T00:00:00.000Z",
      "updatedAt": "2025-01-19T00:00:00.000Z",
      "tableCount": 3
    }
  ]
}
```

### Create Workbook (CLI)

```
POST /cli/v1/workbooks
```

Creates a new workbook.

**Request Body:**

```json
{
  "name": "My New Workbook"
}
```

| Field  | Type   | Required | Description   |
| ------ | ------ | -------- | ------------- |
| `name` | string | Yes      | Workbook name |

**Response (201):**

```json
{
  "id": "wkb_abc123",
  "name": "My New Workbook",
  "createdAt": "2025-01-19T00:00:00.000Z",
  "updatedAt": "2025-01-19T00:00:00.000Z",
  "tableCount": 0
}
```

### Get Workbook (CLI)

```
GET /cli/v1/workbooks/:id
```

Returns a single workbook by ID.

**Response:**

```json
{
  "id": "wkb_abc123",
  "name": "My Workbook",
  "createdAt": "2025-01-19T00:00:00.000Z",
  "updatedAt": "2025-01-19T00:00:00.000Z",
  "tableCount": 3
}
```

**Errors:**

- `404`: Workbook not found

### Delete Workbook (CLI)

```
DELETE /cli/v1/workbooks/:id
```

Deletes a workbook.

**Response:**

```json
{
  "success": true
}
```

**Errors:**

- `404`: Workbook not found

### List Folders (CLI)

```
GET /cli/v1/workbooks/:workbookId/folders
```

Returns data folders in a workbook.

**Response:**

```json
[
  {
    "id": "dfolder_abc",
    "name": "Blog Posts",
    "connector": "airtable",
    "path": "/airtable/blog-posts"
  }
]
```

### Get Folder Files (CLI)

```
GET /cli/v1/folders/:folderId/files
```

Returns files in a folder with content and hashes.

**Response:**

```json
{
  "success": true,
  "folder": {
    "id": "dfolder_abc",
    "name": "Blog Posts"
  },
  "files": [
    {
      "name": "post-1.md",
      "content": "# Hello World",
      "hash": "abc123..."
    }
  ]
}
```

### Upload Files (CLI)

```
PUT /cli/v1/folders/:folderId/files
```

Uploads files to a folder. Uses multipart form data.

**Request:** Multipart form with:

- `files`: Array of files
- `metadata`: JSON with file metadata

**Response:**

```json
{
  "success": true,
  "syncHash": "xyz789..."
}
```

### Test Connection (CLI)

```
GET /cli/v1/test-connection
```

Tests connector credentials passed via headers.

**Headers:**

| Header                | Description                     |
| --------------------- | ------------------------------- |
| `X-Scratch-Connector` | JSON with connector credentials |

**Response:**

```json
{
  "error": null
}
```

### List Tables (CLI)

```
GET /cli/v1/list-tables
```

Lists available tables from a connector.

**Headers:** Same as test-connection.

**Response:**

```json
{
  "tables": [
    {
      "id": "tbl_abc",
      "name": "Blog Posts"
    }
  ]
}
```

### Download from Connector (CLI)

```
POST /cli/v1/download
```

Downloads data from a connector.

**Request Body:**

```json
{
  "tableId": ["tbl_abc"],
  "filenameFieldId": "title",
  "contentFieldId": "body",
  "offset": 0,
  "limit": 100
}
```

| Field             | Type     | Required | Description              |
| ----------------- | -------- | -------- | ------------------------ |
| `tableId`         | string[] | Yes      | Table IDs to download    |
| `filenameFieldId` | string   | No       | Field to use as filename |
| `contentFieldId`  | string   | No       | Field to use as content  |
| `offset`          | number   | No       | Starting record          |
| `limit`           | number   | No       | Max records (1-1000)     |

**Response:**

```json
{
  "files": [
    {
      "id": "rec_123",
      "slug": "hello-world",
      "content": "# Hello World\n\nContent here."
    }
  ]
}
```

### Trigger Pull (CLI)

```
POST /cli/v1/workbooks/:workbookId/pull
```

Triggers a pull operation to sync from external sources.

**Request Body:**

```json
{
  "dataFolderId": "dfolder_abc"
}
```

**Response:**

```json
{
  "jobId": "job_xyz"
}
```

### Get Job Status (CLI)

```
GET /cli/v1/jobs/:jobId/status
```

Returns job status with CLI-friendly progress.

**Response:**

```json
{
  "jobId": "job_xyz",
  "state": "active",
  "progress": {
    "totalFiles": 100,
    "folders": [
      {
        "id": "dfolder_abc",
        "name": "Blog Posts",
        "connector": "airtable",
        "files": 50,
        "status": "in_progress"
      }
    ]
  }
}
```

---

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "Error message here",
  "statusCode": 400
}
```

### HTTP Status Codes

| Code | Description                        |
| ---- | ---------------------------------- |
| 200  | Success                            |
| 201  | Created                            |
| 204  | No Content (success, no body)      |
| 400  | Bad Request - Invalid input        |
| 401  | Unauthorized - Not authenticated   |
| 403  | Forbidden - No permission          |
| 404  | Not Found - Resource doesn't exist |
| 500  | Internal Server Error              |

### Common Errors

**Authentication errors:**

- `"Unauthorized"` (401)

**Validation errors:**

- `"name is required"` (400)
- `"Invalid service"` (400)

**Not found errors:**

- `"Workbook not found"` (404)
- `"File not found"` (404)
- `"Folder not found"` (404)
- `"Connection not found"` (404)

**External service errors:**

- `"Invalid API key"` (401)
- `"Airtable error: ..."` (502)
- `"Webflow error: ..."` (502)

---

## Deprecated Endpoints

The following endpoints are deprecated and may be removed in a future version.

### Workbook Tables (Deprecated)

```
POST   /workbook/:id/add-table                            # Add table to workbook
PATCH  /workbook/:id/tables/:tableId/hide                 # Hide/show table
DELETE /workbook/:id/tables/:tableId                      # Remove table from workbook
```

### Column Settings (Deprecated)

```
PATCH  /workbook/:id/tables/:tableId/column-settings      # Update column settings
PATCH  /workbook/:id/tables/:tableId/title-column         # Set title column
PATCH  /workbook/:id/tables/:tableId/content-column       # Set content column
POST   /workbook/:id/tables/:tableId/hide-column          # Hide column
POST   /workbook/:id/tables/:tableId/unhide-column        # Unhide column
POST   /workbook/:id/tables/:tableId/clear-hidden-columns # Clear all hidden columns
```

---

## Deprecated Endpoint Details

### Add Table to Workbook (Deprecated)

```
POST /workbook/:id/add-table
```

Adds a table from a connection to the workbook.

**Request Body:**

```json
{
  "service": "airtable",
  "tableId": "tbl_abc123",
  "connectorAccountId": "conn_123"
}
```

**Response:**

```json
{
  "id": "snap_xyz",
  "connectorService": "airtable",
  "tableSpec": {...},
  "columnSettings": {},
  "hidden": false
}
```

### Hide/Show Table (Deprecated)

```
PATCH /workbook/:id/tables/:tableId/hide
```

Toggles table visibility in the UI.

**Request Body:**

```json
{
  "hidden": true
}
```

**Response:** Returns updated workbook.

### Remove Table (Deprecated)

```
DELETE /workbook/:id/tables/:tableId
```

Removes a table from the workbook.

**Response:** Returns updated workbook.

### Update Column Settings (Deprecated)

```
PATCH /workbook/:id/tables/:tableId/column-settings
```

Updates visibility and display settings for columns.

**Request Body:**

```json
{
  "columnSettings": {
    "col_name": { "hidden": false, "width": 200 },
    "col_email": { "hidden": true }
  }
}
```

**Response:** `204 No Content`

### Set Title Column (Deprecated)

```
PATCH /workbook/:id/tables/:tableId/title-column
```

Sets which column is used as the record title.

**Request Body:**

```json
{
  "columnId": "col_name"
}
```

**Response:** `204 No Content`

### Set Content Column (Deprecated)

```
PATCH /workbook/:id/tables/:tableId/content-column
```

Sets which column contains the main content.

**Request Body:**

```json
{
  "columnId": "col_body"
}
```

**Response:** `204 No Content`

### Hide/Unhide Columns (Deprecated)

```
POST /workbook/:id/tables/:tableId/hide-column
POST /workbook/:id/tables/:tableId/unhide-column
POST /workbook/:id/tables/:tableId/clear-hidden-columns
```

Manage column visibility.

**Request Body (hide/unhide):**

```json
{
  "columnId": "col_xyz"
}
```

**Response:** `204 No Content`
