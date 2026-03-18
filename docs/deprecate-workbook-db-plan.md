# WorkbookDb and WorkbookDbService Deprecation Plan

> **Status**: Planning
> **Created**: 2026-02-06
> **Owner**: TBD

## Overview

This document outlines the plan for deprecating and removing the `WorkbookDb` and `WorkbookDbService` classes from the server project. These classes manage file storage using a per-workbook PostgreSQL schema with Knex, and need to be replaced with a new storage architecture.

## Current Architecture

### Core Files

| File                     | Location               | Description                                                                       |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------- |
| `workbook-db.ts`         | `server/src/workbook/` | Main class (~1,240 lines) with file CRUD, search, sync, and publishing operations |
| `workbook-db.service.ts` | `server/src/workbook/` | NestJS service wrapper with lifecycle hooks                                       |
| `workbook-db.module.ts`  | `server/src/workbook/` | NestJS module that provides and exports the service                               |

### Key Functionality in WorkbookDb

- **File CRUD**: `createFileWithFolderId()`, `getFileById()`, `getFileByPath()`, `updateFileById()`, `deleteFileById()`, `undeleteFileById()`
- **Batch Operations**: `listAllFiles()`, `getFilesByFolderId()`, `getFilesByIds()`, `listFilesAndFolders()`
- **Search**: `findFilesByPattern()`, `grepFiles()`
- **Suggestions**: `acceptSuggestionOnFile()`, `rejectSuggestionOnFile()`, `acceptSuggestionsForFolder()`, `rejectSuggestionsForFolder()`
- **Sync Operations**: `upsertFilesFromConnectorRecords()`, `upsertFilesFromConnectorFiles()`, `resetSeenFlagForFolder()`
- **Publishing**: `updateFileAfterPublishing()`, `hardDeleteFiles()`, `markFilesAsClean()`
- **State Management**: `setFileDirtyState()`, `updateFile()`, `deleteFilesInFolder()`, `forAllDirtyFiles()`, `countExpectedOperations()`
- **Schema Management**: `createForWorkbook()`, `cleanupSchema()`

### Exported Utility Functions

These standalone functions are imported separately from the WorkbookDb class:

1. **`convertConnectorRecordToFrontMatter()`** - Converts ConnectorRecord to front matter markdown format
2. **`convertFileToConnectorRecord()`** - Converts file database record to connector record for publishing

---

## Dependencies Analysis

### 1. Server Services (4 files)

| File                                | Usage                                             | Impact                                |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------- |
| `workbook.service.ts`               | Constructor injection only                        | Low - remove injection                |
| `files.service.ts`                  | **20+ method calls** to workbookDb                | **High** - primary consumer           |
| `folder.service.ts`                 | Constructor injection only                        | Low - remove injection                |
| `webflow-custom-actions.service.ts` | Uses `convertFileToConnectorRecord()` + injection | Medium - already deprecated code path |

### 2. BullMQ Worker Jobs (3 files)

| Job Handler                       | File                              | WorkbookDb Usage                |
| --------------------------------- | --------------------------------- | ------------------------------- |
| `PullFilesJobHandler`             | `pull-files.job.ts`               | `resetSeenFlagForFolder()`      |
| `PullRecordFilesJobHandler`       | `pull-record-files.job.ts`        | Constructor receives WorkbookDb |
| `PullLinkedFolderFilesJobHandler` | `pull-linked-folder-files.job.ts` | Constructor receives WorkbookDb |

### 3. Job Infrastructure (2 files)

| File                     | Usage                                                 |
| ------------------------ | ----------------------------------------------------- |
| `job-handler.service.ts` | Passes `workbookDbService.workbookDb` to job handlers |
| `workers.module.ts`      | Imports `WorkbookDbModule`                            |

### 4. Module Imports (3 files)

| File                               | Usage                                  |
| ---------------------------------- | -------------------------------------- |
| `workbook.module.ts`               | Imports and exports `WorkbookDbModule` |
| `webflow-custom-actions.module.ts` | Imports `WorkbookDbModule`             |
| `workers.module.ts`                | Imports `WorkbookDbModule`             |

---

## REST Endpoints to Evaluate

All endpoints are in `files.controller.ts` and call `FilesService` methods that use WorkbookDbService internally.

### FilesController Endpoints

