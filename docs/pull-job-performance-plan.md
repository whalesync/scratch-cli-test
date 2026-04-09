# Pull Job Performance Plan

**File:** `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`

**Goal:** Make pull jobs significantly faster, especially for connectors like Stripe with many records.

**Status:** Analysis phase — instrumenting V1 to measure bottlenecks before building V2.

---

## Current Architecture (V1)

The pull job processes folders sequentially. For each folder, the connector yields batches of records (e.g. Stripe yields 100 per API page). Each batch triggers a fully sequential `onBatch` pipeline:

```
Connector yields batch (e.g. 100 records)
  → getFilenamesByRecordIds     (DB: look up existing filenames)
  → buildGitFilesFromConnectorFiles  (CPU: serialize records to JSON files)
  → commitBatch                 (HTTP: write files to scratch-git-2)
  → updateFileIndex             (DB: upsert file index entries)
  → updateFileReferences        (DB: update cross-file references)
  → updateAssetIndex            (DB: extract + upsert asset entries)
  → checkpoint                  (DB: save job progress for resume)
  → WebSocket event             (emit progress to UI)
```

**Nothing overlaps.** While processing a batch, the connector is idle. While the connector fetches the next page, the processing pipeline is idle.

### Stripe-specific context

- Stripe list API caps at 100 records per request (hard limit)
- `pullRecordFiles` uses cursor-based pagination via async generator — one HTTP call per page
- `pullRecordFilesByIds` makes one sequential HTTP call per record ID (N+1 pattern)
- Rate limiter infrastructure exists but is not integrated with Stripe connector
- No retry on 429 errors

---

## Instrumented Metrics (V1 — to be measured)

Timing instrumentation has been added to the V1 `onBatch` callback. Run a Stripe pull locally and check server logs for entries with `source: 'PullLinkedFolderFilesJob'` and `message: 'Batch timing'`.

Fields logged per batch:

| Field                    | What it measures                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `connectorFetchMs`       | Time between end of last batch and start of this batch's processing (approximates connector fetch time) |
| `filenamesByRecordIdsMs` | `getFilenamesByRecordIds` DB query                                                                      |
| `buildFilesMs`           | `buildGitFilesFromConnectorFiles` CPU work                                                              |
| `commitMs`               | `commitBatch` HTTP call to scratch-git-2                                                                |
| `fileIndexMs`            | `updateFileIndex` DB upsert                                                                             |
| `fileReferencesMs`       | `updateFileReferences` DB update                                                                        |
| `assetIndexMs`           | `updateAssetIndex` extract + DB upsert                                                                  |
| `checkpointMs`           | `checkpoint` DB write                                                                                   |
| `totalBatchMs`           | Total wall time for onBatch                                                                             |

### Profiling Results (local, 2026-04-09)

**Setup:** Stripe pull, 7 entity types, running locally (scratch-git-2 on localhost).

**Per-batch averages (20 batches, 100 records each):**

| Step | Avg | % of batch | % of wall |
|------|-----|------------|-----------|
| Connector fetch (Stripe API) | 5,102ms | — | **95.7%** |
| commitBatch (scratch-git-2) | 123ms | 54% of processing | 2.3% |
| fileIndex (DB upsert) | 60ms | 26% | 1.1% |
| fileReferences (DB update) | 29ms | 13% | 0.5% |
| filenamesByRecordIds (DB query) | 11ms | 5% | 0.2% |
| checkpoint (DB write) | 3ms | 1% | <0.1% |
| buildFiles (CPU) | 2ms | 1% | <0.1% |
| assetIndex (DB upsert) | 0ms | 0% | <0.1% |
| **Total processing per batch** | **227ms** | **100%** | **4.3%** |

**Total wall time: 106.6s** — 102s fetching from Stripe, 4.5s processing.

**Raw Stripe API benchmarks (curl, no connector overhead):**

| Entity | Time (100 records) | Payload |
|--------|-------------------|---------|
| customers | 1,403ms | 92 KB |
| products | 673ms | 66 KB |
| prices | 431ms | 74 KB |
| subscriptions | 1,850ms | 553 KB |
| invoices | **5,395ms** | 928 KB |
| payment_intents | **3,693ms** | 203 KB |
| charges | **4,838ms** | 345 KB |

Charges pagination (3 sequential pages): 5.4s, 5.5s, 6.0s per page. Consistent with the pull job measurements — the Stripe API is the bottleneck, not our code.

