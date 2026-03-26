# Endpoint Usage Audit: DataFolderController, WorkbookController, FilesController

**Date:** 2026-03-25
**Purpose:** Identify endpoints that can be deprecated, removed, or deduplicated across client UI and Rust CLI (`experimental/scratch-cli-2`).

## Key Finding: Rust CLI Uses Separate Controllers

The Rust CLI prefixes all requests with `/cli/v1` and hits dedicated CLI controllers (`server/src/cli/cli-*.controller.ts`), **not** the three controllers analyzed here. None of the endpoints below are called by the Rust CLI.

---

## Endpoint Matrix

### Legend


| Symbol  | Meaning                                                         |
| ------- | --------------------------------------------------------------- |
| **Y**   | Actively used in production UI flows                            |
| **D**   | Debug/dev-only usage                                            |
| **API** | Client API function exists but is never called from a component |
| **-**   | No client usage at all                                          |


---

### DataFolderController (`/data-folder`)


| #   | Method | Route                             | Handler                   | Client API Function                | UI Usage | Components                                              |
| --- | ------ | --------------------------------- | ------------------------- | ---------------------------------- | -------- | ------------------------------------------------------- |
| 1   | POST   | `/data-folder/create`             | `create`                  | `dataFolderApi.create`             | **Y**    | ChooseTablesModal (via `useWorkbook`)                   |
| 2   | GET    | `/data-folder/:id`                | `findOne`                 | `dataFolderApi.findOne`            | **API**  | `useDataFolder` hook exists but no component imports it |
| 3   | DELETE | `/data-folder/:id`                | `delete`                  | `dataFolderApi.delete`             | **Y**    | RemoveTableModal (via `useDataFolders`)                 |
| 4   | PATCH  | `/data-folder/:id`                | `update`                  | `dataFolderApi.update`             | **Y**    | AdvancedFolderSettingsModal                             |
| 5   | POST   | `/data-folder/:id/files`          | `createFile`              | `workbookApi.createDataFolderFile` | **Y**    | NewFileModal                                            |
| 6   | POST   | `/data-folder/:id/publish`        | `publishSingleFolder`     | **-**                              | **-**    | No client API function calls this endpoint              |
| 7   | POST   | `/data-folder/:id/pull-files`     | `pullFiles`               | `dataFolderApi.pullFiles`          | **Y**    | TreeNode (pull individual files)                        |
| 8   | GET    | `/data-folder/:id/schema`         | `getDataFolderSchema`     | `dataFolderApi.getSchema`          | **Y**    | DataFolderSchemaModal                                   |
| 9   | POST   | `/data-folder/:id/refresh-schema` | `refreshDataFolderSchema` | `dataFolderApi.refreshSchema`      | **Y**    | DataFolderSchemaModal                                   |
| 10  | GET    | `/data-folder/:id/schema-paths`   | `getSchemaPaths`          | `workbookApi.getSchemaPaths`       | **Y**    | ChooseTablesModal                                       |


---

### WorkbookController (`/workbook`)