| Method | Route                                         | Service Method       | Action                |
| ------ | --------------------------------------------- | -------------------- | --------------------- |
| GET    | `/workbooks/:workbookId/files/list`           | `listFiles()`        | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/list/details`   | `listFilesDetails()` | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/list/by-folder` | `listByFolderId()`   | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/list/by-path`   | `listByPath()`       | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/by-path`        | `getFileByPath()`    | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/find`           | `findFiles()`        | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/grep`           | `grepFiles()`        | **Remove or migrate** |
| PUT    | `/workbooks/:workbookId/files/write-by-path`  | `writeFileByPath()`  | **Remove or migrate** |
| PATCH  | `/workbooks/:workbookId/files/by-path`        | `updateFileByPath()` | **Remove or migrate** |
| DELETE | `/workbooks/:workbookId/files/by-path`        | `deleteFileByPath()` | **Remove or migrate** |
| POST   | `/workbooks/:workbookId/files`                | `createFile()`       | **Remove or migrate** |
| GET    | `/workbooks/:workbookId/files/:fileId`        | `getFile()`          | **Remove or migrate** |
| PATCH  | `/workbooks/:workbookId/files/:fileId`        | `updateFile()`       | **Remove or migrate** |
| DELETE | `/workbooks/:workbookId/files/:fileId`        | `deleteFile()`       | **Remove or migrate** |
| POST   | `/workbooks/:workbookId/files/:fileId/copy`   | `copyFile()`         | **Remove or migrate** |
| POST   | `/workbooks/:workbookId/files/publish`        | `publishFile()`      | **Remove or migrate** |

### FoldersController Endpoints

| Method | Route                                      | Service Method   | Action                |
| ------ | ------------------------------------------ | ---------------- | --------------------- |
| POST   | `/workbooks/:workbookId/folders`           | `createFolder()` | **Remove or migrate** |
| PATCH  | `/workbooks/:workbookId/folders/:folderId` | `updateFolder()` | **Remove or migrate** |
| DELETE | `/workbooks/:workbookId/folders/:folderId` | `deleteFolder()` | **Remove or migrate** |

### FilesPublicController Endpoints

| Method | Route                                   | Service Method                   | Action                |
| ------ | --------------------------------------- | -------------------------------- | --------------------- |
| GET    | `/workbook/public/:id/files/download`   | `downloadFileAsMarkdownPublic()` | **Remove or migrate** |
| GET    | `/workbook/public/:id/folders/download` | `downloadFolderAsZipPublic()`    | **Remove or migrate** |

---

## Client-Side Elements to Clean Up

### API Client (`client/src/lib/api/files.ts`)

The following API methods call WorkbookDb-backed endpoints:

```typescript
filesApi = {
  listFilesAndFolders()      // GET /files/list
  listFilesDetails()         // GET /files/list/details
  listFilesByFolder()        // GET /files/list/by-folder
  getFile()                  // GET /files/:fileId
  createFile()               // POST /files
  updateFile()               // PATCH /files/:fileId
  deleteFile()               // DELETE /files/:fileId
  copyFile()                 // POST /files/:fileId/copy
  publishFile()              // POST /files/publish
  getFileByPath()            // GET /files/by-path
  updateFileByPath()         // PATCH /files/by-path
  deleteFileByPath()         // DELETE /files/by-path
}

foldersApi = {
  createFolder()             // POST /folders
  updateFolder()             // PATCH /folders/:folderId
  renameFolder()             // PATCH /folders/:folderId
  deleteFolder()             // DELETE /folders/:folderId
  downloadFile()             // GET /workbook/public/.../files/download
  downloadFolder()           // GET /workbook/public/.../folders/download
}
```

### Shared Types (`packages/shared-types`)

| File                               | Types to Remove                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `dto/workbook/file-details.dto.ts` | `FileDetailsResponseDto`, `CreateFileDto`, `UpdateFileDto`, `CopyFileDto`    |
| `dto/workbook/list-files.dto.ts`   | `ListFileDto`, `ListFilesResponseDto`, `ListFilesDetailsResponseDto`         |
| `file-types.ts`                    | `FileDetailsEntity`, `FileOrFolderRefEntity`, `FileRefEntity` (verify usage) |
| `ids.ts`                           | `FileId`, `FolderId` (verify if used elsewhere)                              |

