# Connector Pagination Resume Plan

## Context

Pull jobs can stall when BullMQ's lock expires during long-running operations. When a stalled job restarts, every connector re-fetches all records from page 1 because no pagination state is persisted. This wastes API quota, re-commits duplicate data, and causes jobs to get stuck in stall loops on large datasets (e.g., 6,100 Stripe Payment Intents).

The resume infrastructure already works — `checkpoint()` persists `connectorProgress` to Redis, and BullMQ restores it on restart. The gap is that connectors don't read or write cursor state.

**Additional finding:** Line 489 of `pull-linked-folder-files.job.ts` passes the **full** `Progress` object to connectors instead of just `progress.connectorProgress`. This means even connectors that already implement resume (Notion, HubSpot, WordPress, QuickBooks) don't actually resume — they read `progress?.nextCursor` from the full Progress object and get `undefined`.

## Part 0: Fix Job-Level Plumbing

### 0a. Pass `connectorProgress` (not full Progress) to connectors

**File:** `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`

Line 489 currently passes `progress` (the full Progress object). Change to `progress.connectorProgress`. This immediately fixes Notion, HubSpot, WordPress, and QuickBooks resume support.

### 0b. Track completed folders in `jobProgress`

Currently the job iterates all `dataFolderIds` on every run. Add a `completedFolderIds` array to `jobProgress` so restarted jobs skip folders that already finished.

- Define type: `{ completedFolderIds?: string[] }`
- Update `PullLinkedFolderFilesJobDefinition` to use this type instead of `Record<string, never>`
- In the folder loop (line 124), skip folders in `progress.jobProgress.completedFolderIds`
- After each folder completes successfully, add its ID to `completedFolderIds` and include in subsequent checkpoints

### 0c. Fix deletion tracking on resumed runs

The `gitFiles` accumulator (line 318) tracks all files committed during the current run. The deletion logic (line 496) uses this to detect removed records. On a resumed run, `gitFiles` only contains files from the resumed portion, which would incorrectly delete files committed before the stall.

**Fix:** When resuming (i.e., `connectorProgress` is non-empty), skip the deletion step for that folder. Deletion will happen on the next full (non-resumed) pull. This is safe because deletion is a cleanup operation, not a correctness requirement.

### 0d. Restore `publicProgress` on resume

Currently `pullFolder` creates a fresh `publicProgress` at line 233. On resume, it should restore from `progress.publicProgress` if resuming the same folder (matching `folderId`), so file counts and paths aren't reset.

## Part 1: Offset-Based Connectors (easy)

These already track offset locally. Just read from `progress` and write to `connectorProgress`.

### Pattern

```typescript
// Before (ignores progress)
let offset = 0;

// After (resumes from checkpoint)
let offset = (progress as { nextOffset?: number })?.nextOffset ?? 0;
// ... in callback:
await callback({ files, connectorProgress: { nextOffset: offset } });
```

### Connectors

| Connector  | File                                     | Cursor                |
| ---------- | ---------------------------------------- | --------------------- |
| Webflow    | `library/webflow/webflow-connector.ts`   | `nextOffset` (number) |
| Supabase   | `library/supabase/supabase-connector.ts` | `nextOffset` (number) |
| PostgreSQL | `library/postgres/postgres-connector.ts` | `nextOffset` (number) |

## Part 2: Async Generator Connectors

These use `for await (const batch of client.listXxx())` where the cursor lives inside the generator.

### Two changes per connector

**A) API client:** Add optional starting cursor parameter to the generator method.

```typescript
// Before
async *listEntities(entityType: string): AsyncGenerator<T[]> {
  let cursor: string | undefined;
  // ...
}

// After
async *listEntities(entityType: string, limit = 100, startingAfter?: string): AsyncGenerator<T[]> {
  let cursor = startingAfter;
  // ...
}
```

**B) Connector:** Read cursor from `progress`, pass to generator, extract cursor from each batch for `connectorProgress`.

