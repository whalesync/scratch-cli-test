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
├── wordpress/                      # Future: WordPress fake
│   └── ...
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

Add the fake to `server/localdev/docker-compose.yml`:

```yaml
services:
  fake-airtable:
    build: ../../test-api-fakes/airtable
    ports:
      - "4646:4646"
```

### GitLab CI

Add as a service in the integration test job (same pattern as `postgres:16`):

```yaml
.integration-test-server:
  services:
    - name: postgres:16
      alias: postgres
    - name: $CI_REGISTRY_IMAGE/fake-airtable:latest
      alias: fake-airtable
  variables:
    API_URL_OVERRIDES: "https://api.airtable.com/v0=http://fake-airtable:4646"
```

## Implementation Order

1. **Axios interceptor** — smallest change, proves URL rewriting works
2. **Fake Airtable Express app** — implement all 6 endpoints + test admin routes
3. **Integration tests** — exercise the real `AirtableConnector` against the fake
4. **Dockerfile + CI wiring** — containerize and add to pipeline

## Future Work

- Add fakes for other Axios-based connectors (WordPress, etc.)
- Investigate SDK-based connectors (Notion, Webflow, Shopify) — check if their SDKs support custom `baseUrl` options; if not, consider wrapping or patching
- Consider a shared Express middleware library for common fake behaviors (auth, pagination, error simulation)
