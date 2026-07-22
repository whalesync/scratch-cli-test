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
GET    /service-check                             # Test Redis and scratch-git connections
GET    /egress-ip                                 # Get server egress IP address
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
POST   /workbook/:id/pull-assets                  # Trigger asset pull for a data folder
POST   /workbook/:id/discard-changes              # Discard uncommitted changes
POST   /workbook/:id/reset                        # Reset workbook
GET    /workbook/:id/data-folders/list            # List data folders in workbook
GET    /workbook/:id/permissions                  # List workbook permissions
GET    /workbook/:id/invites                      # List workbook invites
POST   /workbook/:id/permissions/add              # Add workbook permission
PATCH  /workbook/:id/permission/:permissionId     # Update workbook permission
DELETE /workbook/:id/permission/:permissionId     # Remove workbook permission
DELETE /workbook/:id/invite/:inviteId             # Remove workbook invite
```

### Files

```
GET    /workbooks/:workbookId/files/list/by-folder       # List files by folder ID
GET    /workbooks/:workbookId/files/resolve-references   # Resolve file references
GET    /workbooks/:workbookId/files/by-path              # Get file by path
PATCH  /workbooks/:workbookId/files/by-path              # Update file by path
DELETE /workbooks/:workbookId/files/by-path              # Delete file by path
POST   /workbooks/:workbookId/files                      # Create file
POST   /workbooks/:workbookId/files/publish              # Publish file
GET    /workbooks/:workbookId/files/download             # Download file
```

### Folders

```
POST   /data-folder/create                              # Create data folder
GET    /data-folder/:id                                 # Get data folder
DELETE /data-folder/:id                                 # Delete data folder
PATCH  /data-folder/:id                                 # Update data folder
PATCH  /data-folder/:id/rename                          # Rename data folder
PATCH  /data-folder/:id/move                            # Move data folder
POST   /data-folder/:id/files                           # Create file in folder
POST   /data-folder/:id/publish                         # Publish single data folder
POST   /data-folder/:id/pull-files                      # Pull files for data folder
GET    /data-folder/:id/schema                          # Get data folder schema
POST   /data-folder/:id/refresh-schema                  # Refresh data folder schema
GET    /data-folder/:id/schema-paths                    # Get schema paths for data folder
```

### Connections

```
POST   /workbooks/:workbookId/connections                                    # Create connection
GET    /workbooks/:workbookId/connections                                    # List connections
GET    /workbooks/:workbookId/connections/:id                                # Get connection
PATCH  /workbooks/:workbookId/connections/:id                                # Update connection
DELETE /workbooks/:workbookId/connections/:id                                # Delete connection
POST   /workbooks/:workbookId/connections/:id/test                           # Test connection
POST   /workbooks/:workbookId/connections/:id/reset                          # Reset connection
GET    /workbooks/:workbookId/connections/:connectorAccountId/tables         # List tables
GET    /workbooks/:workbookId/connections/:connectorAccountId/tables/search  # Search tables
GET    /workbooks/:workbookId/connections/:connectorAccountId/tables/schema  # Get table schema
```

### Syncs

```
POST   /workbooks/:workbookId/syncs                                 # Create sync
PATCH  /workbooks/:workbookId/syncs/:syncId                         # Update sync
GET    /workbooks/:workbookId/syncs                                 # List syncs
GET    /workbooks/:workbookId/syncs/:syncId                         # Get sync
DELETE /workbooks/:workbookId/syncs/:syncId                         # Delete sync
POST   /workbooks/:workbookId/syncs/:syncId/run                     # Run sync
POST   /workbooks/:workbookId/syncs/import-preview                  # Preview sync import
POST   /workbooks/:workbookId/syncs/preview-record                  # Preview single record sync
POST   /workbooks/:workbookId/syncs/validate-mapping                # Validate sync mapping
POST   /workbooks/:workbookId/syncs/validate-mapping-type           # Validate single mapping type trace
GET    /workbooks/:workbookId/syncs/:syncId/validate-mapping-types  # Validate all mapping types for sync
GET    /workbooks/:workbookId/syncs/export                          # Export sync configuration
POST   /sync/transformers/test                                      # Test transformer
```

### Schedules

```
POST   /workbooks/:workbookId/schedules                 # Create schedule
GET    /workbooks/:workbookId/schedules                 # List schedules
GET    /workbooks/:workbookId/schedules/by-entity       # Get schedules by entity
GET    /workbooks/:workbookId/schedules/:scheduleId     # Get schedule
PATCH  /workbooks/:workbookId/schedules/:scheduleId     # Update schedule
DELETE /workbooks/:workbookId/schedules/:scheduleId     # Delete schedule
```

### Connectors

```
GET    /connectors/metadata                            # Get connector metadata (public)
```

### Publish Pipeline

```
POST   /workbook/:workbookId/publish-v2/plan-job                # Create publish plan job
POST   /workbook/:workbookId/publish-v2/run-job                 # Run publish job
GET    /workbook/:workbookId/publish-v2                         # List publish pipelines
GET    /workbook/:workbookId/publish-v2/by-job/:jobId           # Get pipeline by job ID
GET    /workbook/:workbookId/publish-v2/:pipelineId/operations  # Get pipeline operations
GET    /workbook/:workbookId/publish-v2/index/files             # Get publish index files
GET    /workbook/:workbookId/publish-v2/index/refs              # Get publish index refs
GET    /workbook/:workbookId/publish-v2/index/assets            # Get publish index assets
DELETE /workbook/:workbookId/publish-v2/:pipelineId             # Delete pipeline
```

### Jobs

```
GET    /jobs                                            # List jobs
GET    /jobs/workbook/:workbookId/active                # Get active jobs for workbook
GET    /jobs/:jobId/progress                            # Get job progress
GET    /jobs/:jobId/raw                                 # Get raw job data
POST   /jobs/:jobId/cancel                              # Cancel job
GET    /jobs/run/:runId                                 # Get job by run ID
POST   /jobs/bulk-status                                # Get status of multiple jobs
```

### CLI Operations

CLI Workbooks:

```
GET    /cli/v1/workbooks                                              # List workbooks (CLI)
POST   /cli/v1/workbooks                                              # Create workbook (CLI)
GET    /cli/v1/workbooks/:id                                          # Get workbook (CLI)
DELETE /cli/v1/workbooks/:id                                          # Delete workbook (CLI)
ALL    /cli/v1/workbooks/:id/connectors/:connectorAccountId/git/*path # Git proxy (CLI)
```

CLI Connections:

```
GET    /cli/v1/workbooks/:workbookId/connections                              # List connections (CLI)
POST   /cli/v1/workbooks/:workbookId/connections                              # Create connection (CLI)
GET    /cli/v1/workbooks/:workbookId/connections/:id                          # Get connection (CLI)
GET    /cli/v1/workbooks/:workbookId/connections/:connectorAccountId/tables   # List tables (CLI)
DELETE /cli/v1/workbooks/:workbookId/connections/:id                          # Delete connection (CLI)
```

CLI Linked Folders:

```
GET    /cli/v1/jobs/:jobId/progress                                          # Get job progress (CLI)
GET    /cli/v1/workbooks/:workbookId/linked                                  # List linked folders
POST   /cli/v1/workbooks/:workbookId/linked                                  # Create linked folder
DELETE /cli/v1/workbooks/:workbookId/linked/:folderId                        # Delete linked folder
GET    /cli/v1/workbooks/:workbookId/linked/:folderId                        # Get linked folder
POST   /cli/v1/workbooks/:workbookId/linked/:folderId/pull                   # Pull linked folder
POST   /cli/v1/workbooks/:workbookId/linked/:folderId/pull-files             # Pull files for linked folder
POST   /cli/v1/workbooks/:workbookId/linked/:folderId/publish                # Publish linked folder
```

CLI Syncs:

```
GET    /cli/v1/workbooks/:workbookId/syncs                                   # List syncs (CLI)
POST   /cli/v1/workbooks/:workbookId/syncs                                   # Create sync (CLI)
GET    /cli/v1/workbooks/:workbookId/syncs/export                            # Export syncs (CLI)
GET    /cli/v1/workbooks/:workbookId/syncs/:syncId                           # Get sync (CLI)
PATCH  /cli/v1/workbooks/:workbookId/syncs/:syncId                           # Update sync (CLI)
DELETE /cli/v1/workbooks/:workbookId/syncs/:syncId                           # Delete sync (CLI)
POST   /cli/v1/workbooks/:workbookId/syncs/:syncId/run                       # Run sync (CLI)
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
  "server": "Scratch API",
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
  "service": "scratch-api",
  "build_version": "1.2.3",
  "in_cloud": true,
  "app_url": "https://app.scratch.md",
  "apptype": "MONOLITH"
}
```

### Service Check

```
GET /service-check
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

### Pull Assets

```
POST /workbook/:id/pull-assets
```

Triggers an asset pull for a specific data folder in the workbook.

**Request Body:**

```json
{
  "dataFolderId": "dfolder_abc"
}
```

| Field          | Type   | Required | Description             |
| -------------- | ------ | -------- | ----------------------- |
| `dataFolderId` | string | Yes      | Data folder to pull for |

**Response:**

```json
{
  "jobId": "job_xyz",
  "warning": "optional warning message"
}
```

### Discard Changes

```
POST /workbook/:id/discard-changes
```

Discards uncommitted changes in the workbook, reverting files to their last committed state.

### Reset Workbook

```
POST /workbook/:id/reset
```

Resets the workbook, clearing its state.

### List Data Folders

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

### List Permissions

```
GET /workbook/:id/permissions
```

Lists all permissions for a workbook.

**Response:**

```json
[
  {
    "id": "wpe_abc123",
    "workbookId": "wkb_123",
    "userId": "user_abc",
    "role": "editor",
    "createdAt": "2025-01-19T00:00:00.000Z"
  }
]
```

### List Invites

```
GET /workbook/:id/invites
```

Lists all pending invites for a workbook.

**Response:**

```json
[
  {
    "id": "win_abc123",
    "workbookId": "wkb_123",
    "email": "invited@example.com",
    "role": "editor",
    "createdAt": "2025-01-19T00:00:00.000Z"
  }
]
```

### Add Permission

```
POST /workbook/:id/permissions/add
```

Adds a permission to a workbook. Provide either `userId` or `email` — if the user doesn't have an account, an invite is created instead.

**Request Body:**

```json
{
  "userId": "user_abc",
  "email": "user@example.com",
  "role": "editor"
}
```

| Field    | Type   | Required | Description                           |
| -------- | ------ | -------- | ------------------------------------- |
| `userId` | string | No       | User ID (provide this or `email`)     |
| `email`  | string | No       | User email (provide this or `userId`) |
| `role`   | string | No       | Permission role                       |

**Response:** Returns the created `WorkspacePermission` object, or `void` if an invite was created.

### Update Permission

```
PATCH /workbook/:id/permission/:permissionId
```

Updates a permission's role on a workbook.

**Request Body:**

```json
{
  "role": "viewer"
}
```

**Response:** Returns the updated `WorkspacePermission` object.

### Remove Permission

```
DELETE /workbook/:id/permission/:permissionId
```

Removes a permission from a workbook.

**Response:** `204 No Content`

### Remove Invite

```
DELETE /workbook/:id/invite/:inviteId
```

Removes a pending invite from a workbook.

**Response:** `204 No Content`

---

## Files

Files are version-controlled content stored in git.

### List Files by Folder

```
GET /workbooks/:workbookId/files/list/by-folder
```

Returns files in a specific folder.

**Query Parameters:**

| Parameter  | Type   | Description         |
| ---------- | ------ | ------------------- |
| `folderId` | string | Filter by folder ID |

### Resolve File References

```
GET /workbooks/:workbookId/files/resolve-references
```

Resolves file references within the workbook. Used to look up files that are referenced by other files.

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

### Update File by Path

```
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

### Delete File by Path

```
DELETE /workbooks/:workbookId/files/by-path?path=...
```

Deletes a file.

**Response:** `204 No Content`

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

### Download File

```
GET /workbooks/:workbookId/files/download
```

Downloads a file from the workbook.

---

## Folders

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

### Delete Data Folder

```
DELETE /data-folder/:id
```

Deletes a data folder and its contents.

**Response:** `204 No Content`

### Update Data Folder

```
PATCH /data-folder/:id
```

Updates data folder properties.

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

### Pull Files for Data Folder

```
POST /data-folder/:id/pull-files
```

Pulls files from the external source for this data folder.

### Get Data Folder Schema

```
GET /data-folder/:id/schema
```

Returns the schema for a data folder, describing the structure and fields of its records.

### Refresh Data Folder Schema

```
POST /data-folder/:id/refresh-schema
```

Refreshes the schema for a data folder by re-fetching it from the external service.

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
GET /workbooks/:workbookId/connections
```

Returns all connections for the workbook.

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
POST /workbooks/:workbookId/connections
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
GET /workbooks/:workbookId/connections/:id
```

Returns connection details.

### Update Connection

```
PATCH /workbooks/:workbookId/connections/:id
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
DELETE /workbooks/:workbookId/connections/:id
```

Deletes a connection.

**Response:** `204 No Content`

### Test Connection

```
POST /workbooks/:workbookId/connections/:id/test
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

### Reset Connection

```
POST /workbooks/:workbookId/connections/:id/reset
```

Resets the connection state.

### List Tables for Connection

```
GET /workbooks/:workbookId/connections/:connectorAccountId/tables
```

Lists tables available from a specific connection.

**Response:**

```json
{
  "tables": [
    {
      "id": { "wsId": "blog-posts", "remoteId": ["base_xyz", "tbl_abc"] },
      "displayName": "Blog Posts",
      "parentPath": "Content Database",
      "disabled": false,
      "disabledCreates": false,
      "disabledReason": null,
      "metadata": { "baseName": "Content Database" }
    }
  ],
  "discoveryMode": "LIST",
  "supportsFilters": false,
  "supportsFieldSelection": false,
  "advancedSettings": []
}
```

| Field                      | Type     | Description                                                        |
| -------------------------- | -------- | ------------------------------------------------------------------ |
| `tables[].id`              | EntityId | Contains `wsId` (workspace identifier) and `remoteId` (path array) |
| `tables[].displayName`     | string   | Table display name                                                 |
| `tables[].parentPath`      | string?  | Slash-separated path for grouping (e.g. `"My Project/public"`)     |
| `tables[].disabled`        | boolean? | If true, the table cannot be selected                              |
| `tables[].disabledCreates` | boolean? | If true, creating new records in this table is not supported       |
| `tables[].disabledReason`  | string?  | Human-readable explanation for disabled/disabledCreates            |
| `tables[].metadata`        | object?  | Connector-specific metadata                                        |
| `discoveryMode`            | string   | `LIST` (full list) or `SEARCH` (search-based discovery)            |
| `supportsFilters`          | boolean  | Whether the connector supports filter expressions                  |
| `supportsFieldSelection`   | boolean  | Whether the connector supports field/column selection              |
| `advancedSettings`         | array    | Per-table advanced settings definitions                            |

### Search Tables

```
GET /workbooks/:workbookId/connections/:connectorAccountId/tables/search
```

Searches for tables matching a query within the connection.

### Get Table Schema

```
GET /workbooks/:workbookId/connections/:connectorAccountId/tables/schema
```

Returns the schema for a specific table in the connection.

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

### Import Preview

```
POST /workbooks/:workbookId/syncs/import-preview
```

Previews the result of importing data via a sync, without actually performing the import.

### Preview Record

```
POST /workbooks/:workbookId/syncs/preview-record
```

Previews the sync result for a single record, useful for testing mappings and transformers.

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

### Validate Mapping Type

```
POST /workbooks/:workbookId/syncs/validate-mapping-type
```

Traces a type through a single mapping's transformer pipeline. Returns the source type, each transformation step, the destination type, and any type compatibility errors.

**Request Body:**

```json
{
  "sourceFolderId": "dfolder_source",
  "destFolderId": "dfolder_dest",
  "sourceColumnId": "title",
  "destinationColumnId": "name",
  "transformers": []
}
```

| Field                 | Type   | Required | Description                   |
| --------------------- | ------ | -------- | ----------------------------- |
| `sourceFolderId`      | string | Yes      | Source data folder ID         |
| `destFolderId`        | string | Yes      | Destination data folder ID    |
| `sourceColumnId`      | string | Yes      | Source column identifier      |
| `destinationColumnId` | string | Yes      | Destination column identifier |
| `transformers`        | array  | Yes      | Transformer pipeline to trace |

**Response:**

```json
{
  "sourceType": { "type": "string" },
  "steps": [],
  "destinationType": { "type": "string" },
  "validation": []
}
```

### Validate Sync Mapping Types

```
GET /workbooks/:workbookId/syncs/:syncId/validate-mapping-types
```

Runs type validation on every field mapping in a sync. Returns any type compatibility errors across all mappings.

**Response:**

```json
{
  "errors": []
}
```

### Export Syncs

```
GET /workbooks/:workbookId/syncs/export
```

Exports sync configuration for a workbook.

**Query Parameters:**

| Parameter | Type   | Required | Description                                    |
| --------- | ------ | -------- | ---------------------------------------------- |
| `syncId`  | string | No       | Export only this sync (or all if not provided) |

**Response:**

```json
[
  {
    "id": "syn_abc",
    "displayName": "My Sync",
    "mappings": {},
    "validateMappings": true,
    "schedule": "0 */6 * * *",
    "publishAfterSync": false,
    "_metadata": {
      "syncState": "active",
      "lastSyncTime": "2025-01-19T12:00:00.000Z",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-19T12:00:00.000Z"
    }
  }
]
```

### Test Transformer

```
POST /sync/transformers/test
```

Tests a transformer configuration against sample data without running a full sync.

---

### Connectors

### Get Connector Metadata

```
GET /connectors/metadata
```

Returns metadata for all available connectors. **No authentication required.**

**Response:**

```json
{
  "AIRTABLE": {
    "displayName": "Airtable",
    "table": "table",
    "tables": "tables",
    "record": "record",
    "records": "records",
    "base": "base",
    "bases": "bases",
    "logo": "https://static.scratch.md/connector-icons/airtable.svg",
    "visible": true,
    "pushOperationName": "Publish",
    "pullOperationName": "Download",
    "supportedAuthMethods": ["oauth", "user_provided_params"],
    "defaultAuthMethod": "oauth",
    "oauth": { "label": "OAuth" },
    "credentialFields": {
      "user_provided_params": [
        {
          "key": "apiKey",
          "type": "password",
          "label": "Personal Access Token",
          "placeholder": "pat...",
          "required": true
        }
      ]
    }
  }
}
```

| Field                     | Type     | Description                                                             |
| ------------------------- | -------- | ----------------------------------------------------------------------- |
| `displayName`             | string   | Human-readable connector name                                           |
| `table` / `tables`        | string   | Terminology for tables (e.g. "collection"/"collections")                |
| `record` / `records`      | string   | Terminology for records (e.g. "item"/"items")                           |
| `base` / `bases`          | string?  | Terminology for bases/projects (null if not applicable)                 |
| `logo`                    | string   | URL to connector icon                                                   |
| `visible`                 | boolean  | Whether the connector is shown in the UI                                |
| `pushOperationName`       | string   | Label for the publish operation (e.g. "Publish")                        |
| `pullOperationName`       | string   | Label for the download operation (e.g. "Download")                      |
| `supportedAuthMethods`    | string[] | Supported auth methods: `oauth`, `user_provided_params`, `oauth_custom` |
| `defaultAuthMethod`       | string   | Default auth method for this connector                                  |
| `oauth`                   | object?  | OAuth display labels (`label`, optional `privateLabel`)                 |
| `credentialFields`        | object?  | Per-auth-method credential field definitions (see below)                |
| `userProvidedParamsLabel` | string?  | Radio button label for API key auth (default: "API Key")                |

**`credentialFields`** is keyed by auth method. Each entry is an array of field definitions:

| Field         | Type     | Description                                            |
| ------------- | -------- | ------------------------------------------------------ |
| `key`         | string   | Field key sent to server (e.g. `apiKey`, `shopDomain`) |
| `type`        | string   | `string`, `password`, or `boolean`                     |
| `label`       | string   | Display label                                          |
| `placeholder` | string?  | Input placeholder text                                 |
| `description` | string?  | Help text shown below the input                        |
| `required`    | boolean? | Whether the field is required for submission           |

---

## Schedules

Schedules automate recurring operations like syncs and publishes.

### Create Schedule

```
POST /workbooks/:workbookId/schedules
```

Creates a new schedule for automated operations.

### List Schedules

```
GET /workbooks/:workbookId/schedules
```

Returns all schedules for a workbook.

### Get Schedules by Entity

```
GET /workbooks/:workbookId/schedules/by-entity
```

Returns schedules filtered by the entity they operate on (e.g., a specific sync or data folder).

### Get Schedule

```
GET /workbooks/:workbookId/schedules/:scheduleId
```

Returns a single schedule by ID.

### Update Schedule

```
PATCH /workbooks/:workbookId/schedules/:scheduleId
```

Updates an existing schedule.

### Delete Schedule

```
DELETE /workbooks/:workbookId/schedules/:scheduleId
```

Deletes a schedule.

---

## Publish Pipeline

The publish pipeline manages the process of publishing changes from workbook files to external services.

### Create Publish Plan Job

```
POST /workbook/:workbookId/publish-v2/plan-job
```

Creates a plan job that computes what changes need to be published.

### Run Publish Job

```
POST /workbook/:workbookId/publish-v2/run-job
```

Executes a publish job based on a previously created plan.

### List Publish Pipelines

```
GET /workbook/:workbookId/publish-v2
```

Returns all publish pipelines for a workbook.

### Get Pipeline by Job ID

```
GET /workbook/:workbookId/publish-v2/by-job/:jobId
```

Returns a publish pipeline associated with a specific job.

### Get Pipeline Operations

```
GET /workbook/:workbookId/publish-v2/:pipelineId/operations
```

Returns the individual operations within a publish pipeline.

### Get Publish Index Files

```
GET /workbook/:workbookId/publish-v2/index/files
```

Returns the publish index of files, showing what has been published.

### Get Publish Index Refs

```
GET /workbook/:workbookId/publish-v2/index/refs
```

Returns the publish index of git refs.

### Get Publish Index Assets

```
GET /workbook/:workbookId/publish-v2/index/assets
```

Returns the publish index of assets.

### Delete Pipeline

```
DELETE /workbook/:workbookId/publish-v2/:pipelineId
```

Deletes a publish pipeline.

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

### Get Active Jobs for Workbook

```
GET /jobs/workbook/:workbookId/active
```

Returns all currently active (running or pending) jobs for a specific workbook.

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

### Get Job by Run ID

```
GET /jobs/run/:runId
```

Returns a job by its run ID. Run IDs are alternative identifiers used by some job types.

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

### Git Proxy (CLI)

```
ALL /cli/v1/workbooks/:id/connectors/:connectorAccountId/git/*path
```

Proxies Git HTTP requests to the scratch-git service for a specific workbook and connection. Used by the CLI for git clone/pull/push operations.

### List Connections (CLI)

```
GET /cli/v1/workbooks/:workbookId/connections
```

Returns connections for a workbook.

### Create Connection (CLI)

```
POST /cli/v1/workbooks/:workbookId/connections
```

Creates a new connection in the context of a workbook.

### Get Connection (CLI)

```
GET /cli/v1/workbooks/:workbookId/connections/:id
```

Returns a single connection by ID.

### List Tables (CLI)

```
GET /cli/v1/workbooks/:workbookId/connections/:connectorAccountId/tables
```

Lists tables available from a connection. Response format matches the web API endpoint (see [List Tables](#list-tables)).

### Delete Connection (CLI)

```
DELETE /cli/v1/workbooks/:workbookId/connections/:id
```

Deletes a connection.

### Get Job Progress (CLI)

```
GET /cli/v1/jobs/:jobId/progress
```

Returns job progress with CLI-friendly formatting.

### List Linked Folders

```
GET /cli/v1/workbooks/:workbookId/linked
```

Returns linked folders in a workbook. Linked folders are data folders that are synced with the local filesystem via the CLI.

### Create Linked Folder

```
POST /cli/v1/workbooks/:workbookId/linked
```

Creates a new linked folder in the workbook.

### Delete Linked Folder

```
DELETE /cli/v1/workbooks/:workbookId/linked/:folderId
```

Deletes a linked folder.

### Get Linked Folder

```
GET /cli/v1/workbooks/:workbookId/linked/:folderId
```

Returns a single linked folder by ID.

### Pull Linked Folder

```
POST /cli/v1/workbooks/:workbookId/linked/:folderId/pull
```

Pulls data from the external source into the linked folder.

### Pull Files for Linked Folder

```
POST /cli/v1/workbooks/:workbookId/linked/:folderId/pull-files
```

Pulls files from the external source for the linked folder.

### Publish Linked Folder

```
POST /cli/v1/workbooks/:workbookId/linked/:folderId/publish
```

Publishes changes from the linked folder to the external service.

### List Syncs (CLI)

```
GET /cli/v1/workbooks/:workbookId/syncs
```

Returns all syncs for a workbook.

### Create Sync (CLI)

```
POST /cli/v1/workbooks/:workbookId/syncs
```

Creates a new sync.

### Get Sync (CLI)

```
GET /cli/v1/workbooks/:workbookId/syncs/:syncId
```

Returns a single sync by ID.

### Update Sync (CLI)

```
PATCH /cli/v1/workbooks/:workbookId/syncs/:syncId
```

Updates an existing sync configuration.

### Delete Sync (CLI)

```
DELETE /cli/v1/workbooks/:workbookId/syncs/:syncId
```

Deletes a sync.

### Run Sync (CLI)

```
POST /cli/v1/workbooks/:workbookId/syncs/:syncId/run
```

Manually triggers a sync run.

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