| #   | Method | Route                                    | Handler            | Client API Function            | UI Usage | Components                                                                                           |
| --- | ------ | ---------------------------------------- | ------------------ | ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| 11  | POST   | `/workbook`                              | `create`           | `workbookApi.create`           | **Y**    | HomePage, ChooseTablesModal (via `useWorkbooks`)                                                     |
| 12  | GET    | `/workbook`                              | `findAll`          | `workbookApi.list`             | **Y**    | HomePage, ProjectSwitcher (via `useWorkbooks`)                                                       |
| 13  | GET    | `/workbook/:id`                          | `findOne`          | `workbookApi.detail`           | **Y**    | Workbook layout, DebugMenu (via `useWorkbook`)                                                       |
| 14  | PATCH  | `/workbook/:id`                          | `update`           | `workbookApi.update`           | **Y**    | ChooseTablesModal (via `useWorkbooks`/`useWorkbook`)                                                 |
| 15  | POST   | `/workbook/:id/pull-files`               | `pullFiles`        | `workbookApi.pullFiles`        | **Y**    | FilesSubToolbar, ChooseTablesModal (via `useWorkbook`)                                               |
| 16  | POST   | `/workbook/:id/pull-assets`              | `pullAssets`       | `workbookApi.pullAssets`       | **Y**    | TreeNode (via `useWorkbook`)                                                                         |
| 17  | DELETE | `/workbook/:id`                          | `remove`           | `workbookApi.delete`           | **Y**    | Dev settings page (via `useWorkbooks`)                                                               |
| 18  | POST   | `/workbook/:id/discard-changes`          | `discardChanges`   | `workbookApi.discardChanges`   | **Y**    | Review page (via `useWorkbook`)                                                                      |
| 19  | POST   | `/workbook/:id/reset`                    | `reset`            | `workbookApi.resetWorkbook`    | **D**    | DebugMenu only                                                                                       |
| 20  | GET    | `/workbook/:id/data-folders/list`        | `listDataFolders`  | `workbookApi.listDataFolders`  | **Y**    | FileTree, FolderViewer, ReviewPage, SyncEditor, RunsView, etc. (10+ components via `useDataFolders`) |
| 21  | GET    | `/workbook/:id/permissions`              | `listPermissions`  | `workbookApi.listPermissions`  | **Y**    | WorkspacePermissionsModal (via `useWorkspacePermissions`)                                            |
| 22  | GET    | `/workbook/:id/invites`                  | `listInvites`      | `workbookApi.listInvites`      | **Y**    | WorkspacePermissionsModal (via `useWorkspacePermissions`)                                            |
| 23  | POST   | `/workbook/:id/permissions/add`          | `addPermission`    | `workbookApi.addPermission`    | **Y**    | WorkspacePermissionsModal (via `useWorkspacePermissions`)                                            |
| 24  | DELETE | `/workbook/:id/permission/:permissionId` | `removePermission` | `workbookApi.removePermission` | **Y**    | WorkspacePermissionsModal (via `useWorkspacePermissions`)                                            |
| 25  | PATCH  | `/workbook/:id/permission/:permissionId` | `updatePermission` | `workbookApi.updatePermission` | **Y**    | WorkspacePermissionsModal (via `useWorkspacePermissions`)                                            |
| 26  | DELETE | `/workbook/:id/invite/:inviteId`         | `removeInvite`     | `workbookApi.deleteInvite`     | **Y**    | WorkspacePermissionsModal (via `useWorkspacePermissions`)                                            |


---

### FilesController (`/workbooks/:workbookId/files`)


| #   | Method | Route                                             | Handler             | Client API Function          | UI Usage | Components                                                                                                                                         |
| --- | ------ | ------------------------------------------------- | ------------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 27  | GET    | `/workbooks/:workbookId/files/list/by-folder`     | `listFilesByFolder` | `filesApi.listFilesByFolder` | **Y**    | FileViewer, FolderViewer, ReviewFileViewer, TableDetail, SyncEditor, TreeNode (7+ components via `useFolderFileList`/`useFolderFileListPaginated`) |
| 28  | GET    | `/workbooks/:workbookId/files/resolve-references` | `resolveReferences` | `filesApi.resolveReferences` | **Y**    | ReviewFileViewer (FK reference links on both main/dirty branches)                                                                                  |
| 29  | GET    | `/workbooks/:workbookId/files/by-path`            | `getFileByPath`     | `filesApi.getFileByPath`     | **Y**    | FileViewer, ReviewFileViewer, SyncEditor, TableDetail (via `useFileByPath`)                                                                        |
| 30  | PATCH  | `/workbooks/:workbookId/files/by-path`            | `updateFileByPath`  | `filesApi.updateFileByPath`  | **Y**    | FileViewer, ReviewFileViewer, TableDetail (via `useFileByPath`)                                                                                    |
| 31  | DELETE | `/workbooks/:workbookId/files/by-path`            | `deleteFileByPath`  | `filesApi.deleteFileByPath`  | **Y**    | RemoveFileModal (via `useFileByPath`)                                                                                                              |
| 32  | POST   | `/workbooks/:workbookId/files`                    | `createFile`        | `filesApi.createFile`        | **API**  | Function exists but NewFileModal uses `workbookApi.createDataFolderFile` (POST `/data-folder/:id/files`) instead                                   |
| 33  | POST   | `/workbooks/:workbookId/files/publish`            | `publishFile`       | `filesApi.publishFile`       | **API**  | Function exists but UI uses `workbookApi.planPublishV2` for all publishing                                                                         |
| 34  | GET    | `/workbooks/:workbookId/files/download`           | `downloadFolder`    | `filesApi.downloadFolder`    | **Y**    | TreeNode (download folder as ZIP)                                                                                                                  |


