# Postmortem: EU Production 5xx Errors — Missing connectorAccountId

**Date:** 2026-03-06
**Duration:** ~10+ minutes (10:34 - 10:41+ UTC, recurring)
**Severity:** High (PagerDuty alert triggered)
**Environment:** spv1eu-production (europe-west1)
**Service:** api-service (Cloud Run revision api-service-00051-9d6)

## Summary

A single V2 workbook (`wkb_G8AERKlL2J`) had DataFolders with null `connectorAccountId` values. When a user browsed folders in the UI, every file listing request threw an unhandled error, returning HTTP 500. The volume of 500s (~60-80 per alert window) exceeded the 5xx alerting threshold of 50, triggering two PagerDuty incidents within minutes.

## Timeline (UTC)

| Time  | Event                                                                     |
| ----- | ------------------------------------------------------------------------- |
| 10:34 | PagerDuty incident #2067 triggered — 81 5xx errors exceed threshold of 50 |
| 10:39 | Incident #2067 auto-resolves (brief dip in request volume)                |
| 10:41 | PagerDuty incident #2068 triggered — 58 5xx errors, same root cause       |
| 10:41 | Incident #2068 acknowledged                                               |

## Root Cause

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

- **Scope:** Single user, single workbook — not a systemic outage
- **User experience:** User was unable to browse any folders in workbook `wkb_G8AERKlL2J`
- **Alerting noise:** Two PagerDuty pages within 7 minutes due to error volume from repeated requests

## Resolution

TBD — Requires either:

1. **Data fix:** Set the `connectorAccountId` on the affected DataFolders in the EU production database
2. **Code fix:** Handle the missing `connectorAccountId` gracefully (return empty file list or 400 Bad Request instead of 500)

## Action Items

- [ ] Fix the immediate issue for workbook `wkb_G8AERKlL2J` (data fix or code fix)
- [ ] Change `resolveRepoId` to throw an `HttpException` (e.g., 400 or 404) instead of a generic `Error` so missing data doesn't surface as 500
- [ ] Investigate how this workbook ended up with null `connectorAccountId` on its DataFolders — is this a migration gap, a race condition during workbook setup, or manual data manipulation?
- [ ] Consider adding a database constraint or validation to prevent DataFolders from being created without `connectorAccountId` on V2 workbooks
- [x] Create a `read_only_user` on production databases so we can safely run diagnostic queries during incidents

## Lessons Learned

- A single user hitting a data integrity issue can generate enough 500s to trigger production alerts, making it appear more severe than it is
- Errors from data validation should be thrown as appropriate HTTP exceptions (4xx), not generic errors that become 500s
- V2 workbook data integrity assumptions (e.g., connectorAccountId always present) should be enforced at the database or service layer, not assumed at call sites
