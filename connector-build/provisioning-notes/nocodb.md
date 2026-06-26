# NocoDB — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever cloud + self-host free, no card)
**Reg-flow gate:** ✅ unblocked (email code from `noreply@nocodb.com`)
**Provisioned:** 2026-06-25 by ivan · **Run:** [2026-06-25-provisioning-report-ivan-4-8](../provisioning-runs/2026-06-25-provisioning-report-ivan-4-8.md)

## Account
- Login email: `testing@whalesync.com` (`CB_NOCODB_LOGIN_EMAIL`)
- Password: `CB_NOCODB_PASSWORD` (generated, agent-unseen)
- Cloud workspace id: `wnrusqvf`

## Credentials (in `.env.connector-build`)
- `CB_NOCODB_API_TOKEN` — 40-char token, header `xc-token: <token>`. Created in account → tokens; the form gates on **scopes + resource access** (select the workspace(s)).
- `CB_NOCODB_LOGIN_EMAIL`, `CB_NOCODB_PASSWORD`

## Validation
`GET https://app.nocodb.com/api/v2/meta/workspaces/` with `xc-token: <token>` → **HTTP 200** (lists workspaces incl. `wnrusqvf`).

## Quirks / notes for the build step
- **Cloud API is workspace-scoped.** The generic `GET /api/v2/meta/bases/` (and v1 `/db/meta/projects/`) return **403**; bases live under `GET /api/v2/meta/workspaces/{ws}/bases`.
- Token must be created with read scopes **and** workspace access, or it can't see data.
- Read the token exactly from the leaf-element `textContent` (OCR mistook `O`/`0` once → 401).

> When `/connector-build-execute nocodb` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