**Caveat:** Local profiling runs scratch-git-2 on `localhost` (loopback — essentially zero network latency). In production, Cloud Run → GCE goes through the VPC + internal load balancer, so `commitMs` will be higher. But even if it doubles, processing is still <10% of wall time. The connector fetch dominates regardless of environment.

---

## Key Finding

**96% of pull time is spent waiting on the Stripe API.** Processing (git commits, DB index updates) is only 4%. This means:

- Optimizations to the processing pipeline (batch accumulation, parallel index updates) yield marginal gains
- **The highest-leverage optimization is parallelizing connector API calls across folders**
- Stripe allows 100 ops/sec in live mode (25 in test mode) — we're using ~0.2 ops/sec

---

## Identified Bottlenecks

### 1. Sequential folder processing (all connectors) — **PRIMARY**

Folders are pulled one at a time. For Stripe with 7 entity types, the total pull time is the *sum* of all entity pull times. If we pulled them in parallel, it would be the *max* of the slowest entity type × its page count.

**Example:** A Stripe account with moderate data might take:
- Sequential (V1): customers(3s) + products(2s) + prices(1s) + subscriptions(10s) + invoices(30s) + payment_intents(20s) + charges(50s) = **116s**
- Parallel (V2): max(charges) = **50s** (2.3x faster)

### 2. No fetch/process overlap (all connectors)

While `onBatch` processes batch N, the connector is idle — not fetching batch N+1. Processing at 227ms/batch is small but still adds ~4.5s over a full pull.

### 3. Sequential batch processing within a folder (all connectors)

Each batch runs the full pipeline sequentially. Less impactful than #1 given profiling results, but still relevant for connectors with faster APIs where processing becomes a larger share.

### 4. Sequential index updates (all connectors)

`updateFileIndex`, `updateFileReferences`, and `updateAssetIndex` run sequentially but have no data dependency on each other.

### 5. No rate limiter integration (Stripe)

Stripe connector doesn't use the existing rate limiter. A 429 error fails the job with no retry.

### 6. Sequential by-ID fetches (Stripe)

`pullRecordFilesByIds` makes one HTTP request per record ID. Could do 10-20 concurrent requests within Stripe's 90 req/sec limit. (Less relevant for full pulls, which use the list endpoint.)

---

## V2 Design: `PullLinkedFolderFilesV2`

New file: `server/src/worker/jobs/job-definitions/pull-linked-folder-files-v2.job.ts`

V1 remains untouched and functional. V2 can be rolled out per-connector or behind a feature flag.

### Core Design: Connector-declared parallelism

### Two-phase architecture

The key insight: all folders in a connection share one git repo, and git commits are inherently serial — you can't have two concurrent commits to the same branch. So we can't just parallelize the existing V1 `onBatch` loop across folders. Instead, V2 separates API fetching from processing into two clean phases.

```
Phase 1 — FETCH (parallel, pure I/O)
┌─────────────────────────────────────────────────────────┐
│  [Stripe: customers]  → staging/Customers/*.json        │
│  [Stripe: products]   → staging/Products/*.json         │
│  [Stripe: prices]     → staging/Prices/*.json           │
│  [Stripe: charges]    → staging/Charges/*.json          │  all in parallel
│  [Stripe: invoices]   → staging/Invoices/*.json         │
│  [Stripe: pay_intents]→ staging/Payment Intents/*.json  │
│  [Stripe: subscriptions]→ staging/Subscriptions/*.json  │
└─────────────────────────────────────────────────────────┘
        Only: fetch from API → save to staging → checkpoint cursor
        Time: max(slowest folder) ≈ 50s for Stripe

Phase 2 — PROCESS (sequential, one folder at a time)
┌─────────────────────────────────────────────────────────┐
│  For each folder:                                       │
│    Read staged files back (batched, from scratch-git-2) │
│    → updateFileIndex (DB)                               │
│    → updateFileReferences (DB)                          │
│    → updateAssetIndex (DB)                              │
│    → Commit to git (scratch-git-2, local disk)          │
│    → Delete stale files                                 │
│  Then: rebase, GC, build index, cleanup staging         │
└─────────────────────────────────────────────────────────┘
        Time: ~10-20s (disk reads + DB + git, no API waits)
```

**Phase 1** is pure API I/O — no git, no DB indexes, no business logic. Each folder fetches from the connector in parallel and writes raw JSON files to scratch-git-2's staging area. Records are discarded from worker memory immediately after staging. The only constraint is the connector's API rate limit.

