# Postmortem: EU Production 5xx Errors — Missing connectorAccountId

**Date:** 2026-03-06
**Duration:** ~10+ minutes (10:34 - 10:41+ UTC, recurring)
**Severity:** High (PagerDuty alert triggered)
**Environment:** spv1eu-production (europe-west1)
**Service:** api-service (Cloud Run revision api-service-00051-9d6)

## Summary

A single V2 workbook (`wkb_G8AERKlL2J`) had DataFolders with null `connectorAccountId` values. When a user browsed folders in the UI, every file listing request threw an unhandled error, returning HTTP 500. The volume of 500s (~60-80 per alert window) exceeded the 5xx alerting threshold of 50, triggering two PagerDuty incidents within minutes.

## Timeline (UTC)

| Time  | Event                                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:34 | PagerDuty incident #2067 triggered — 81 5xx errors exceed threshold of 50                                                                                       |
| 10:39 | Incident #2067 auto-resolves (brief dip in request volume)                                                                                                      |
| 10:41 | PagerDuty incident #2068 triggered — 58 5xx errors, same root cause                                                                                             |
| 10:41 | Incident #2068 acknowledged                                                                                                                                     |
| 14:00 | Chris came online and started investigating                                                                                                                     |
| 14:10 | Root cause identified — orphaned DataFolders with null `connectorAccountId` from a bug fixed earlier in the week; manual cleanup required after code assessment |
| 14:58 | Completed cleanup of affected database records; confirmed Viktor's account no longer generating 500 errors                                                      |
| 15:05 | Completed cleanup of hello@freshstack.ai database records, which were also capable of triggering the alert                                                      |

## Root Cause

The root cause was a combination of two factors:

1. **Connector account deletion bug:** A bug in the connector account deletion flow orphaned DataFolders by removing the connector account without cleaning up its associated DataFolders. This left DataFolder records in the database with a null `connectorAccountId`. The bug was fixed earlier in the week, but workbook `wkb_G8AERKlL2J` still had orphaned DataFolders from before the fix.

2. **V2 workbook upgrade:** All workbooks were recently upgraded to the V2 format. V2 workbooks require every DataFolder to have a `connectorAccountId` to resolve the git repo path. The orphaned DataFolders were harmless under the V1 format but became a source of errors after the upgrade.

### Proximate Cause

The `FilesService.listByFolderId` method (`server/src/workbook/files.service.ts:117`) calls `ScratchGitService.resolveRepoId` with the DataFolder's `connectorAccountId`. For V2 workbooks, each DataFolder should have a `connectorAccountId` linking it to a connector account that holds the git repo path.

Workbook `wkb_G8AERKlL2J` had DataFolders where `connectorAccountId` was null. When passed to `resolveRepoId`, this caused an unhandled error:

```
Error: connectorAccountId required for V2 workbook wkb_G8AERKlL2J
    at ScratchGitService.resolveRepoId (scratch-git.service.js:45)
    at FilesService.listByFolderId (files.service.js:99)
    at FilesController.listFilesByFolder (files.controller.js:38)
```

The error was not caught or converted to a user-friendly response, so it propagated as a 500 Internal Server Error.

**Contributing factors:**

- The user repeatedly navigated between folders in the UI, each navigation triggering a new 500 error
- All errors came from a single IP address (`62.45.35.227`) hitting the same workbook
- The error was thrown as a generic `Error` rather than an `HttpException`, so NestJS returned 500 instead of a more appropriate status code

## Impact

- **Scope:** Two users and two workbooks affected — not a systemic outage
- **User experience:** Users were unable to browse folders containing orphaned DataFolders
  - Workbook `wkb_G8AERKlL2J` — triggered the PagerDuty alerts
  - Workbook `wkb_UBd9q7RiE9` (user `usr_L0qawgUcQe` / hello@freshstack.ai) — also had an orphaned DataFolder with null `connectorAccountId` that could trigger the same alert
- **Alerting noise:** Two PagerDuty pages within 7 minutes due to error volume from repeated requests