---

## Deprecation Phases

### Phase 1: Preparation

- [ ] Determine replacement storage architecture (Prisma? Cloud storage? Git-based?)
- [ ] Document data migration strategy for existing workbook schemas
- [ ] Create new file storage interface/abstraction
- [ ] Add deprecation warnings to WorkbookDb methods

### Phase 2: Build Replacement Layer

- [ ] Implement new file storage service
- [ ] Create adapter layer that implements the same interface
- [ ] Add feature flag to toggle between old and new implementations
- [ ] Write migration scripts for existing data

### Phase 3: Migrate Callers (In Dependency Order)

1. **Utility functions first**:
   - [ ] Migrate or remove `convertConnectorRecordToFrontMatter()`
   - [ ] Migrate or remove `convertFileToConnectorRecord()`

2. **Worker jobs**:
   - [ ] Update `PullFilesJobHandler`
   - [ ] Update `PullRecordFilesJobHandler`
   - [ ] Update `PullLinkedFolderFilesJobHandler`
   - [ ] Update `job-handler.service.ts`

3. **FilesService** (largest impact - 20+ method calls):
   - [ ] Migrate each method one at a time
   - [ ] Update corresponding controller endpoints
   - [ ] Update client API methods if signatures change

4. **Other services**:
   - [ ] Remove injection from `workbook.service.ts`
   - [ ] Remove injection from `folder.service.ts`
   - [ ] Update or remove `webflow-custom-actions.service.ts` (already deprecated)

### Phase 4: Remove Module Infrastructure

- [ ] Remove `WorkbookDbModule` from `workbook.module.ts`
- [ ] Remove `WorkbookDbModule` from `webflow-custom-actions.module.ts`
- [ ] Remove `WorkbookDbModule` from `workers.module.ts`

### Phase 5: Client Cleanup

- [ ] Update or remove methods in `client/src/lib/api/files.ts`
- [ ] Update any React hooks that use these API methods
- [ ] Update any components that depend on file operations

### Phase 6: Shared Types Cleanup

- [ ] Remove unused DTOs from `packages/shared-types`
- [ ] Update `index.ts` exports
- [ ] Verify no other packages depend on removed types

### Phase 7: Final Removal

- [ ] Delete `workbook-db.ts`
- [ ] Delete `workbook-db.service.ts`
- [ ] Delete `workbook-db.module.ts`
- [ ] Remove any remaining imports/references
- [ ] Drop workbook schemas from PostgreSQL (migration script)

---

## Risk Assessment

| Risk                                 | Severity | Mitigation                                              |
| ------------------------------------ | -------- | ------------------------------------------------------- |
| Data loss during migration           | High     | Full backups, staged rollout, rollback capability       |
| Breaking production file operations  | High     | Feature flags, A/B testing, comprehensive test coverage |
| Client breaking changes              | Medium   | Version API endpoints, coordinate client updates        |
| Performance regression               | Medium   | Benchmark new implementation, monitor in staging        |
| Incomplete cleanup leaving dead code | Low      | Thorough grep/search after removal, CI checks           |

---

## Testing Requirements

- [ ] Unit tests for new storage implementation
- [ ] Integration tests for all migrated endpoints
- [ ] E2E tests for file operations in the client
- [ ] Load testing for new storage layer
- [ ] Migration script testing with production-like data

---

## Open Questions

1. **What is the replacement storage architecture?**
   - Options: Prisma tables, cloud storage (GCS), git-based storage, hybrid approach

2. **Should we maintain the per-workbook schema isolation or consolidate?**
   - Current: Each workbook has its own PostgreSQL schema
   - Consider: Single table with workbook_id foreign key

3. **How do we handle in-flight operations during migration?**
   - Need strategy for zero-downtime migration

4. **Which endpoints are actively used vs. legacy?**
   - Analytics review needed before removing endpoints

5. **Timeline for deprecation?**
   - Depends on replacement architecture decision

---

## References

- [workbook-db.ts](../server/src/workbook/workbook-db.ts) - Main implementation
- [files.service.ts](../server/src/workbook/files.service.ts) - Primary consumer
- [files.controller.ts](../server/src/workbook/files.controller.ts) - REST endpoints
- [client/src/lib/api/files.ts](../client/src/lib/api/files.ts) - Client API