---

## Rust CLI Usage (`experimental/scratch-cli-2`)

The CLI uses a `/cli/v1` prefix and hits **dedicated CLI controllers** in `server/src/cli/`:


| CLI Controller                 | Server Path                         | CLI Commands                                                                                 |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `cli-workbook.controller.ts`   | `/cli/v1/workbooks`                 | `workbooks list`, `workbooks create`, `workbooks show`, `workbooks delete`                   |
| `cli-connection.controller.ts` | `/cli/v1/workbooks/:id/connections` | `connections list`, `connections show`, `connections add`, `connections remove`              |
| `cli-linked.controller.ts`     | `/cli/v1/workbooks/:id/linked`      | `linked list`, `linked add`, `linked remove`, `linked show`, `linked pull`, `linked publish` |
| `cli-sync.controller.ts`       | `/cli/v1/workbooks/:id/syncs`       | `syncs list`, `syncs show`, `syncs create`, `syncs update`, `syncs delete`, `syncs run`      |
| `cli-auth.controller.ts`       | `/cli/v1/auth`                      | `auth login`                                                                                 |


**None of the 34 endpoints from DataFolderController, WorkbookController, or FilesController are called by the Rust CLI.** File sync in the CLI uses direct git operations (clone/fetch/push), not HTTP file APIs.

---

## Deprecation Candidates

### Unused Endpoints (no client callers)


| #   | Endpoint                        | Reason                                                                                      | Recommendation         |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| 6   | POST `/data-folder/:id/publish` | No client API function references this route. Publishing uses `planPublishV2` flow instead. | **Remove** - dead code |


### Dead Client API Functions (API exists, never called from UI)


| #   | Endpoint                                    | Client Function         | Reason                                                           | Recommendation                                                                   |
| --- | ------------------------------------------- | ----------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 2   | GET `/data-folder/:id`                      | `dataFolderApi.findOne` | `useDataFolder` hook exists but is not imported by any component | **Investigate** - may be leftover from a removed feature                         |
| 32  | POST `/workbooks/:workbookId/files`         | `filesApi.createFile`   | NewFileModal uses `POST /data-folder/:id/files` instead          | **Remove API function** or migrate NewFileModal to use this endpoint             |
| 33  | POST `/workbooks/:workbookId/files/publish` | `filesApi.publishFile`  | UI uses `planPublishV2` for all publishing workflows             | **Remove API function** and server endpoint if `planPublishV2` fully replaces it |


### Debug-Only Endpoints


| #   | Endpoint                   | Reason                 | Recommendation                                                     |
| --- | -------------------------- | ---------------------- | ------------------------------------------------------------------ |
| 19  | POST `/workbook/:id/reset` | Only used in DebugMenu | **Keep** - useful for dev, but consider gating behind feature flag |


### Duplication to Resolve


| Area          | Endpoints                                                                                                    | Issue                                                                                                   | Recommendation                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| File creation | `POST /data-folder/:id/files` (#5) vs `POST /workbooks/:workbookId/files` (#32)                              | Two endpoints for creating files. UI uses #5, #32 is unused.                                            | Pick one canonical endpoint. Since #32 follows REST conventions better (`/workbooks/:id/files`), consider migrating to #32 and deprecating #5. |
| File deletion | `filesApi.deleteFileByPath` (via `useFileByPath`) vs `workbookApi.deleteFile` (in RemoveFileModal)           | Two client API functions call the same server endpoint (`DELETE /workbooks/:workbookId/files/by-path`). | Consolidate to one API function. `filesApi.deleteFileByPath` is the canonical location.                                                        |
| File publish  | `POST /data-folder/:id/publish` (#6) vs `POST /workbooks/:workbookId/files/publish` (#33) vs `planPublishV2` | Three publish mechanisms. Only `planPublishV2` is actively used.                                        | Remove #6 and #33 if `planPublishV2` is the permanent replacement.                                                                             |


---

## Summary


| Category                                          | Count                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| Total endpoints analyzed                          | 34                                                 |
| Actively used in UI                               | 27                                                 |
| API-only (function exists, no component calls it) | 3 (#2, #32, #33)                                   |
| Debug-only                                        | 1 (#19)                                            |
| No client usage at all                            | 1 (#6)                                             |
| Unreferenced by Rust CLI                          | 34 (all - CLI uses separate `/cli/v1` controllers) |


