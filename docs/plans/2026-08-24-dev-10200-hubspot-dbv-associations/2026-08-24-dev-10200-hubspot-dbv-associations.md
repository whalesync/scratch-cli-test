# HubSpot: migrate association writes off v4 + batch publishing

- **Created:** 2026-08-24 · **Updated:** 2026-08-25 (MR 2 scope widened to full batch publishing)
- **Author:** Ivan Dimitrov
- **Status:** In Progress
- **Linear:** [DEV-10200](https://linear.app/whalesync/issue/DEV-10200) (parent, covers Scratch +
  Whalesync; the Whalesync half is [DEV-10432](https://linear.app/whalesync/issue/DEV-10432) with
  its own plan doc in the whalesync repo, `docs/plans/2026-08-24-hubspot-dbv-associations.md`)

## Summary

HubSpot deprecates its v4 APIs on **March 30, 2027**. The connector's only v4 usage is the two CRM
association write endpoints in `hubspot-api-client.ts` (`createAssociation`, `deleteAssociation`);
everything else is v3, which has no announced deadline. The replacement is the date-versioned API
(`2026-03` in the URL path), which is 1:1 for our calls:

| Today (v4) | 2026-03 |
|---|---|
| `PUT /crm/v4/objects/{from}/{id}/associations/default/{to}/{toId}` | `PUT /crm/objects/2026-03/{from}/{id}/associations/default/{to}/{toId}` |
| `DELETE /crm/v4/objects/{from}/{id}/associations/{to}/{toId}` | `DELETE /crm/objects/2026-03/{from}/{id}/associations/{to}/{toId}` |

The `default` (unlabeled) shortcut survives, and the unlabeled DELETE still removes all
association types between the two records — so the id-only diff in `syncAssociations` and its
mirror `associationSyncWouldCreateOrDelete` keep their correctness argument. The known label gap
(DEV-10902) ports over unchanged.

2026-03 also adds **batch** association endpoints
(`POST /crm/associations/2026-03/{from}/{to}/batch/associate/default`, ≤2,000 pairs, and
`.../batch/archive`, ≤100 unique `from` ids) that take pairs from *different* `from` records in one
call. MR 2 uses them — together with v3's `batch/create` / `batch/update` — to publish a HubSpot
folder **10 records per API call** instead of one: one batch record call, then one association
call per association type carrying every record's links.

## MR sequence

| # | Scope | Status |
|---|---|---|
| 1 | Wire `ctx.isFeatureEnabled` into the HubSpot connector; swap association writes to 2026-03 URLs behind `HUBSPOT_ASSOCIATIONS_API_2026_03`; add 2026-03 routes to the HubSpot fake | **Merged** (!3265 → master `701db7ef3`, on prod since 2026-08-25). Flag `HUBSPOT_ASSOCIATIONS_API_2026_03` still off in prod (0 %, inactive, never evaluated as of 2026-08-26) — v4 path unchanged for users. PostHog: prod 843307, test 843310. Live spec run 2026-08-25 (green). |
| 2 | **Batch publishing** behind `HUBSPOT_BATCH_PUBLISH`: `getBatchSize` 10 for create/update; `batch/create` + `batch/update` for records; 2026-03 `batch/associate/default` + `batch/archive` for links, one call per association type; a duplicate-safe partial-failure contract for creates; association failures surfaced instead of swallowed; quotes exempt | Built on branch `DEV-10200-hubspot-batch-publish` (off MR 1's branch). Unit + fake-backed + **live** specs green (QA portal Hub 343451052, 2026-08-25 — see Live contract findings; the live run showed batch/create results come back in arbitrary order, so records are bound to files by echoed properties, not position). PostHog flags created, off: test 844768, prod 844774. |
| 3 | Cleanup: bake both behaviors in, delete flags + v4 routes from client and fake, fill STATE.md's API-version section | Planned |

Cross-repo phase order: this repo's MR 1 ships and validates first, then whalesync's URL swap,
then this repo's MR 2, then whalesync's batching.

## MR 1 — URL swap behind a flag

- Wire the flag capability (3-line change, Affinity pattern): pass
  `isFeatureEnabled: ctx.isFeatureEnabled` from `createConnector` into the constructor, mirroring
  `affinity-connector.ts`.
- Resolve `HUBSPOT_ASSOCIATIONS_API_2026_03` **once per connector instance** (the per-call flag
  path does a DB user lookup) and pass a resolved `associationsApiVersion: 'v4' | '2026-03'` into
  the client calls, which build the two paths from it. The client stays a pure HTTP layer with no
  async flag plumbing.
- Undefined `isFeatureEnabled` (direct construction in specs) means **v4** — the flag default —
  and the specs that exercise 2026-03 pass the version option explicitly.
- Fake: mount the 2026-03 equivalents in `test-api-fakes/hubspot` alongside the v4 routes so both
  flag states are testable.

Semantics are unchanged by design; the flag ramp exists to catch HubSpot-side differences between
the v4 and 2026-03 implementations.

## MR 2 — batch publishing behind `HUBSPOT_BATCH_PUBLISH`

Prerequisite: MR 1 at 100% (the batch association endpoints exist only under 2026-03 URLs).

### What a batched publish does

For a publish touching N records of one object type, the runner (which already chunks per
phase × folder) hands the connector batches of `getBatchSize()` = **10**:

1. **Records** — one `POST /crm/v3/objects/{type}/batch/create` (or `batch/update`) call with all
   10 inputs. Every input carries `objectWriteTraceId = String(index)`: that is the documented
   switch that makes HubSpot answer **207 Multi-Status** on a partial failure (creating the valid
   inputs and naming the rejected ones in `errors[].context.objectWriteTraceId`) instead of
   rejecting the whole batch.
2. **Links** — the id-only association diff of every record (`diffAssociationsById`, current vs
   desired) is merged across the batch by (association type, add|remove)
   (`groupAssociationWritesAcrossRecords`) and flushed as **one `batch/associate/default` and one
   `batch/archive` call per association type**, chunked at HubSpot's caps (2,000 pairs / 100
   unique `from` ids). Per record that is however many links it has; per batch it is one call per
   type.
3. **Refetch** — one `GET …/{id}?associations=` per record, as today. `batch/read` does not return
   associations, so this stays per record by design.

**Code layout (for review):** the new flow is a separate class, `HubspotBatchPublisher`
(`hubspot-batch-publisher.ts`), built on the pure helpers in `hubspot-batch-publish.ts` (diff,
grouping, chunking, 207 parsing, record binding). `hubspot-connector.ts` is master's file plus
exactly three branch points — `createRecords`, `updateRecords` (non-quotes) and
`syncAssociations` each start with `if (this.batchPublisher) return this.batchPublisher.…` — plus
`getBatchSize`, the `batchPublish` constructor option, the flag resolution in `createConnector`
and an `extractConnectorErrorDetails` branch. The legacy one-record-per-call flow is otherwise
byte-identical to master, so the two flows can be reviewed independently. The publisher gets the
connector's private helpers (`extractWritableProperties`, `computeWritablePropertiesToPublish`,
property/association lookups, the associations API version) through a small host interface, so
both flows compute payloads and diffs the same way.

