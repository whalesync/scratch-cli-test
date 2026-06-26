# Baserow — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever cloud + self-host free, no card)
**Reg-flow gate:** ✅ unblocked (straight into the app; email confirmation is non-blocking)
**Provisioned:** 2026-06-25 by ivan

## Account
- Login email: `testing@whalesync.com` (`CB_BASEROW_LOGIN_EMAIL`)
- Password: `CB_BASEROW_PASSWORD` (generated, agent-unseen)

## Credentials (in `.env.connector-build`)
- `CB_BASEROW_API_TOKEN` — a **database token** (non-expiring), created in the workspace's settings → API tokens. Used as `Authorization: Token <token>`.
- `CB_BASEROW_LOGIN_EMAIL`, `CB_BASEROW_PASSWORD`

## Validation
`GET https://api.baserow.io/api/database/tokens/check/` with `Authorization: Token <token>` → **HTTP 200**.

## Quirks / notes for the build step
- The DB **token is database-scoped** (created per workspace) and used directly with `Authorization: Token` for row CRUD — distinct from the JWT used by user/admin endpoints.
- Signup is non-blocking — Baserow drops you straight into the app; the confirmation email isn't a hard gate.
- No login script yet.

> When `/connector-build-execute baserow` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
