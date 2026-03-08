# E2E Smoke Tests: Pull & Publish

## Goal

Full end-to-end smoke tests that exercise the entire pull and publish pipeline — from the NestJS API layer through connectors, git storage, and back — using fake connector APIs instead of real external services. Everything runs in Docker. The only thing not tested is the UI.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  docker-compose.smoke-test.yml                               │
│                                                              │
│  ┌──────────┐  ┌───────┐  ┌──────────────┐                  │
│  │ postgres │  │ redis │  │ scratch-git-2 │                  │
│  │  :5432   │  │ :6379 │  │ :3100 / :3101 │                  │
│  └──────────┘  └───────┘  │  /data/repos   │                  │
│                           └──────────────┘                  │
│  ┌────────────────┐  ┌─────────────────────┐                │
│  │ fake-airtable  │  │   NestJS server     │                │
│  │     :4646      │  │      :3010          │                │
│  └────────────────┘  │ API_URL_OVERRIDES=  │                │
│                      │  ...=fake-airtable  │                │
│                      └─────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
         ▲
         │ HTTP (Bearer JWT via Clerk)
    ┌────┴──────┐
    │ Jest tests │  (run on host or in a container)
    └───────────┘
```

### Services

| Service       | Image                                           | Ports      | Notes                                                   |
| ------------- | ----------------------------------------------- | ---------- | ------------------------------------------------------- |
| postgres      | `postgres:16`                                   | 5432       | Ephemeral test database                                 |
| redis         | `redis`                                         | 6379       | BullMQ job queue                                        |
| scratch-git-2 | Built from `scratch-git-2/Dockerfile`           | 3100, 3101 | Ephemeral `/data/repos` (no host volume)                |
| fake-airtable | Built from `test-api-fakes/airtable/Dockerfile` | 4646       | In-memory store, reset between tests                    |
| server        | Built from `server/Dockerfile` (or dev mode)    | 3010       | Runs with `API_URL_OVERRIDES` pointing Airtable to fake |

### Authentication

Tests authenticate using Clerk JWTs via the existing `getAuthToken()` helper in `server/test/integration/common.ts`. This requires:

- `CLERK_SECRET_KEY` — test environment Clerk secret
- `INTEGRATION_TEST_USER_ID` — Clerk user ID for the test user

The test user must already exist in the Clerk test environment.

### URL Rewriting

The server's `API_URL_OVERRIDES` env var rewrites connector API calls:

```
API_URL_OVERRIDES=https://api.airtable.com=http://fake-airtable:4646
```

The existing Axios interceptor (`server/src/remote-service/connectors/api-url-overrides.ts`) handles this transparently — no connector code changes needed.

## Connector Parameterization

Tests are written against a `ConnectorFixture` interface so they work with any connector fake. Start with Airtable; add more connectors later.

```typescript
interface ConnectorFixture {
  /** Service enum value (e.g. Service.AIRTABLE) */
  service: Service;

  /** Base URL for the fake's test-admin endpoints */
  fakeAdminUrl: string;

  /** Seed the fake with test data (base, tables, records) */
  seedData(adminUrl: string): Promise<SeedResult>;

  /** Return expected files after a pull */
  getExpectedFiles(seed: SeedResult): ExpectedFile[];

  /** Credentials to use when creating a ConnectorAccount */
  createConnectionCredentials(): Record<string, string>;

  /** Verify the fake's state after a publish */
  verifyPublishedState(
    adminUrl: string,
    expected: ExpectedState,
  ): Promise<void>;
}

interface SeedResult {
  /** IDs needed to link a DataFolder (e.g. baseId, tableId) */
  remoteIds: string[];
  /** Number of seeded records */
  recordCount: number;
  /** The seeded records for assertion */
  records: Array<{ id: string; fields: Record<string, unknown> }>;
}
```

Usage:

```typescript
const fixtures: ConnectorFixture[] = [airtableFixture /*, wordpressFixture */];

describe.each(fixtures)("E2E Smoke: $service", (fixture) => {
  // All tests are connector-agnostic
});
```

## Test Data Factory

Reduce boilerplate for creating the entity graph (org -> user -> workbook -> connector account -> data folder).

```typescript
// server/test/integration/helpers/test-fixtures.ts

interface TestWorkspace {
  workbookId: string;
  connectorAccountId: string;
  dataFolderId: string;
}

/** Create a fully-linked workspace ready for pull/publish testing */
async function createTestWorkspace(
  api: TestApiClient,
  opts: {
    service: Service;
    credentials: Record<string, string>;
    remoteIds: string[];
    tableName: string;
  },
): Promise<TestWorkspace>;

/** Reset fake connector state between tests */
async function resetFake(adminUrl: string): Promise<void>;
```

## Fake API Changes

### Add `GET /test/dump` endpoint

Returns all records currently in the fake's store, so tests can verify publish results without re-pulling.

```typescript
// GET /test/dump?baseId=...&tableId=...
// Response:
{
  "records": [
    { "id": "recXXX", "fields": { ... }, "createdTime": "..." },
    ...
  ]
}