## Resolution

1. **Data fix:** Remove the affected DataFolders with the null `connectorAccountId` in the EU production database. They are all orphaned records ✅

2. **Code fix:** Handle the missing `connectorAccountId` gracefully (return empty file list or 400 Bad Request instead of 500) ✅

## Action Items

- [x] Fix the immediate issue for workbook `wkb_G8AERKlL2J` (data fix or code fix)
- [x] Change `resolveRepoId` to throw an `HttpException` (e.g., 400 or 404) instead of a generic `Error` so missing data doesn't surface as 500
- [x] Investigate how this workbook ended up with null `connectorAccountId` on its DataFolders — is this a migration gap, a race condition during workbook setup, or manual data manipulation?
- [-] Consider adding a database constraint or validation to prevent DataFolders from being created without `connectorAccountId` on V2 workbooks
  - (chris) - we are holding off on this for now as the null `connectorAccountId` is a placeholder for unlinked "scratch folders"
- [x] Create a `read_only_user` on production databases so we can safely run diagnostic queries during incidents

## Lessons Learned

- A single user hitting a data integrity issue can generate enough 500s to trigger production alerts, making it appear more severe than it is
- Errors from data validation should be thrown as appropriate HTTP exceptions (4xx), not generic errors that become 500s
- V2 workbook data integrity assumptions (e.g., connectorAccountId always present) should be enforced at the database or service layer, not assumed at call sites

## Notes: Side Effects of Deleting DataFolders with Null connectorAccountId

Before deleting the affected DataFolder records as a data fix, be aware of the following side effects.

### Automatic Cascades (via foreign keys)

| Table                     | Effect                                                       |
| ------------------------- | ------------------------------------------------------------ |
| **DataFolder** (children) | All child folders recursively deleted via `parentId` CASCADE |
| **SyncTablePair**         | Deleted if the folder is a source or destination             |
| **SyncForeignKeyRecord**  | Cached foreign key records deleted                           |
| **SyncRemoteIdMapping**   | Source-to-destination remote ID mappings deleted             |

### Requires Manual Cleanup (no FK cascade)

| Table                    | Risk                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| **Schedule**             | Orphaned PULL/PUBLISH schedules remain (polymorphic `entityId`, no FK) |
| **SyncMatchKeys**        | Potentially orphaned (cleaned up when parent Sync is deleted)          |
| **DbJob**                | Optional `dataFolderId` reference becomes dangling                     |
| **PublishPlanOperation** | `dataFolderId` reference becomes dangling                              |

### Non-Database Side Effects (if using the service method)

- Git files at `DataFolder.path` are deleted from the repo via `scratchGitService.removeDataFolder()`
- WebSocket `folder-deleted` event broadcast to connected clients
- Audit log and PostHog tracking events recorded

### Pre-Deletion Diagnostic Queries

Run these queries against the affected workbook before deleting to understand the blast radius:

```sql
-- Check for children with connector accounts
SELECT id, name, "connectorAccountId" FROM "DataFolder"
WHERE "parentId" IN (SELECT id FROM "DataFolder" WHERE "connectorAccountId" IS NULL);

-- Check for sync pairs
SELECT * FROM "SyncTablePair"
WHERE "sourceDataFolderId" IN (SELECT id FROM "DataFolder" WHERE "connectorAccountId" IS NULL)
   OR "destinationDataFolderId" IN (SELECT id FROM "DataFolder" WHERE "connectorAccountId" IS NULL);

-- Check for schedules
SELECT * FROM "Schedule"
WHERE "entityId" IN (SELECT id FROM "DataFolder" WHERE "connectorAccountId" IS NULL);
```

### Recommendation

Use the existing `DataFolderService.deleteFolder()` method (`server/src/workbook/data-folder.service.ts:404`) rather than raw SQL. It handles Schedule cleanup and git file deletion that a raw `DELETE` would skip. If a raw SQL delete is necessary, manually clean up Schedule records and git files for each affected folder beforehand.