### The central design problem: partial batch failures vs. the per-record retry

The runner's contract is throw-or-succeed per batch; a thrown batch marks every record
`failed-batch` and retries them one at a time. For **updates** that is safe — a re-PATCH and a
re-sync of links are idempotent — so batched updates keep the Wix mold: any rejected input or
rejected link throws a `HubspotError` naming the records/pairs and the batch is retried record
by record.

For **creates** the naive contract duplicates records: HubSpot did create 9 of 10, the batch is
retried one by one, and 9 duplicates appear. MR 2 adds one small, generic channel — deliberately
minimal, no new statuses, no id pinning:

- `PartialBatchCreateError` (`connectors/error.ts`): thrown by `createRecords` when at least one
  record was created but the call did not fully succeed. It carries
  `createdRecordsByInputIndex` (the records that exist, keyed by input index) and
  `failureMessagesByInputIndex` (why each rejected input failed). The two maps are disjoint.
- `dispatchCreateBatch` catches it, persists the created records **exactly like a clean batch**
  (FileIndex, refs, git, dirty sync — the same post-processing, narrowed to the created ops) and
  returns the failed ops; `processBatch` marks the created ops `success` and the failed ops
  `failed-batch` with their own reason, mirroring the DEV-10595 pattern for deletes. The ordinary
  per-record retry then re-creates the failed ones.