For cursors derivable from data (e.g., Stripe's `starting_after` = last item ID):

```typescript
const resumeCursor = progress?.startingAfter;
for await (const entities of this.client.listEntities(
  entityType,
  100,
  resumeCursor,
)) {
  const lastId = (entities[entities.length - 1] as Record<string, unknown>)
    ?.id as string;
  await callback({
    files: entities as unknown as ConnectorFile[],
    connectorProgress: lastId ? { startingAfter: lastId } : {},
  });
}
```

For opaque cursors not in the data (e.g., Airtable's offset, Linear's endCursor), the generator must yield cursor metadata. Change yield type to include cursor:

```typescript
// API client yields { items, nextCursor }
async *listRecords(..., resumeOffset?: string): AsyncGenerator<{ records: T[], nextOffset?: string }> {
  let offset = resumeOffset;
  do {
    const r = await this.request({ params: { offset } });
    yield { records: r.data.records, nextOffset: r.data.offset };
    offset = r.data.offset;
  } while (offset);
}
```

### Connector Details

| Connector   | File (client)                           | File (connector)                       | Pagination                 | Cursor field              | Derivable from data?    |
| ----------- | --------------------------------------- | -------------------------------------- | -------------------------- | ------------------------- | ----------------------- |
| Stripe      | `stripe/stripe-api-client.ts`           | `stripe/stripe-connector.ts`           | `starting_after` (last ID) | `startingAfter`           | Yes (last item ID)      |
| Airtable    | `airtable/airtable-api-client.ts`       | `airtable/airtable-connector.ts`       | Opaque offset string       | `airtableOffset`          | No (yield tuple)        |
| Linear      | `linear/linear-api-client.ts`           | `linear/linear-connector.ts`           | GraphQL `after` cursor     | `endCursor`               | No (yield tuple)        |
| Shopify     | `shopify/shopify-api-client.ts`         | `shopify/shopify-connector.ts`         | GraphQL `after` cursor     | `endCursor`               | No (yield tuple)        |
| Intercom    | `intercom/intercom-api-client.ts`       | `intercom/intercom-connector.ts`       | Page number + cursor       | `page` or `startingAfter` | Yes (page number)       |
| Pipedrive   | `pipedrive/pipedrive-api-client.ts`     | `pipedrive/pipedrive-connector.ts`     | Opaque cursor              | `nextCursor`              | No (yield tuple)        |
| Memberstack | `memberstack/memberstack-api-client.ts` | `memberstack/memberstack-connector.ts` | `after` cursor             | `endCursor`               | No (yield tuple)        |
| Brevo       | `brevo/brevo-api-client.ts`             | `brevo/brevo-connector.ts`             | Offset (number)            | `nextOffset`              | Yes (offset arithmetic) |
| Moco        | `moco/moco-api-client.ts`               | `moco/moco-connector.ts`               | Page number                | `nextPage`                | Yes (page number)       |
| Audienceful | `audienceful/audienceful-api-client.ts` | `audienceful/audienceful-connector.ts` | URL cursor                 | `nextUrl`                 | No (yield tuple)        |

### Shopify Special Case

Shopify has child entity pulling (`pullChildRecords`) that iterates parents then fetches children per parent. This requires compound progress: `{ parentCursor, childCursor, currentParentId }`. Consider deferring child entity resume to a follow-up if it proves too complex — parent entity resume alone is still valuable.

## No Changes Needed

- **Notion, HubSpot, WordPress, QuickBooks** — already resumable once Part 0a is fixed
- **YouTube, Wix Blog** — stubs returning empty results

## Implementation Order

1. **Part 0** — Job plumbing fixes (connectorProgress passthrough, folder tracking, deletion safety, publicProgress restore). This is the foundation.
2. **Part 1** — Offset-based connectors (Webflow, Supabase, PostgreSQL). Quick wins to validate the pattern.
3. **Part 2 - derivable cursors** — Stripe, Intercom, Brevo, Moco. Only need client param + connector changes.
4. **Part 2 - opaque cursors** — Airtable, Linear, Pipedrive, Memberstack, Audienceful. Need yield-tuple refactor.
5. **Part 2 - Shopify** — Most complex due to child entities. Do last.

## Testing

### Unit tests for job handler

- Extend `pull-linked-folder-files.job.spec.ts`
- Verify `connectorProgress` (not full Progress) is passed to connector
- Verify completed folders are skipped on resume
- Verify deletion is skipped when resuming mid-folder

### Unit tests per connector

- When `progress` is empty, pagination starts from beginning
- When `progress` has cursor, correct starting position is passed to API client
- Each callback includes correct `connectorProgress` for next page

### Key test files

- `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.spec.ts`
- `server/src/remote-service/connectors/library/stripe/__tests__/stripe-connector.spec.ts`
- Individual connector test files as they exist

## Verification

1. `yarn build` — ensure all type changes compile
2. `yarn test` — run existing + new unit tests
3. `yarn lint` and `cd server && yarn lint-strict` — lint check
4. Manual test: trigger a large Stripe pull, verify `connectorProgress` contains cursor state in Redis job data

## Smoke Test (done)

Smoke test added at `smoke-tests/pull/pull-stall-resume.spec.ts`. Verifies:

- 250 records pulled across 3 pages (pagination works end-to-end)
- `completedFolderIds` tracked in `jobProgress`

**Note:** Forcing a real BullMQ stall in a smoke test isn't feasible. Response delays are async I/O — they don't block the Node.js event loop, so BullMQ's automatic lock renewal keeps the lock alive. Real stalls only occur when the worker process dies (e.g., Cloud Run instance shutdown). The resume-from-cursor logic is covered by unit tests.

Response delay support was added to fake Airtable (`POST /test/set-response-delay`) for future use.

### Other follow-ups

- Shopify child entity resume (compound parent+child cursor)
- Shopify metaobject resume (compound definition+cursor pagination)
