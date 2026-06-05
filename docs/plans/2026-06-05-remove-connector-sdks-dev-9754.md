# Remove imported connector SDKs (`webflow-api`, `@notionhq/client`)

**Date**: 2026-06-05
**Status**: In Progress
**Linear**: [DEV-9754](https://linear.app/whalesync/issue/DEV-9754/remove-connector-api-libraries)
**Author**: Curtis Fonger

> **Progress:** PR0 ✅ · PR1 ✅ · PR2–PR6 not started. See [Progress log](#progress-log) and [Implementation notes & corrections](#implementation-notes--corrections) at the bottom.

## Problem

The Webflow and Notion connectors are the only two that still talk to their service through a vendored npm SDK (`webflow-api`, `@notionhq/client`) instead of an explicit axios client. Every other connector (hubspot, airtable, attio, brevo, affinity, …) already follows the house `*-api-client.ts` axios pattern and has a matching fake server under `test-api-fakes/*`.

Keeping the SDKs costs us:

- **Hard-to-fake tests.** Other connectors are exercised offline against a `test-api-fakes/*` server via `API_URL_OVERRIDES` → `createApiClient()`. The SDK connectors can't join that pattern.
- **Hidden request/response logging** and **opaque endpoints** — you can't see which URLs we actually hit, which hurts debugging (including AI-assisted debugging).
- **Self-imposed restrictions the API doesn't have.** `webflow-api@3.2.x` doesn't surface `lastUpdated` on collection items, which blocks Webflow incremental pull even though Webflow REST v2 supports it.
- **Package / import bloat.** The webflow SDK is Fern-generated and heavy.
- **Supply-chain & SOC 2 surface.** Every transitive dependency is something we must monitor, audit, and patch. Removing an SDK shrinks the dependency closure we're accountable for — especially the **production** closure.

The fix: replace each SDK with an explicit axios client that mirrors the existing house pattern, while keeping **on-disk record shapes byte-identical** (product principle: raw API response fidelity).

## Key decisions

1. **Notion: keep `@notionhq/client` for types only, moved to `devDependencies`.** Remove only its runtime symbols (`Client`, `APIResponseError`, `APIErrorCode`, `RequestTimeoutError`, `isFullDatabase`, `isFullDataSource`); keep every `import type`. Its discriminated-union types (`BlockObjectResponse`, `PageObjectResponse`, `RichTextItemResponse`, `DataSourceObjectResponse`, …) are deep (~9 files) and high-risk to re-author, and `import type` erases at build. Moving the package to `devDependencies` pulls it out of the **production** dependency closure (serving the SOC 2 motivation) while keeping compile-time types. Safe because the removal strips every runtime import; `yarn build` type-checks it.
2. **Webflow: full removal** (runtime **and** types). The surface is small and flat — hand-author a local `webflow-types.ts` (including the `FieldType` runtime enum) and drop `webflow-api` entirely.
3. **Order: Webflow first**, Notion second. Webflow is smaller/flatter (no deep unions), has fewer tests, and de-risks the pattern.
4. **Logging interceptor deferred** to a separate follow-up PR (a `createApiClient()`-level request/response log). Not bundled here.
5. **Webflow asset upload: hand-rolled, zero new deps.** Reimplement the SDK's `assets.utilities.createAndUpload` with `node:crypto` (MD5) + Node's native global `FormData`/`Blob` (Node ≥22.22.2 is the repo floor; axios auto-serializes) for the S3 pre-signed multipart POST. Covered by a dedicated upload integration test (the S3 field-ordering failure mode is silent).
6. **Delete `experimental/scratch-v4-backend`.** It's a dead experimental copy (not a workspace member, unreferenced by the root build) that also carries duplicate SDK imports.

> **Note — the Notion v5 SDK upgrade ([DEV-8910](https://linear.app/whalesync/issue/DEV-8910)) is already landed in this branch** (`@notionhq/client@5.22.0`, `dataSources.query/retrieve` in use). So DEV-9754 is a pure runtime-client removal, not a migration. The separate plan doc `2026-05-25-notion-client-v5-upgrade.md` is left untouched; its remaining Phase 5 (2026-03-11 API adoption: `in_trash`/`position`/`meeting_notes`) is out of scope here.

## House pattern being mirrored

- `createApiClient(config?)` (`server/src/remote-service/connectors/create-api-client.ts`) → axios instance with the `API_URL_OVERRIDES` interceptor applied. All clients route through it.
- The api-client owns: `constructor(creds, opts?: { rateLimiter?: RateLimiter })`, a `*_RETRY_OPTS: WithRetryOpts`, a private `withRetry<T>()` delegating to `rateLimiter.withRetry` / `standaloneWithRetry` (`server/src/rate-limiter/rate-limiter.ts`), a custom `*Error extends Error` (`{ message, statusCode, responseData }`), and a `testConnection()`. Reference: `server/src/remote-service/connectors/library/hubspot/hubspot-api-client.ts`.
- The connector holds `private readonly client: XApiClient` and calls `this.client.method(...)`; `withRetry`/RETRY_OPTS move **out of the connector and into the api-client**.
- The connector's `extractConnectorErrorDetails` reuses `extractCommonDetailsFromAxiosError` / `extractErrorMessageFromAxiosError` (`server/src/remote-service/connectors/error.ts`) for the new `isAxiosError` branch.

## Sequencing (PR breakdown)

**PR0 — Cleanup (this change set). ✅ DONE** (`5c2c9760`). Add this doc; `git rm -r experimental/scratch-v4-backend` (standalone commit).

**PR1 — Webflow client + types. ✅ DONE** (implemented + reviewed + verified; uncommitted). Notes: client returns raw `response.data` + normalizes only Asset/Page `createdOn`/`lastUpdated`; flat client methods (`listSites`, `listCollectionItems`, `createItemsLive`, …) replace the SDK's nested `client.collections.items.*`; no `accept-version` header; `updatePageSettings` is PUT. See **Verified findings & corrections** above. New tests: `webflow-api-client.spec.ts` (exact endpoints/params/body, date-normalization, upload field-ordering + MD5) and `webflow-connector-errors.spec.ts` (`extractConnectorErrorDetails` + `deleteRecords` 404 swallow). Connector-test docs updated to the flat-client mock.
- New `webflow-api-client.ts` (`WebflowApiClient`): `createApiClient({ baseURL: 'https://api.webflow.com/v2', headers: { Authorization: 'Bearer …', 'Content-Type': 'application/json', 'accept-version': '2.0.0' } })`; `WEBFLOW_RETRY_OPTS` (429 + `retry-after`); `WebflowError`; `testConnection`. Methods mirror only the SDK calls we use, each returning the **same body shape the SDK returned** (verified by golden fixtures): `listSites`, `listCollections`, `listCollectionItems`, `listAssets`, `listPages`, `getSite`, `getCollection`, `getAsset`, `getPageMetadata`, `getCollectionItem`, `createItemsLive`, `updatePageSettings`, `updateItemsLive`, `deleteItemsLive`, `deleteItems`, `uploadAsset`.
- `uploadAsset`: MD5 → `POST /sites/{siteId}/assets` `{ fileName, fileHash, parentFolder? }` → `{ id, uploadUrl, uploadDetails }` → native `FormData` (uploadDetails fields **first**, `file` Blob **last**) → `POST uploadUrl` → return `id`; keep the follow-up `getAsset(id)`.
- Hand-author `webflow-types.ts` shapes (`Site`, `Collection` w/ `fields: Field[]`, `Field`, `FieldType` **runtime enum**, `CollectionItem(+FieldData)`, `CollectionItemWithIdInput(+FieldData)`, `Page`, `PageMetadataWrite`, `Asset`, `CollectionListArrayItem`); re-derive `WebflowItemMetadata = Omit<CollectionItem,'id'|'fieldData'>` from the local type.
- Modify `webflow-connector.ts` (swap client + calls + error mapping; remove connector-local `withRetry`/RETRY_OPTS), `webflow-json-schema.ts` & `webflow-schema-parser.ts` (repoint `Webflow.*`/`FieldType` to local types).
- Date fields: raw axios returns ISO strings, so the existing `x instanceof Date ? toISOString() : x` guards pass strings through unchanged — no coercion needed.

**PR2 — Webflow OAuth provider.** Replace `WebflowClient.authorizeURL` with a hand-built `https://webflow.com/oauth/authorize?...` URL and `WebflowClient.getAccessToken` with an axios `POST https://api.webflow.com/oauth/access_token`. Inline `OauthScope` as a string-literal union. *(Confirm authorize host/token path against current Webflow OAuth docs.)*

**PR3 — Drop `webflow-api`.** Remove from `server/package.json`; grep proves zero imports; `yarn install`; build + lint + rewritten tests.

**PR4 — Notion client (runtime only).** New `notion-api-client.ts` (`baseURL https://api.notion.com/v1`, `Authorization: Bearer` + `Notion-Version: 2025-09-03`) returning verbatim `response.data`; `NotionError`/`NotionRequestTimeoutError`; error classification off Notion JSON `code` strings + HTTP status; structural replacements for `isFullDatabase`/`isFullDataSource` in `notion-data-source-types.ts`. Port `notion-connector.ts` + the dead-code `notion-block-diff-executor.ts`. Keep all `import type`.

**PR5 — Notion ancillary + dep move.** `code-migrations.controller.ts` uses the new client + shared structural guard; verify `notion-to-html.transformer.ts` and `conversion/*` stay `import type`-only; **move `@notionhq/client` `dependencies` → `devDependencies`** and confirm `yarn build` + a production build still pass.

**PR6 — Test-mock rewrite.** Swap `jest.mock('@notionhq/client')` / `jest.mock('webflow-api')` in the ~8 specs to mock the new api-client / HTTP layer; golden-fixture parity from the live integration specs.

**Deferred (separate ticket).** Request/response logging interceptor in `createApiClient()`.

## Out of scope

- Notion 2026-03-11 API adoption (`in_trash`/`position`/`meeting_notes`) — Phase 5 of the v5 upgrade plan.
- Implementing Webflow incremental pull (the `lastUpdated` param this unblocks) — only correct the support-matrix note when the SDK is gone.
- Full `test-api-fakes/{webflow,notion}` fake servers — unlocked by this work, but not required here.

## Verification

- Per change set: `yarn build` + `yarn lint` from root, **plus `yarn lint-strict` in `server/`** (root lint misses strict server warnings).
- Behaviour-preservation gate: golden-fixture deep-equality of `ConnectorFile` output before/after, captured from the live integration specs (`test/integration/{webflow,notion}-connector.spec.ts`; need real workspace keys in `.env.integration`). `fetchJsonTableSpec`, `pullRecordFiles`, `pullRecordFilesByIds`, and the create→update→delete round-trip are the key checks.
- New HTTP-assertion unit tests prove exact endpoints/bodies (the "AI can see which endpoints we hit" value, locked in by a test).
- Retry/error unit tests: synthetic axios 429 → `*_RETRY_OPTS`; pinned user-facing `extractConnectorErrorDetails` strings (Webflow 409 plan-limit + `body.errors`; Notion unauthorized/rate-limited/not-found/timeout).
- Manual smoke per connector: one full pull + one round-trip publish against a real workspace; plus a real Webflow asset upload (the riskiest reimplemented path).

---

## Progress log

- **PR0 — Cleanup: DONE** (commit `5c2c9760`). This doc added; `experimental/scratch-v4-backend` deleted.
- **PR1 — Webflow client + types: DONE** (implemented, adversarially reviewed, verified — not yet committed). `webflow-api-client.ts` + local `webflow-types.ts` added; `webflow-connector.ts` / `webflow-json-schema.ts` / `webflow-schema-parser.ts` rewired off the SDK; flat client methods (`listSites`, `listCollectionItems`, `createItemsLive`, …) replace the SDK's nested `client.collections.items.*`. `yarn typecheck` + `lint` + `nest build` pass; **123 webflow/asset tests pass**. New tests: `webflow-api-client.spec.ts` (exact endpoints/params/body, date-normalization, upload field-ordering + MD5) and `webflow-connector-errors.spec.ts` (`extractConnectorErrorDetails` + `deleteRecords` 404 swallow); connector-test docs updated to the flat-client mock. The only remaining `from 'webflow-api'` import is the OAuth provider (PR2).
- **PR2–PR6: NOT STARTED.**

## Implementation notes & corrections

Established by reading the `webflow-api@3.2.1` source directly and confirmed by an adversarial review; these correct/refine the original plan above:

1. **The SDK's serialization is pure passthrough EXCEPT `date()` coercion.** Fern resource clients parse responses with `unrecognizedObjectKeys: "passthrough"` + `skipValidation: true`, so no key renames, no dropped/added keys. The one transform: fields typed `core.serialization.date()` are coerced to a JS `Date` (and re-serialized to a canonical `toISOString()` string on disk). So raw axios `response.data` is byte-identical for every field **except** the `date()`-typed ones.
2. **Which fields are `date()`-coerced (the only ones to normalize):** `Asset.createdOn`/`Asset.lastUpdated` and `Page.createdOn`/`Page.lastUpdated`. **`CollectionItem` date fields are `string()`** (never coerced) — must NOT be normalized. `Site`/`Collection` dates are `date()` but never written to disk as records. → The new client reproduces `new Date(x).toISOString()` for exactly the Asset/Page created/updated fields (this is **stronger** than the original PR1 note "guards pass strings through unchanged — no coercion needed", which would drift if Webflow ever returns non-canonical ISO).
3. **No `accept-version` header.** The SDK sends only `Authorization: Bearer` (+ `Content-Type` on bodied requests); the API version is in the `/v2` base path. The original PR1 header note (`'accept-version': '2.0.0'`) was wrong and was omitted.
4. **`updatePageSettings` is `PUT /pages/{id}`** (not PATCH).
5. **Asset upload simplification:** with raw axios, `uploadDetails` carries the **wire S3 key names** (the SDK only camelCased them in its typed layer, then un-camelCased them for S3). So we append `uploadDetails` fields verbatim, `file` part **last**, no rename round-trip. Built with `node:crypto` MD5 + native `FormData`/`Blob` (axios 1.14 serializes both in Node) — zero new deps.
6. **Errors/retry moved into the client (house pattern).** Client lets raw axios errors propagate; the connector branches on `isAxiosError` (404 skip, 409 plan-limit). Retry is **429-only** via the rate limiter (matching every other house api-client), NOT the SDK's 408/429/5xx transport retry — acceptable given jobs are idempotent/resumable. The connector's `extractConnectorErrorDetails` restores the per-error `errors[]`/`details[]` message join (a regression caught and fixed in review). `deleteRecords` swallows strict HTTP 404 only (matches Webflow's documented contract; the old broad substring match only worked because the SDK embedded the body in the error message, which axios does not).
7. **Environment note:** this branch's fresh Conductor workspace was missing the `@spinner/shared-types` workspace symlink (`node_modules/@spinner/shared-types`), which blocks all server compilation — recreate it if `yarn build`/`typecheck` reports `Cannot find module '@spinner/shared-types'`.