- **Invariant that makes the retry safe: a failed input has nothing remote.** The batched flow
  enforces it itself: a record it created whose link write or refetch then failed is **archived**
  before the input is reported as failed; an unbindable batch's records are archived too. Nothing
  the runner retries can already exist.
- A batch where **nothing** was created (a 4xx on the whole call, or a 207 rejecting every
  input) throws a plain error as before — the ordinary retry is safe there.
- Accepted double faults (logged, not handled, no extra state): an archive that itself fails
  after a successful create (orphan; the retry may duplicate it); a `batch/create` answer with a
  non-`COMPLETE` status (treated as unbindable — listed records archived, inputs retried — a
  batch that completes later on its own could duplicate); a transport failure after HubSpot
  committed but before the response arrived (looks like a rejection; the retry may duplicate). Also unchanged: a process exit between
  HubSpot's response and the runner's persistence, a pre-existing window for every connector.

Results-to-inputs binding: **live-verified (2026-08-26)** — every `batch/create` result **echoes its
input's `objectWriteTraceId`** (201 and 207; contacts, companies, deals; also on `batch/update`
results), while HubSpot returns results in **arbitrary order** (observed: reversed or shuffled, never
the input order). Trace ids must be unique across the batch or absent everywhere (else 400
`ObjectWriteTraceId values must be unique across the batch or not set`). So results are bound to
the unrejected inputs **by the echoed trace id** (`bindCreatedRecordsByEchoedTraceId`), and only
when a response carries no usable trace id (absent, unknown or duplicated) by the **property values
HubSpot echoes back** (`matchCreatedRecordsToInputs`): normalized comparison (emails lower-cased, numbers as numbers,
timestamps as epoch millis, empties ignored) and a perfect bipartite matching in which every input
is compatible with its record. Inputs that are indistinguishable by their sent values may be bound
to either of their records — those records are identical at that instant, so any choice is correct.
A single input ↔ single record needs no fingerprint. If no unambiguous binding exists (a record
matches no input — an unexpected server-side rewrite), the connector **archives the records it just
created** (`HubspotBatchCreateUnmappableError.createdRecordIds`) and throws a plain error: the chunk
is "nothing created" again, and the per-record retry creates one record per call, which is
trivially bound. No orphans, no duplicates, and a wrong binding is never committed. Updated
records carry `id`, so update results bind by id.

### Quotes are exempt

The published-quote recall dance (`applyQuoteUpdateRecallingIfPublished`) needs each quote's
content and association writes inside its own recall window, so `createRecords` / `updateRecords`
route quotes through the one-record-at-a-time path even with the flag on (`getBatchSize` has no
table context, so the runner still hands 10 quotes; the connector loops them). A quote's
association sync is a one-record diff → at most one call per association type, still a single
awaited call inside the window.

### E-sign guard stays in lockstep

`associationSyncWouldCreateOrDelete` is now literally `!associationDiffIsEmpty(diffAssociationsById(current, desired))`
— the guard and the sync share one diff function, so they cannot drift.

### Error handling changes deliberately

Today a failed association write is `WSLogger.warn` + silent success — a green publish with a
missing link. With `HUBSPOT_BATCH_PUBLISH` on, a rejected link **fails the publish of the records
involved** with a `HubspotAssociationWriteError` naming every failed `{from → to}` pair (the Wix
`assertBulkItemsSucceeded` mold), in every path: the 2026-03 batch calls (207 errors attributed to
pairs by the ids in `errors[].context`; an error naming no sent id is attributed to every pair in
that call — conservative), and the per-pair fallback used when the flag is on but 2026-03 is off.
Expect HubSpot publish error rates to rise — failures stop being hidden. Flag off keeps the
legacy warn-and-swallow, so this can be turned off with the batching if it surprises anyone.

### Flag placement

