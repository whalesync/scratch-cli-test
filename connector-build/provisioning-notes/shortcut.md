# Shortcut — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever ≤10 users, no card)
**Reg-flow gate:** ✅ unblocked (email verification code)
**Provisioned:** 2026-06-25 by ivan · **Run:** [2026-06-25-provisioning-report-ivan-4-8](../provisioning-runs/2026-06-25-provisioning-report-ivan-4-8.md)

## Account
- Login email: `testing@whalesync.com` (`CB_SHORTCUT_LOGIN_EMAIL`)
- Password: `CB_SHORTCUT_PASSWORD` (generated, agent-unseen)
- Workspace slug: `scratch-qa`

## Credentials (in `.env.connector-build`)
- `CB_SHORTCUT_API_TOKEN` — header `Shortcut-Token: <token>`. Created at Settings → API Tokens (modal: name + permissions).
- `CB_SHORTCUT_LOGIN_EMAIL`, `CB_SHORTCUT_PASSWORD`

## Validation
`GET https://api.app.shortcut.com/api/v3/member` with `Shortcut-Token: <token>` → **HTTP 200**.

## Quirks / notes for the build step
- **The stored token is Read-only.** For connector writes (create/update stories), generate a **Full-access** token (the modal defaults to a Custom/Read permission set).
- Multi-step onboarding **gates the app**: workspace name + a **required "profession"** select must be completed before you reach Settings.
- Token shows once in a green reveal block — read it from the leaf `textContent`.

> When `/connector-build-execute shortcut` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