**Phase 2** reads staged files back from scratch-git-2 one batch at a time, runs all DB index updates, then commits to git. Memory stays flat — each batch is loaded, processed, and discarded. Reading files from scratch-git-2's local SSD over HTTP is fast (~ms per batch vs. ~5s per batch from Stripe).

**Why two phases?**
- **Clean separation of concerns** — Phase 1 only cares about getting data. Phase 2 only cares about processing it.
- Git commits are serial per repo — can't parallelize them across folders anyway
- Completely decouples the slow part (API) from the fast part (disk + DB + git)
- The staged files on disk are the durable artifact — no data loss on crash
- Worker memory stays flat in both phases — no need to hold 100K+ records in memory

### Connector-declared concurrency

Connectors declare their parallelism capabilities. The job orchestrator uses this to schedule Phase 1.

```typescript
// Connector registry — existing rateLimiterSpec + new pullConcurrency
connectorRegistry.register({
  service: Service.STRIPE,
  rateLimiterSpec: { points: 90, duration: 1 },       // existing
  pullConcurrency: {
    maxParallelFolders: 7,     // pull all entity types at once
  },
});

connectorRegistry.register({
  service: Service.AIRTABLE,
  rateLimiterSpec: { points: 5, duration: 1 },
  pullConcurrency: {
    maxParallelFolders: 3,     // conservative — tighter rate limits
  },
});

// Default for any connector that doesn't declare pullConcurrency:
// maxParallelFolders: 1 (same as V1)
```

**Why this is good:**
- Safe by default — unknown connectors fall back to sequential behavior
- The existing rate limiter (per connector account) throttles across all parallel streams
- Easy to tune per-connector based on observed API behavior
- Connectors don't need to change their `pullRecordFiles` implementation

**Expected speedup (Stripe, 7 entity types):**

```
V1 (sequential):
  [customers 3s] → [products 2s] → [prices 1s] → [subs 10s] → [invoices 30s] → ... = ~116s

V2 (parallel fetch, then commit):
  Phase 1: max(charges) ≈ 50s
  Phase 2: commit + index ≈ 10s
  Total: ~60s (1.9x faster)
```

**Stripe API limits (verified 2026-04-09):**
- Live mode: 100 ops/sec (25 in test/sandbox)
- No published concurrent request cap for list/read endpoints
- Read API calls must average ≤ 500 per transaction over 30 days (generous for pull jobs)
- Stripe recommends Data Pipeline for bulk exports

### Resume support in the two-phase model

Each folder checkpoints its connector cursor independently during Phase 1. The staged files on disk are the durable artifact.

```typescript
// Phase 1 checkpoint (saved to jobProgress)
{
  folderProgress: {
    "dfd_customers":  { startingAfter: "cus_abc", status: "fetching", fileCount: 200 },
    "dfd_charges":    { startingAfter: "ch_xyz",  status: "fetching", fileCount: 1500 },
    "dfd_invoices":   { startingAfter: null,       status: "pending" },
    "dfd_products":   { startingAfter: null,       status: "completed", fileCount: 50 },
  }
}
```

On resume after crash:
- **completed** folders: skip entirely (staged files already written)
- **fetching** folders: resume from cursor, keep appending to staging directory
- **pending** folders: start from the beginning
- If crash happens during Phase 2: staged files still intact, just re-run Phase 2

This is actually **better resume than V1** — in V1, a crash mid-batch loses everything in the current batch. Here, every file written to staging is durable the moment it hits disk.

### Staging storage options

The Cloud Run worker has no persistent disk, so staged files need to go somewhere durable.

| Option | Pros | Cons |
|--------|------|------|
| **scratch-git-2 staging API** | Same disk as git repos, low latency, simple new endpoint (`POST /staging/{jobId}/files`) | Adds load to scratch-git instance, need cleanup logic |
| **GCS bucket** | Cheap, durable, no size limits, natural for Cloud Run | Network hop for every write, higher latency than local disk |
| **Co-locate worker on GCE** | Direct disk access, eliminates all network hops for both staging and git | Infra change, loses Cloud Run scaling |
| **In-memory buffers** | Zero I/O, fastest possible | Lost on crash (no resume), memory-limited (512MB on Cloud Run) |

**Recommendation:** Start with **scratch-git-2 staging API** — it keeps the architecture simple (staging and git on the same disk), and scratch-git-2 already handles file writes.