`getBatchSize` is synchronous and asked once per phase × folder, so the flag is resolved in
`createConnector` (which is async) **before** construction and passed as a plain
`batchPublish: boolean` constructor option — `resolveBatchPublishFlagFailClosed`. No other
connector has a flag-dependent batch size; Affinity gates its writes with an async check inside
the write methods, which doesn't fit a sync per-operation answer. Direct construction (specs, the
live spec) passes `batchPublish` explicitly; default false.

## Flags

Both in `UserFlag` (`server/src/experiments/flags.ts`), server-only (not in `ClientUserFlags`),
default-false, created in PostHog twice — Scratch-Test `225935` and Scratch-Prod `214130` (per
`server/src/experiments/README.md`; "Persist flag across authentication steps" left off,
`evaluation_runtime: server`, 0% rollout):

- `HUBSPOT_ASSOCIATIONS_API_2026_03` — association writes use 2026-03 URLs. Test 843310, prod 843307.
- `HUBSPOT_BATCH_PUBLISH` — batch publishing + surfaced association failures. Test 844768, prod
  844774 (both created 2026-08-25, off). Batched **links** need the first flag too; with
  v4 still selected the links go one call per pair (a warning is logged once per connector
  instance) while records still batch.

Rollout: internal workspace → all users. MR 3 deletes both.

## Testing

- **Unit:** `hubspot-batch-publish.spec.ts` — diff, cross-record grouping, chunking (incl. the
  unique-`from`-ids archive rule), 207 parsing for create (order mapping, refusal on count
  mismatch) and update (by id), association error attribution. `hubspot-connector.spec.ts` —
  batched create/update call shapes against a mocked client, partial-failure error contents,
  created-but-unlinked attribution, quotes exempt, v4 fallback with surfaced errors, legacy
  swallow unchanged. `publish-plan-run.service.spec.ts` — partial batch registers created ids,
  marks only failures, pins `remoteRecordId`; a create op with `remoteRecordId` converges via
  `updateRecords`; a plain error still fails the whole batch.
- **Fake-backed (primary loop):** `cd server && yarn test:integration -- hubspot-connector`.
  `test-api-fakes/hubspot` now models `batch/create` + `batch/update` (207 with
  `context.objectWriteTraceId` / `context.ids`, results reversed and echoing the trace id — or not,
  via `store.omitObjectWriteTraceIdFromBatchResults`, to exercise the property-matching fallback —
  the unique-or-absent trace-id rule, quote lock shared with
  PATCH), `batch/associate/default` (207 for a missing record) and `batch/archive` under
  `/crm/associations/2026-03`, logs every batch request (`store.batchRequestLog`) and rejects
  inputs on demand (`store.rejectBatchInputsWhere`). Cases: 10 creates in one call + one link call
  per type; partial failure → correct ids reported, error surfaced, a lone retry creates nothing
  extra; created-but-unlinked; 10 updates in one call + one associate + one archive; surfaced
  link errors (2026-03 and v4); legacy swallow; quotes never batch.
- **Live (contract proof):** `yarn test:integration -- hubspot-connector-live` with
  `HUBSPOT_API_KEY` in `server/.env.integration` (a Private App token for the team test portal —
  login `team+testing@whalesync.com` / 1Password under testing@whalesync.com; CI var
  `INTEGRATION_TEST_HUBSPOT_API_KEY` still unprovisioned, suite self-skips). New cases, each
  printing anything unexpected so this doc can record the exact contract:
  - `batch/create` results come back in arbitrary order, each echoing its input's trace id (201, 207,
    contacts and companies);
  - one invalid input → 207, valid inputs created, error names the trace id, remaining results bind
    to the right files;
  - `batch/associate/default` links pairs of two records in one call, and `batch/archive` leaves
    **no** company link at all (removes every association type, like the single DELETE) — if not,
    stop and reassess the id-only diff;
  - a bogus `to` id → surfaced association error (207 attributed to the pair, or a 4xx — either
    way surfaced, never swallowed), raw body printed.
- **Smoke tests:** the existing hubspot-backed suites run against the extended fake unchanged.

## Key decisions

