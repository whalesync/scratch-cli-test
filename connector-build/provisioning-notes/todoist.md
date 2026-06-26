# Todoist — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever, no card)
**Reg-flow gate:** ✅ unblocked (email verification code)
**Provisioned:** 2026-06-25 by ivan

## Account
- Login email: `testing@whalesync.com` (`CB_TODOIST_LOGIN_EMAIL`)
- Password: `CB_TODOIST_PASSWORD` (generated, agent-unseen)

## Credentials (in `.env.connector-build`)
- `CB_TODOIST_API_TOKEN` — Bearer token, from Settings → Integrations → Developer → API token.
- `CB_TODOIST_LOGIN_EMAIL`, `CB_TODOIST_PASSWORD`

## Validation
`GET https://api.todoist.com/api/v1/projects` with `Authorization: Bearer <token>` → **HTTP 200**.

## Login automation
✅ **Login script exists:** `server/src/remote-service/connectors/library/todoist/test/login.sh` (gstack, reads password via the credential helper, saves session as `todoist`).

## Quirks / notes for the build step
- **REST v2 and sync v9 are now `410 Gone`** — the live base is `api.todoist.com/api/v1`. Don't use the old hosts.

> When `/connector-build-execute todoist` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