// GET /test/dump (no params) — returns everything
{
  "bases": {
    "appXXX": {
      "tables": {
        "tblXXX": {
          "records": [...]
        }
      }
    }
  }
}
```

## Job Polling

Pull and publish operations are async (BullMQ jobs). Tests poll `GET /jobs/:jobId/progress` until the job reaches a terminal state.

```typescript
async function waitForJob(
  api: TestApiClient,
  jobId: string,
  timeoutMs = 30000,
): Promise<JobEntity> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await api.get(`/jobs/${jobId}/progress`);
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
    await sleep(500);
  }
  throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
}
```

## Test Cases

### 1. Pull records into git

```
Seed:    POST /test/setup — base with 1 table, 10 records
Action:  POST /data-folder/pull → poll job
Assert:  GET files from workbook API — 10 files, content matches seeded fields
```

### 2. Pull with pagination (250+ records)

```
Seed:    250 records (Airtable pages at 100)
Action:  Pull
Assert:  All 250 files present in git
```

### 3. Incremental pull (adds + removes)

```
Seed:    10 records → pull
Mutate:  Add 2 records, delete 3 via /test/setup
Action:  Pull again
Assert:  9 files in git (10 - 3 + 2), deletions reflected
```

### 4. Create, edit, and delete files

```
Setup:   Pull 5 records
Action:  Via workbook API:
         - Create 2 new files on dirty branch
         - Edit 1 existing file (change field values)
         - Delete 1 file
Assert:  Git status shows 2 creates, 1 update, 1 delete
```

### 5. Publish happy path

```
Setup:   Pull, then create/edit/delete files (test 4)
Action:  POST /publish-plan/plan-job → poll → verify plan operations
         POST /publish-plan/run-job → poll
Assert:  GET /test/dump — fake has correct final state
         - 2 new records created with assigned IDs
         - 1 record updated with new field values
         - 1 record deleted
```

### 6. Publish with circular foreign keys

```
Setup:   Pull records from a table with a linked-record field
Action:  Create 2 new files that reference each other:
         - File A links to File B (via @/ pseudo-ref)
         - File B links to File A (via @/ pseudo-ref)
Action:  Publish
Assert:  BACKFILL phase resolves both pseudo-refs
         GET /test/dump — both records have correct linked-record IDs
```

### 7. Publish with invalid field values

```
Setup:   Pull, then edit a file with invalid data (e.g. string in a number field)
Action:  Publish
Assert:  Publish plan runs, but the fake returns a 422 error
         Job progress shows the error with a user-friendly message
         Other valid operations in the same batch still succeed (or fail gracefully)
```

### 8. Rate limit recovery

```
Setup:   Seed records
Action:  POST /test/simulate-rate-limit { count: 2, retryAfter: 1 }
         Trigger pull
Assert:  Pull succeeds after retrying past the rate-limited requests
```

### 9. Publish idempotency

```
Setup:   Pull, edit files, publish successfully
Action:  Attempt to publish again (no new changes)
Assert:  Plan has 0 operations, or run completes as no-op
```

### 10. Large batch publish (25+ creates)

```
Setup:   Pull, then create 25 new files
Action:  Publish
Assert:  All 25 records created in fake (exercises batch-of-10 splitting)
         GET /test/dump — 25 new records with assigned IDs
```

## Implementation Order

### Phase 1: Infrastructure

1. **`docker-compose.smoke-test.yml`** — All 5 services (postgres, redis, scratch-git-2, fake-airtable, server)
2. **`GET /test/dump` endpoint** on fake Airtable
3. **Test helpers** — `TestApiClient`, `createTestWorkspace()`, `waitForJob()`, `resetFake()`
4. **`ConnectorFixture` interface** + Airtable implementation

### Phase 2: Pull tests

5. **Test 1**: Pull records into git (simplest happy path)
6. **Test 2**: Pull with pagination
7. **Test 3**: Incremental pull

### Phase 3: Edit + Publish tests

8. **Test 4**: Create, edit, delete files
9. **Test 5**: Publish happy path
10. **Test 6**: Circular foreign keys

### Phase 4: Error and edge cases

11. **Test 7**: Publish with invalid field values
12. **Test 8**: Rate limit recovery
13. **Test 9**: Publish idempotency
14. **Test 10**: Large batch publish

## File Structure

```
packages/test-utils/                    # Shared test utilities (Clerk auth)
├── package.json
├── tsconfig.json
├── index.ts
└── clerk-auth.ts                      # getAuthToken() — used by integration + smoke tests

smoke-tests/                           # E2E smoke tests (repo root, not inside server/)
├── package.json
├── jest.config.json                   # Jest config (120s timeout, single worker)
├── tsconfig.json
├── docker-compose.smoke-test.yml
├── helpers/
│   ├── test-api-client.ts             # HTTP client wrapper with auth
│   ├── test-fixtures.ts               # createTestWorkspace(), pullAndWait(), planPublish(), runPublish()
│   ├── wait-for-job.ts                # Job polling helper
│   └── connector-fixtures/
│       ├── types.ts                   # ConnectorFixture interface
│       └── airtable.fixture.ts        # Airtable-specific seed/verify logic
├── pull/
│   ├── pull-basic.spec.ts             # Tests 1-3 (basic, pagination, file content)
│   └── pull-incremental.spec.ts       # Test: re-pull after remote changes
└── publish/
    ├── publish-happy-path.spec.ts     # Tests: create + edit + delete → publish → verify
    ├── publish-references.spec.ts     # Test: circular FK resolution via BACKFILL
    ├── publish-errors.spec.ts         # Test: invalid field values → error surfaced
    ├── publish-rate-limit.spec.ts     # Test: pull succeeds after 429 retries
    └── publish-edge-cases.spec.ts     # Tests: 25+ batch creates, no-op publish
```

## Running

```bash
# Start all services
docker compose -f smoke-tests/docker-compose.smoke-test.yml up --build -d

# Wait for services to be healthy, then run smoke tests
cd smoke-tests && yarn test

# Tear down
docker compose -f smoke-tests/docker-compose.smoke-test.yml down -v
```
