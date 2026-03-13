# Fake Connector APIs for Integration Testing

## Problem

Connectors are the hardest part of our system to test. They hit real external APIs (Airtable, Webflow, Shopify, etc.) which means:

- Tests require real auth credentials
- Tests are subject to random API failures and rate limits
- Tests can't be easily shared across engineers (shared test accounts)
- Edge cases (auth expiry, rate limiting, error responses) are nearly impossible to test reliably

## Solution

Build **fake implementations** of connector APIs — lightweight Express servers that mimic the behavior of real external APIs. Each fake runs as a Docker container on its own port, and our existing connector code talks to them instead of the real APIs during integration tests.

This is the same pattern used by projects like Google's `fake-gcs-server` and AWS LocalStack.

## URL Rewriting via Axios Interceptor

The key insight: connectors don't need to know about fakes at all. Instead, we install a global Axios request interceptor that rewrites base URLs when an environment variable is set.

### How it works

1. All Axios-based connectors (Airtable, WordPress, etc.) use the global `axios` instance with hardcoded base URLs like `https://api.airtable.com/v0/...`.
2. A request interceptor checks each outgoing URL's hostname against a map of overrides.
3. If a match is found, only the scheme + hostname + port are replaced — the path is preserved (e.g., `https://api.airtable.com/v0/meta/bases` becomes `http://localhost:4646/v0/meta/bases`).
4. The fake server serves the same paths as the real API (including `/v0/...`).
5. In production, the env var isn't set, so the interceptor is a no-op.

### Configuration

```
API_URL_OVERRIDES=https://api.airtable.com=http://localhost:4646,https://api.webflow.com=http://localhost:4647
```

### Implementation

```typescript
// server/src/remote-service/connectors/api-url-overrides.ts
import axios from "axios";

// Parse overrides: each entry maps an origin (scheme+host+port) to a replacement origin.
// Example: https://api.airtable.com=http://localhost:4646
const overrides: [string, string][] = (process.env.API_URL_OVERRIDES ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    // Split on "=" but skip the "=" inside "://"
    const eqIndex = entry.indexOf("=", entry.indexOf("://") + 3);
    return [entry.slice(0, eqIndex), entry.slice(eqIndex + 1)];
  });

if (overrides.length > 0) {
  axios.interceptors.request.use((config) => {
    if (!config.url) return config;
    for (const [originalOrigin, replacementOrigin] of overrides) {
      // Match scheme + hostname + port only; preserve the full path
      if (
        config.url.startsWith(originalOrigin + "/") ||
        config.url === originalOrigin
      ) {
        config.url =
          replacementOrigin + config.url.slice(originalOrigin.length);
        break;
      }
    }
    return config;
  });
}
```

### Scope

This approach works for **Axios-based connectors** (Airtable, WordPress, etc.). SDK-based connectors (Notion, Webflow, Shopify) use official client libraries that may or may not support custom base URLs. Those will be addressed later if the pattern proves successful.

## Fake Server Design

Each fake is a small Node/Express app with:

- **Real API routes** that mimic the external service's HTTP contract (URL patterns, methods, request/response shapes, pagination, auth headers)
- **In-memory data store** (`Map`-based) for records, tables, schemas
- **Test admin routes** (`/test/*`) for setup, teardown, and error simulation

### Test Admin Endpoints

| Endpoint                         | Purpose                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| `POST /test/reset`               | Clear all state between tests                                            |
| `POST /test/setup`               | Configure bases, tables, schemas, and seed data                          |
| `POST /test/simulate-rate-limit` | Make the next N requests return 429 with `Retry-After`                   |
| `POST /test/simulate-error`      | Queue a specific error response (status code, body) for the next request |

### Fidelity Goals

Fakes should replicate real API behavior as closely as possible, including:

