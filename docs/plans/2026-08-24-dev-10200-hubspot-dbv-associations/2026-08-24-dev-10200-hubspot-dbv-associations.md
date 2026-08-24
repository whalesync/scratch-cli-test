# HubSpot: migrate association writes off v4 + batch them

- **Created:** 2026-08-24
- **Author:** Ivan Dimitrov
- **Status:** In Progress
- **Linear:** [DEV-10200](https://linear.app/whalesync/issue/DEV-10200) (parent, covers Scratch +
  Whalesync; the Whalesync half is [DEV-10432](https://linear.app/whalesync/issue/DEV-10432) with
  its own plan doc in the whalesync repo, `docs/plans/2026-08-24-hubspot-dbv-associations.md`)

## Summary

HubSpot deprecates its v4 APIs on **March 30, 2027**. The connector's only v4 usage is the two CRM
association write endpoints in `hubspot-api-client.ts` (`createAssociation` :410,
`deleteAssociation` :420); everything else is v3, which has no announced deadline. The replacement
is the date-versioned API (`2026-03` in the URL path), which is 1:1 for our calls:

| Today (v4) | 2026-03 |
|---|---|
| `PUT /crm/v4/objects/{from}/{id}/associations/default/{to}/{toId}` | `PUT /crm/objects/2026-03/{from}/{id}/associations/default/{to}/{toId}` |
| `DELETE /crm/v4/objects/{from}/{id}/associations/{to}/{toId}` | `DELETE /crm/objects/2026-03/{from}/{id}/associations/{to}/{toId}` |

The `default` (unlabeled) shortcut survives, and the unlabeled DELETE still removes all
association types between the two records — so the id-only diff in `syncAssociations`
(`hubspot-connector.ts:973`) and its mirror `associationSyncWouldCreateOrDelete` (:114) keep their
correctness argument. The known label gap (DEV-10902) ports over unchanged.

2026-03 also adds batch association endpoints, which is MR 2:
`POST /crm/associations/2026-03/{from}/{to}/batch/associate/default` (≤2,000 pairs) and
`.../batch/archive` (≤100 unique `from` ids). One call per `(fromType, toType)` pair. Today a
record create issues one PUT per link (`createRecords` passes `current = {}`, so every association
is an add); batching collapses each association type's adds into a single call.

## MR sequence

| # | Scope | Status |
|---|---|---|
| 1 | Wire `ctx.isFeatureEnabled` into the HubSpot connector; swap association writes to 2026-03 URLs behind `HUBSPOT_ASSOCIATIONS_API_2026_03`; add 2026-03 routes to the HubSpot fake | In review (!3265). PostHog flags created, off: prod 843307, test 843310. Live spec extended but not yet run (`HUBSPOT_API_KEY` unprovisioned locally). |
| 2 | Batch association writes behind `HUBSPOT_BATCH_ASSOCIATION_WRITES`; surface association failures instead of warn-and-swallow | Planned |
| 3 | Cleanup: bake both behaviors in, delete flags + v4 routes from client and fake, fill STATE.md's API-version and bulk-limits sections | Planned |

Cross-repo phase order: this repo's MR 1 ships and validates first, then whalesync's URL swap,
then this repo's MR 2, then whalesync's batching.

## MR 1 — URL swap behind a flag

- Wire the flag capability (3-line change, Affinity pattern): pass
  `isFeatureEnabled: ctx.isFeatureEnabled` from `createConnector` (`hubspot-connector.ts:1030`)
  into the constructor, mirroring `affinity-connector.ts:140-171`.
- Resolve `HUBSPOT_ASSOCIATIONS_API_2026_03` **once per connector instance** (the per-call flag
  path does a DB user lookup) and pass a resolved `associationsApiVersion: 'v4' | '2026-03'` into
  `new HubspotApiClient(...)`, which builds the two paths from it. The client stays a pure HTTP
  layer with no async flag plumbing.
- Undefined `isFeatureEnabled` (direct construction in specs) means **v4** — the flag default —
  and the specs that exercise 2026-03 pass the version option explicitly.
- Fake: mount the 2026-03 equivalents in `test-api-fakes/hubspot` alongside the v4 routes
  (`src/index.ts`, `src/routes/associations.ts`) so both flag states are testable.

Semantics are unchanged by design; the flag ramp exists to catch HubSpot-side differences between
the v4 and 2026-03 implementations.

## MR 2 — batch association writes behind a flag

Prerequisite: MR 1 at 100%. Gate at the top of `syncAssociations` (`hubspot-connector.ts:973`) —
one gate covers all three callers (`createRecords` :488, `updateRecords` :713, quote recall :836).

- New client methods next to `batchReadRecords` (`hubspot-api-client.ts:341`, same chunk-loop
  idiom): `batchCreateAssociations` (chunk 2,000) and `batchArchiveAssociations` (chunk 100).
- `syncAssociations` accumulates the existing id-set diff into
  `Map<assocType, {toCreate, toDelete}>`, then flushes one create + one archive call per type,
  instead of one HTTP call per id.
- The quote recall dance is unaffected: its association writes remain a single awaited call inside
  the recall window. `associationSyncWouldCreateOrDelete` keeps mirroring the unchanged diff.
- **Error handling changes deliberately.** Today a failed association write is
  `WSLogger.warn` + silent success — green publishes with missing links. The batch response
  reports per-input failures in-band (HTTP 207-style body; axios does not throw), so MR 2 adds an
  `assertBatchAssociationsSucceeded` in the Wix mold (`wix-blog-connector.ts:419-442`): on any
  failed input, throw naming the failed pairs, failing the record's publish. Expect HubSpot
  publish error rates to rise — failures stop being hidden. This rides the same flag, so it can
  be turned off with the batching if it surprises anyone.

Out of scope, recorded: cross-record batching would require raising `getBatchSize()` from 1 and
batching the record writes themselves, must exempt quotes (recall-window ordering), and conflicts
with the throw-or-succeed publish error contract. Separate project if ever needed. The batch input
format is cross-record-ready, so the MR 2 client methods would be reusable.

## Flags

Both in `UserFlag` (`server/src/experiments/flags.ts`), server-only (not in `ClientUserFlags`),
default-false, created in PostHog twice — Scratch-Test `225935` and Scratch-Prod `214130` (per
`server/src/experiments/README.md`; do not enable "Persist flag across authentication steps"):

- `HUBSPOT_ASSOCIATIONS_API_2026_03` — association writes use 2026-03 URLs.
- `HUBSPOT_BATCH_ASSOCIATION_WRITES` — batch the writes + surface partial failures (only
  consulted when the first flag is on).

Rollout: internal workspace → all users. MR 3 deletes both.

## Testing

- **Fake-backed (primary loop):** `yarn test:integration -- hubspot-connector` — extend the fake
  with the 2026-03 single + batch routes and assert both flag states; add batch cases (grouping,
  chunk limits, partial-failure body → thrown error).
- **Live (contract proof):** `yarn test:integration -- hubspot-connector-live` with
  `HUBSPOT_API_KEY` in `server/.env.integration` (token in 1Password under
  testing@whalesync.com; CI var `INTEGRATION_TEST_HUBSPOT_API_KEY` still unprovisioned, suite
  self-skips there). Add live cases that prove, against the real test portal:
  - single 2026-03 PUT/DELETE round-trip matches v4 behavior;
  - `batch/archive` removes all association types between a pair, matching the single DELETE —
    if not, stop and reassess the id-only diff;
  - exact partial-failure response shape, by including one bogus `to` id.
- **Smoke tests:** the existing hubspot-backed suites (`pull-basic`, `sync-basic`,
  `publish-rate-limit`, …) run against the extended fake unchanged.
- **Unit:** connector spec — URL construction per version, gate behavior for all four
  wired/unwired × on/off states (pattern: `affinity-connector.spec.ts:1018-1056`).

## Key decisions

- **Flag placement:** version resolved in the connector, threaded as a plain constructor option
  into the API client — keeps the client synchronous/testable, matches how `rateLimiter` is
  threaded. Rejected: async flag callback inside the client (adds a flag round-trip per write).
- **Error surfacing bundled with batching (MR 2), not shipped separately:** the batch response
  forces the partial-failure question anyway, and one flag controls one user-visible behavior
  change. The silent-swallow today is a bug, not a contract.
- **v3 endpoints untouched:** no deadline announced; migrating them buys nothing now.

## Open questions

- None blocking MR 1. MR 2's live contract checks (archive semantics, partial-failure shape) are
  resolved during MR 2 development, before rollout.