### scratch-git-2 staging API design

New endpoints on scratch-git-2, storing files under `/data/staging/{jobId}/`:

```
# Phase 1: Worker streams files to staging
POST /api/staging/{jobId}/files
  Body: { folder: "Charges", files: [{ name: "ch_abc.json", content: {...} }, ...] }
  → Writes to /data/staging/{jobId}/Charges/ch_abc.json

# Phase 2: Worker reads staged files back in batches for indexing
GET /api/staging/{jobId}/files?folder=Charges&offset=0&limit=100
  → Returns: { files: [{ name: "ch_abc.json", content: {...} }, ...], total: 5000 }

# Phase 2: Commit all staged files for a folder to git
POST /api/staging/{jobId}/commit
  Body: { repoId: "org_xxx/wkb_xxx/coa_xxx", folder: "Charges" }
  → Reads staged files from disk, commits to git repo
  → Returns: { created: [...], updated: [...] }

# Cleanup (after success or on cancel/failure)
DELETE /api/staging/{jobId}
  → Removes staging directory
```

**Key design points:**
- The staging write (`POST /files`) is cheap — just disk writes, no git overhead
- The staging read (`GET /files`) is fast — SSD reads, ~ms per batch vs ~5s from Stripe
- The commit (`POST /commit`) reads from local disk — no data transfer from Cloud Run
- All three operations on the same disk — staging dir and git repo are co-located

**Phase 2 flow in NestJS (per folder):**

```typescript
// Read staged files in batches — memory stays flat
let offset = 0;
while (true) {
  const batch = await this.scratchGitService.getStagedFiles(jobId, folder, offset, 100);
  if (batch.files.length === 0) break;

  // DB index updates — we have the content in hand
  const builtFiles = buildGitFilesFromStagedFiles(batch.files, tableSpec);
  await Promise.all([
    this.updateFileIndex(folderCtx, builtFiles),
    this.updateFileReferences(folderCtx, builtFiles),
    this.updateAssetIndex(folderCtx, builtFiles),
  ]);

  offset += batch.files.length;
}

// Git commit — scratch-git-2 reads from its own disk
await this.scratchGitService.commitStagedFiles(jobId, repoId, folder);
```

If performance testing shows the HTTP overhead of writing to scratch-git-2 is significant, **co-locating the worker** becomes the natural next step — it eliminates the network hop entirely.

### Additional improvements (include in V2)

**Parallel index updates within Phase 2:**

`updateFileIndex`, `updateFileReferences`, and `updateAssetIndex` run as `Promise.all()` instead of sequentially. These write to different tables with no data dependency. Saves ~60ms/batch.

**Skip unchanged records (future):**

Track a per-record `updatedAt` or hash. On subsequent pulls, skip records that haven't changed since the last pull. Stripe objects have an `updated` timestamp field. Makes re-pulls dramatically faster. Could be added to Phase 1 by comparing staged files against the file index before writing.

---

## Recommended Priority (updated after profiling)

1. **Instrument V1** (done) — profiling reveals 96% of time is connector API calls
2. **Two-phase architecture with parallel folder fetch** — highest impact by far (~2x speedup for Stripe). Core V2 design.
3. **Parallel index updates in Phase 2** — low risk, easy win. Include in V2 for free.
4. **Skip unchanged records** — best ROI for repeated pulls. Layer on top of V2.
5. **Staging storage: scratch-git-2 API first, co-locate worker later** — pragmatic path

---

## Production Deployment Topology

Understanding the infrastructure is critical — the current architecture has a fundamental network bottleneck.

```
Cloud Run (worker-service)  ──HTTP over VPC──>  GCE Instance (scratch-git-2)
   No persistent disk                             Persistent SSD (/data/repos)
   512MB RAM, 1 CPU                               e2-medium, Nginx + blue/green Docker
   Serverless (scales to 0)                        Always-on, single instance
```

**Every git operation in the pull job is an HTTP round-trip across the VPC.** `commitBatch` sends the full serialized file content over HTTP to scratch-git-2 for every batch. For a 100-record Stripe batch, that's ~200KB of JSON sent over the network, committed to git, and a response sent back — per batch.

### Key infrastructure details