- Auth validation (reject missing/invalid Bearer tokens with 401)
- Correct pagination (cursor-based, offset-based — matching the real API)
- Realistic error response shapes (matching the real API's error JSON structure)
- Rate limit responses with `Retry-After` headers
- Batch size enforcement
- Field validation where applicable

The goal is to catch the same edge cases in tests that would surprise us in production.

## Directory Structure

```
test-api-fakes/                     # Top-level yarn workspace
├── package.json                    # Workspace root
├── airtable/                       # One directory per connector fake
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                # Express app entry point
│       ├── store.ts                # In-memory data store
│       ├── routes/
│       │   ├── meta.ts             # GET /v0/meta/bases, GET /v0/meta/bases/:baseId/tables
│       │   ├── records.ts          # CRUD on /v0/:baseId/:tableId
│       │   └── test-admin.ts       # /test/reset, /test/setup, /test/simulate-*
│       └── middleware/
│           └── auth.ts             # Bearer token validation
├── wordpress/                      # WordPress REST API fake (port 4647)
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── store.ts
│       ├── routes/
│       │   ├── discovery.ts        # GET /, GET /wp/v2/types, GET /wp/v2/taxonomies, OPTIONS
│       │   ├── records.ts          # CRUD on /wp/v2/:tableId[/:recordId]
│       │   ├── media.ts            # POST /wp/v2/media
│       │   ├── batch.ts            # POST /batch/v1
│       │   └── test-admin.ts
│       └── middleware/
│           └── auth.ts             # Basic auth validation
├── quickbooks/                     # QuickBooks Online API fake (port 4648)
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── store.ts
│       ├── routes/
│       │   ├── query.ts            # GET /v3/company/:realmId/query (SQL-like)
│       │   ├── entity.ts           # GET /v3/company/:realmId/:entityType/:id
│       │   └── test-admin.ts
│       └── middleware/
│           └── auth.ts             # Bearer token validation
├── moco/                           # Moco API fake (port 4649)
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── store.ts
│       ├── routes/
│       │   ├── companies.ts        # CRUD on /api/v1/companies
│       │   ├── contacts.ts         # CRUD on /api/v1/contacts/people
│       │   ├── projects.ts         # CRUD on /api/v1/projects
│       │   └── test-admin.ts
│       └── middleware/
│           └── auth.ts             # Token auth validation
├── audienceful/                    # Audienceful API fake (port 4651)
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── store.ts
│       ├── routes/
│       │   ├── people.ts           # CRUD on /api/people/
│       │   ├── fields.ts           # GET /api/people/fields/
│       │   └── test-admin.ts
│       └── middleware/
│           └── auth.ts             # X-Api-Key validation
└── ...                             # Future: more connectors
```

Integration tests live alongside existing tests:

```
server/test/integration/
└── connectors/
    └── airtable-connector.spec.ts
```

The Axios interceptor lives in the server:

```
server/src/remote-service/connectors/
└── api-url-overrides.ts
```

## Airtable Fake: API Surface

The Airtable connector makes 6 API calls, all to `https://api.airtable.com`. The fake serves the same paths (including the `/v0` prefix):

| Method | Path                            | Purpose                                                   |
| ------ | ------------------------------- | --------------------------------------------------------- |
| GET    | `/v0/meta/bases`                | List all accessible bases                                 |
| GET    | `/v0/meta/bases/:baseId/tables` | Get schema for all tables in a base                       |
| GET    | `/v0/:baseId/:tableId`          | List records (cursor pagination via `offset` query param) |
| POST   | `/v0/:baseId/:tableId`          | Create records (batch up to 10, `typecast: true`)         |
| PATCH  | `/v0/:baseId/:tableId`          | Update records (batch up to 10, `typecast: true`)         |
| DELETE | `/v0/:baseId/:tableId`          | Delete records (IDs in `records[]` query params)          |

### Key behaviors to replicate

- **Auth**: All requests require `Authorization: Bearer <token>` header
- **Pagination**: `GET /:baseId/:tableId` returns `{ records, offset? }` — continue fetching while `offset` is present
- **Record IDs**: Created records get assigned IDs in `rec` + random string format
- **Field keying**: Response records use field names as keys; request records can use field IDs
- **Error shapes**: `{ error: { type, message } }` or `{ error: string }`
- **Rate limits**: 429 with `Retry-After` header (seconds)
- **Delete idempotency**: Deleting an already-deleted record should not error

## CI Integration

### Local development

All fakes are in `server/localdev/docker-compose.yml`:

```yaml
services:
  fake-airtable:
    build: ../../test-api-fakes/airtable
    ports:
      - "4646:4646"
  fake-wordpress:
    build: ../../test-api-fakes/wordpress
    ports:
      - "4647:4647"
  fake-quickbooks:
    build: ../../test-api-fakes/quickbooks
    ports:
      - "4648:4648"
  fake-moco:
    build: ../../test-api-fakes/moco
    ports:
      - "4649:4649"
  fake-audienceful:
    build: ../../test-api-fakes/audienceful
    ports:
      - "4651:4651"
```

### GitLab CI

Add as services in the integration test job (same pattern as `postgres:16`):

```yaml
.integration-test-server:
  services:
    - name: postgres:16
      alias: postgres
    - name: $CI_REGISTRY_IMAGE/fake-airtable:latest
      alias: fake-airtable
    - name: $CI_REGISTRY_IMAGE/fake-wordpress:latest
      alias: fake-wordpress
    - name: $CI_REGISTRY_IMAGE/fake-quickbooks:latest
      alias: fake-quickbooks
    - name: $CI_REGISTRY_IMAGE/fake-moco:latest
      alias: fake-moco
    - name: $CI_REGISTRY_IMAGE/fake-audienceful:latest
      alias: fake-audienceful
  variables:
    API_URL_OVERRIDES: >-
      https://api.airtable.com=http://fake-airtable:4646,
      https://test.wp.local=http://fake-wordpress:4647,
      https://quickbooks.api.intuit.com=http://fake-quickbooks:4648,
      https://sandbox-quickbooks.api.intuit.com=http://fake-quickbooks:4648,
      https://test.mocoapp.com=http://fake-moco:4649,
      https://app.audienceful.com=http://fake-audienceful:4651
```

### Standard test domains

WordPress and Moco use dynamic base URLs (user-provided domains), so we define standard test domains for use in integration tests and local dev:

| Connector | Standard test domain       | Connector endpoint to use in tests  |
| --------- | -------------------------- | ----------------------------------- |
| WordPress | `https://test.wp.local`    | `https://test.wp.local/wp-json/`    |
| Moco      | `https://test.mocoapp.com` | (domain `test` in Moco credentials) |

The fake WordPress server mounts routes at both `/` and `/wp-json/` so URLs like `https://test.wp.local/wp-json/wp/v2/posts` are correctly handled after the interceptor rewrites the origin.

## WordPress Fake: API Surface

The WordPress connector talks to a user-provided endpoint URL. The fake serves all standard WordPress REST API paths. Auth is HTTP Basic (`Authorization: Basic <base64>`).

| Method  | Path                        | Purpose                                                       |
| ------- | --------------------------- | ------------------------------------------------------------- |
| GET     | `/`                         | Discovery API (site name, URL, routes)                        |
| GET     | `/wp/v2/types`              | List post types                                               |
| GET     | `/wp/v2/taxonomies`         | List taxonomies                                               |
| OPTIONS | `/wp/v2/:tableId`           | Get endpoint schema (field definitions)                       |
| GET     | `/wp/v2/:tableId`           | List records (offset-based pagination, `per_page` + `offset`) |
| GET     | `/wp/v2/:tableId/:recordId` | Get single record                                             |
| POST    | `/wp/v2/:tableId`           | Create record                                                 |
| PATCH   | `/wp/v2/:tableId/:recordId` | Update record                                                 |
| DELETE  | `/wp/v2/:tableId/:recordId` | Delete record (`force=true`)                                  |
| POST    | `/wp/v2/media`              | Upload media file (binary body + Content-Disposition)         |
| POST    | `/batch/v1`                 | Batch operations (HTTP 207 multi-status response)             |

## QuickBooks Fake: API Surface

The QuickBooks connector uses only 2 endpoint patterns. Auth is OAuth 2.0 Bearer token. The fake serves paths under `/v3/company/:realmId/`.

| Method | Path                                   | Purpose                                                                |
| ------ | -------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/v3/company/:realmId/query`           | SQL-like queries (`SELECT * FROM Entity STARTPOSITION N MAXRESULTS M`) |
| GET    | `/v3/company/:realmId/:entityType/:id` | Get single entity by ID (entityType is lowercase)                      |

Supports 23 entity types: Account, Bill, BillPayment, CompanyInfo, CreditMemo, Customer, Deposit, Employee, Estimate, Invoice, Item, JournalEntry, Payment, PaymentMethod, Purchase, PurchaseOrder, RefundReceipt, SalesReceipt, TaxCode, TaxRate, Term, TimeActivity, Vendor.

## Moco Fake: API Surface

The Moco connector uses CRUD for 3 entity types. Auth is token-based (`Authorization: Token token=<key>`). Pagination is header-based (`x-page`, `x-per-page`, `x-total`).

| Method | Path                          | Purpose              |
| ------ | ----------------------------- | -------------------- |
| GET    | `/api/v1/companies`           | List companies       |
| GET    | `/api/v1/companies/:id`       | Get company          |
| POST   | `/api/v1/companies`           | Create company       |
| PUT    | `/api/v1/companies/:id`       | Update company       |
| DELETE | `/api/v1/companies/:id`       | Delete company (204) |
| GET    | `/api/v1/contacts/people`     | List contacts        |
| GET    | `/api/v1/contacts/people/:id` | Get contact          |
| POST   | `/api/v1/contacts/people`     | Create contact       |
| PUT    | `/api/v1/contacts/people/:id` | Update contact       |
| DELETE | `/api/v1/contacts/people/:id` | Delete contact (204) |
| GET    | `/api/v1/projects`            | List projects        |
| GET    | `/api/v1/projects/:id`        | Get project          |
| POST   | `/api/v1/projects`            | Create project       |
| PUT    | `/api/v1/projects/:id`        | Update project       |
| DELETE | `/api/v1/projects/:id`        | Delete project (204) |

## Audienceful Fake: API Surface

The Audienceful connector manages email subscribers. Auth is via `X-Api-Key` header. Pagination is cursor-based with `next` URLs.

| Method | Path                  | Purpose                                             |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/api/people/`        | List people (cursor pagination, page size 50)       |
| GET    | `/api/people/:uid/`   | Get person by UID                                   |
| POST   | `/api/people/`        | Create person (requires `email`)                    |
| PUT    | `/api/people/`        | Update person (identified by `email` in body)       |
| DELETE | `/api/people/`        | Delete person (by `email` in body, idempotent, 204) |
| GET    | `/api/people/fields/` | List custom field definitions                       |

Note: All Audienceful endpoints require trailing slashes.

## Port Assignments

| Fake        | Port |
| ----------- | ---- |
| Airtable    | 4646 |
| WordPress   | 4647 |
| QuickBooks  | 4648 |
| Moco        | 4649 |
| Audienceful | 4651 |

## Future Work

- Add fakes for Shopify (GraphQL-based, single POST endpoint) and Supabase (management API + direct PostgreSQL)
- Investigate other SDK-based connectors (Notion, Webflow) — check if their SDKs support custom `baseUrl` options
- Write integration tests exercising each connector against its fake
- Consider a shared Express middleware library for common fake behaviors (auth, pagination, error simulation)
