# Gong — provisioning record

_Provisioned 2026-08-05 (degraded mode: human-gated signup, manual creds)._

## Account

- **Type:** Gong **partner developer instance** — Gong has **no self-serve signup** (sales-led). Requested via the technology-partner form at collective.gong.io on 2026-07-30; granted 2026-08-05 (~4 business days).
- **Owner login:** ryder@whalesync.com via **Google SSO only** — there is **no password login**, so no automated `login.sh` is possible. All testing is **API-only** (which the read-only connector fully supports).
- **Instance:** one workspace ("Initial workspace", id `1299375510811165803`), one user (Ryder Ziola, id `6434845837860324905`). Instance was created **empty** — no calls, no scorecards; test data must be seeded via the ingestion API (`POST /v2/calls`).
- **Plan/trial:** developer instance; no known expiry (watch for deactivation emails).

## Credentials

- `CB_GONG_ACCESS_KEY` + `CB_GONG_ACCESS_KEY_SECRET` — HTTP **Basic auth** pair (key = username, secret = password), created in Gong Admin → API. Stored in `connector-build/.env.connector-build` (⚠️ this store was created fresh on this machine — merge into the 1Password note "connector-build secrets"). Source of truth also at `/Users/ryder/spinner/local/audit-creds/gong.env` (Ryder's machine).
- `CB_GONG_API_BASE_URL` — **instance-specific cell URL** (`https://us02-125032.api.gong.io`). The generic `https://api.gong.io` also answers, but Gong docs recommend the per-instance host.
- **Validated:** `GET <base>/v2/workspaces` → HTTP 200 on 2026-08-05.

## API quirks (for the build)

- REST JSON at `<base>/v2/…`; several list endpoints are **POST with a JSON filter body** (`/v2/calls/extensive`, `/v2/users/extensive`, `/v2/stats/*`).
- Cursor pagination, max 100/page; `records` envelope carries `cursor`/`totalRecords`.
- Rate limits: **3 req/s, 10k req/day** (429 + `Retry-After`).
- Empty result sets can come back as HTTP 404 with an `errors` array (e.g. `/v2/calls` with no calls → "No calls found…"), not an empty list — the transport must treat this as zero rows, not an error.
- Write surface (not used by the read-only connector, but used for seeding): `POST /v2/calls` (create call), `PUT /v2/calls/{id}/media`, CRM upload endpoints.