- scratch-git-2 runs on a single GCE instance (`europe-west1-b`) with a 50GB persistent SSD
- Git repos live at `/mnt/disks/data/repos` on that disk
- Cloud Run worker has no disk access — it can only talk to scratch-git-2 over HTTP
- The worker is constrained to 512MB RAM and 1 CPU
- Terraform: `terraform/modules/scratch_git_gce/` (GCE), `terraform/modules/env/services.tf` (Cloud Run)

---

## Radical Approaches (thinking outside the box)

The goal is to figure out how we could download and save data from Stripe (and other connectors) as fast as humanly possible. The two-phase design above addresses the biggest bottleneck we've found so far, but we should keep questioning every assumption.

### What's the theoretical minimum?

Stripe returns 100 charges in ~5s. For 5,000 charges that's 50 pages. With 7 entity types in parallel, total time ≈ max(slowest entity's pages × ~5s) + Phase 2 overhead. For a moderate Stripe account: ~50-60s. Can we do better?

### Bypass the Stripe list API entirely

- **Stripe Data Pipeline / Sigma** — Stripe explicitly recommends these for bulk exports. Could bypass the list API entirely for initial pulls. Worth investigating whether it supports the entity types we need and what the latency looks like.
- **Stripe Events API** — for subsequent pulls, could we listen to webhook events and only pull records that actually changed, instead of re-paginating the entire dataset?

### Eliminate the Node.js middleman

- **Build pull directly into scratch-git-2 (Rust)** — the Rust service already has direct disk access and git libraries. A pull endpoint that accepts connector credentials and streams data directly into the repo would eliminate HTTP serialization, JSON parsing overhead, and the Cloud Run memory constraint entirely. The NestJS worker would just enqueue the job and poll for status.
- **WASM connector plugins** — connectors compiled to WASM, running inside scratch-git-2. Zero network hop, zero serialization. Extreme but interesting.

### Co-locate the pull worker with scratch-git-2

If the scratch-git-2 staging API adds too much HTTP overhead, running the worker on the same box eliminates all network hops.

**Options:**

1. **Docker container on the scratch-git GCE instance** — simplest. Worker mounts the same `/data` volume. Talks to scratch-git-2 via `localhost:3100` (no VPC hop) or writes directly to disk.
2. **Separate GCE instance with shared storage** — better isolation, but GCP persistent disks can only attach to one instance in read-write mode. Could use Filestore (NFS) but adds complexity.
3. **Run on the same instance, write directly to disk** — skip scratch-git-2 entirely for staging writes. Phase 2 calls scratch-git-2 to commit the staged files to git.

### Rethink what "pull" means

- **Do we even need all the data upfront?** Could we pull lazily — fetch records on demand when the user opens a folder, and backfill the rest in the background?
- **Could we show partial results immediately?** Start showing records in the UI as soon as the first batch arrives, while the rest continues pulling.
- **Could we pull only metadata first** (IDs + titles) and defer full record content until the user opens a file? Metadata-only pulls would be dramatically smaller and faster.

### Reduce what Stripe sends us

- **Field selection** — Stripe may support requesting fewer fields. Charges at 345KB/100 records include a lot of nested payment method details we might not need.
- **Smaller page sizes with more parallelism** — if Stripe's response time scales sub-linearly with `limit`, smaller pages (e.g. 25) with 4x concurrent requests could be faster than sequential 100-record pages. (Needs testing.)

### Other ideas

- **Stream directly from connector into git** without materializing full batches in Node.js memory
- **Persistent connection pooling** to Stripe — reuse HTTP connections across pages to eliminate TLS handshake overhead
- **Geographic optimization** — if our Cloud Run / GCE is in `europe-west1` but Stripe's API servers are in the US, every request has transatlantic latency. Could we run pull workers closer to Stripe?

This section is intentionally open-ended and aspirational. Not all of these will be practical, but the goal is to find the approach that gets us closest to the theoretical minimum, not just shave 20% off the current pipeline.

---

## Open Questions

- Should V2 be gated behind a feature flag, or switched per-connector?
- How much memory headroom do we have in the worker process? (Currently 512MB on Cloud Run.)
- For skip-unchanged: does the file index already store enough to detect changes, or do we need a new column?
- What does Stripe's Data Pipeline / Sigma offer for bulk export? Could we skip the list API entirely for initial pulls?
- What's the right scratch-git-2 staging API design? Simple file write + list + cleanup, or something more structured?
- How large can the staging area get? Need to size the disk or set per-job limits.
- Should Phase 2 do one big git commit or chunk into smaller commits? One big commit is faster but creates a large single diff in history.