- **Solve creates properly rather than batching only updates.** The partial-failure contract is
  small (one error class, one runner branch, `processBatch` returning a count) and generic — any
  connector with a multi-status bulk create can use it. Keeping creates at 1 would have left the
  most call-heavy publish (a big import) unbatched.
- **Created-but-failed → register + `failed-batch` + retry via update**, not a new terminal status.
  Adds no schema/status vocabulary (CLI, shared-types and the review UI keep `failed-batch`), and
  re-uses the existing per-record retry loop for convergence.
- **Updates stay throw-or-succeed.** Idempotent; the cost of re-applying the successes on retry is
  a few extra calls, not a correctness risk.
- **Bind created records by echoed properties, never by position.** The live spec showed HubSpot
  returns batch/create results in arbitrary (reverse) order. When the binding is ambiguous, roll
  the chunk back and let the per-record retry converge — the one path that is always safe.
- **Error surfacing bundled with batching (one flag, one user-visible change):** the batch response
  forces the partial-failure question anyway; the silent-swallow today is a bug, not a contract.
- **Flag resolved at construction** — the only way to keep `getBatchSize` synchronous.
- **v3 endpoints untouched:** no deadline announced; batching uses v3's existing batch routes.

## Live contract findings (2026-08-25, QA portal Hub 343451052, `hubspot-connector-live`)

- `batch/create` (3 valid inputs): 201, results in **reverse** input order → positional binding is
  unsafe; property binding implemented (above).
- `batch/create` results **echo `objectWriteTraceId`** per item (first measured 2026-08-26 with a
  raw-body probe; the earlier "not echoed" note came from reading only `properties`). Order is
  arbitrary: `[2, 7, 4, 0, 1, 3, 5, 8, 9, 6]`, `[5, 3, 9, 0, 1, 2, 8, 4, 7, 6]` for ten inputs; ids
  are not monotonic in input order either. Writable alternatives that also echo exist
  (`hs_object_source_detail_2`) but write user-visible data — rejected. `hs_unique_creation_key`
  and `hs_object_source_detail_1` are read-only.
- `batch/update` with one invalid email: **400 for the whole call, nothing applied** (the valid
  inputs' properties are unchanged afterwards); a unique-value conflict (duplicate email) likewise.
  Only an unknown id gives **207** with the valid inputs applied (`context.ids`). So for a
  validation failure the runner's retry-one-at-a-time is the only way to land the valid nine;
  per-op reporting on updates would only save the re-PATCH of already-applied inputs in the 207 case.
- `batch/create` with one invalid email: **207**, valid inputs created, error
  `VALIDATION_ERROR: Property values were not valid: [{"isValid":false,"message":"Email address
  not-an-email is invalid","error":"INVALID_EMAIL","name":"email"}]` with
  `context.objectWriteTraceId = ["1"]` — exactly the documented shape.
- `batch/associate/default` links pairs of two different records in one call; `batch/archive` then
  leaves **no** `companies` link on either contact — it removes every association type, like the
  single DELETE. The id-only diff stays correct.
- `batch/associate/default` with a bogus `to` id: HubSpot rejects the **whole call** (non-2xx, no
  207 body) — the connector attributes the failure to every pair in that call and surfaces it
  (nothing was written, so that is accurate). The fake models a 207 instead; both paths are
  covered.

## End-to-end run (2026-08-25, local worktree server, QA portal Hub 343451052)

Local monolith server on this branch with `FEATURE_FLAG_OVERRIDES_FOR_LOCAL_DEV=HUBSPOT_BATCH_PUBLISH=true,HUBSPOT_ASSOCIATIONS_API_2026_03=true`,
`CONNECTOR_HTTP_LOGGING=basic` + `LOG_LEVEL=debug` (to count outbound calls), driven with the
`scratchmd` CLI (workspace `wkb_CJu1196YBH`, connection `coa_Ow4cEj4hax`, folders Contacts /
Companies / Deals). Every record was created by the run and deleted at the end; pre-existing
records were only read. Verified after each phase through the HubSpot API.

| Phase | Files | Runner log | Outbound HubSpot calls | HubSpot state |
|---|---|---|---|---|
| 1 · create | 2 companies + 12 contacts, each contact linking a company by `@/` pseudo-ref | create: Companies (2, batchSize 10), Contacts (12, batchSize 10); backfill: Contacts (12, batchSize 10); no failures | (HTTP logging not yet on) — the contact id gap between #10 and #11 matches 2 `batch/create` calls | 2 companies, 12 contacts, **12/12 linked to the right company** |
| 2 · update | 12 contacts renamed, 6 moved to the other company | edit: Contacts (12, batchSize 10); no failures | **2 × `batch/update`** (10 + 2), **1 × `batch/associate/default`** (6 adds), **1 × `batch/archive`** (6 removes), 18 per-record GETs (6 diff reads + 12 refetches) | 12/12 renamed + relinked |
| 2b · partial failure | 3 new contacts, one with `email: not-an-email` | `Batch partially failed (1 failed, 2 succeeded)` → `Retrying 1 failed-batch entries individually` → `Batch failed (size=1)` `BATCH_CREATE_FAILED` | 2 × `batch/create` (3 inputs → 207; then 1 input → rejected), 1 × associate for the 2 created | 2 contacts created + linked; the CLI reports the failed file with HubSpot's exact `INVALID_EMAIL` message and puts it back in the working tree |
| 2c · convergence | the bad email fixed, republished | Contacts (1, batchSize 10); no failures | 1 × `batch/create` (1 input), 1 × associate | 3 contacts, the two earlier ids unchanged — **no duplicates** |
| 3 · delete | all 15 contacts + 2 companies (+ the `example.com` company HubSpot's automation auto-created from the live spec's contact emails) | edit: Contacts (15, batchSize 10) — the plan unlinks contacts from the deleted companies first; delete: 18 entries at batchSize 1 | **2 × `batch/archive`** (10 + 5), 15 + 3 single `DELETE`s | back to the original 2 contacts / 1 company / 1 deal; 0 `dev10200*` records |

Gotchas met on the way (none in this MR's code): a `pkill` of `nest start --watch` leaves the child
`node dist/main` server alive, so a "restarted" server can be a zombie still bound to the old
Redis; and the CLI talks to the server URL recorded at `workspaces init` (in `.scratch/.scratchmd`
and the `.repos/*.git` remotes), not to `SCRATCH_URL`, so a server on a new port needs those
patched.

## Independent review (Codex, 2026-08-25) and what changed

`/codex review` on the branch diff (gpt-5.6, high reasoning) returned 5 P1 + 2 P2; all addressed
(`server/src/**` commits after `33ab7ce67`):

| # | Finding | Fix |
|---|---|---|
| P1 | Normalized binding could swap `"001"`/`"1"` or case-variant values; a missing echoed property counted as a match | Two-pass binding: **exact** values first, normalized only if no exact perfect matching exists; "identical inputs" judged on exact sent values; a property other records echo but this one lacks is a mismatch; any matching where two different inputs could swap records is refused (rollback). |
| P1 | A rollback that fails to archive some records let the ordinary retry re-create them (orphan + duplicate) | Archive retried 3×; a remaining orphan is logged with its id and **accepted** as a double fault (a non-retryable status was built and then removed to keep the blast radius minimal — see "accepted double faults"). |
| P1 | Created ids were registered only after FileIndex/refs/git/dirty persistence — a failure there retried the batch as fresh creates | **Not changed in this MR** (pre-existing generic runner window for every connector; an id-pinning fix was built and removed to keep the blast radius minimal). Follow-up. |
| P1 | Association batch responses with a non-`COMPLETE` status or `numErrors` > listed errors were treated as success | `failedPairsFromBatchAssociationResponse` fails every pair in that call; `mapBatchUpdateResponseToInputs` fails every input on a non-terminal status (idempotent retry). |
| P1 | A `PENDING` create response became "nothing created" → safe-to-retry | A non-`COMPLETE` status is treated as unbindable: the records the body lists are archived and the inputs retried one per call. A batch that completes later on its own could still duplicate — accepted (HubSpot answers `COMPLETE` synchronously in practice). |
| P2 | Second and later chunks used global trace ids the chunk-local mapper rejected | Trace ids are chunk-local; the chunk offset is added back after mapping. |
| P2 | Association error attribution ORed `from`/`to` ids, over-blaming pairs that share a company | Known `from*`/`to*` context keys are parsed separately; both must match when both are present. |

Also from the truncated first run: quotes (one-record-per-call even with the flag on) now report
partial success through the same contract, so a failure on quote #7 of 10 no longer re-creates 1–6.

**Second end-to-end run (2026-08-26, final code, CLI-driven against the QA portal, `HUBSPOT_BATCH_PUBLISH` on):**

| Phase | What | HubSpot calls | Result |
|---|---|---|---|
| A — batched create with one invalid email | 2 companies + 12 contacts (pseudo-refs to the new companies), contact 05 `email: "not-an-email"` | `companies/batch/create` 201; `contacts/batch/create` **207** (chunk of 10: 9 created) + 201 (chunk of 2); 2 × `batch/associate/default`; retry of 05 alone → 207 | 11 contacts created and linked correctly, `e2e-05` reported failed with HubSpot's `INVALID_EMAIL` message and demoted to *unreviewed*; nothing half-created; 15 s |
| B — batched update with one invalid email (+ the fixed create) | all 11 contacts `lastname → Batch v2`, 4 moved between companies, contact 08 `email: "broken-email"`; 05 fixed | `contacts/batch/update` **400** for the chunk of 10 (HubSpot applies nothing), 200 for the chunk of 1; runner retries the 10 one by one: 9 × 200 (+ 4 associate + 4 archive), 1 × 400; `batch/create` 201 for 05 | 12 contacts as expected: 10 renamed/moved, 05 created and linked, 08 untouched and reported failed with `INVALID_EMAIL`; 15 s |
| C — delete | all 14 files removed | 12 + 2 `DELETE` (batch size 1 by design) | portal back to baseline (2 contacts / 1 company / 1 deal) |
| A′/C′ — trace-id binding | after switching to `bindCreatedRecordsByEchoedTraceId`: 12 contacts with **identical** firstname/lastname (only the email differs), 07 invalid | same call pattern as A | 11/11 files hold the id of the record carrying their own email; deletes restore the baseline |

**Second Codex pass** (after the simplification, with the accepted decisions stated up front):
4 P1 + 1 P2.

| # | Finding | Disposition |
|---|---|---|
| P1 | Ambiguity check was pairwise only — a 3-way alternating cycle with two valid matchings was accepted | Fixed: the matching must be unique up to identical-fingerprint groups (`matchingIsAmbiguous` forces each input onto each other compatible record and re-matches). Regression test with the 3-cycle. |
| P1 | Identity fingerprint ignored properties no record echoed, so two inputs differing only there were "identical" | Fixed: fingerprint = every exact non-empty sent property; compatibility still ignores globally unechoed keys. Test added. |
| P1 | A transport error after HubSpot committed (connection drops before the response) is indistinguishable from a rejection → retry duplicates | **Accepted double fault**, documented in code and here (same class as a failed archive / a `PENDING` batch). Closing it needs reconciliation state the minimal contract deliberately avoids. |
| P1 | A refetch answering `null` (record deleted between create and refetch) was persisted as success with a dead id | Fixed: treated as a post-create failure → archived (no-op on 404) and reported failed. Batch + quote-path tests. |
| P2 | Partial batches inflated the progress error count by the whole batch size | Fixed: `processBatch` returns the failed-entry count; callers add that (final persisted status was already correct). Test on `onError`. |
| — | No chunk-local/global offset mistake; flag-off path isolated | — |

## Open questions / must-verify before rollout

- **A 4xx on `batch/create` is assumed to create nothing.** Documented HubSpot behavior; the live
  bogus-association case confirmed the same all-or-nothing behavior for the association batch.
  Revisit only if logs show a `BATCH_CREATE_UNMAPPABLE` rollback with a count mismatch.
- **Rollback of unmappable records is an archive**, i.e. HubSpot's recycle bin (90 days) — the
  records were created milliseconds earlier by us and are invisible to the user; still, watch for
  `Rolled back … unmappable batch-created` warnings after rollout: frequent rollbacks would mean a
  property type HubSpot rewrites that the normalizer doesn't cover.
