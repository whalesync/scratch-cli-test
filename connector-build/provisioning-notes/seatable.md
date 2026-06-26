# SeaTable — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever cloud, no card)
**Reg-flow gate:** ✅ unblocked (was ⛔ blocked by magic-link redaction; fixed by reading the link via `gmail-whalesync`)
**Provisioned:** 2026-06-26 by ivan · **Run:** [2026-06-26-provisioning-report-ivan-2-2](../provisioning-runs/2026-06-26-provisioning-report-ivan-2-2.md)

## Account
- Login email: `testing@whalesync.com` (`CB_SEATABLE_LOGIN_EMAIL`)
- Password: `CB_SEATABLE_PASSWORD` (generated, agent-unseen)
- Workspace: personal team "Scratch QA"

## Credentials (in `.env.connector-build`)
- `CB_SEATABLE_API_TOKEN` — **account-level** API token, obtained via the auth-token API:
  `POST https://cloud.seatable.io/api2/auth-token/` with `username`+`password` → `{token}`.
- `CB_SEATABLE_LOGIN_EMAIL`, `CB_SEATABLE_PASSWORD`

## Validation
`GET https://cloud.seatable.io/api2/account/info/` with `Authorization: Token <token>` → **HTTP 200**.

## Quirks / notes for the build step
- **Two-tier token model:** the account token (stored) lists workspaces/bases; **per-base API tokens** (long-lived, created in a base's settings) are what you use for base *data* CRUD. The connector will need to enumerate bases with the account token, then create/use a base token per base.
- Signup is a 5-step wizard (name+password → categories → templates → invite → job). Email verification is a **magic link** — read it with `gmail-whalesync__read_email` (NOT `claude_ai_Gmail`, which redacts the `?token=`), then navigate to it.
- Marketing email-capture page (`seatable.com/registration`) sends the verify mail; the actual account setup happens at `start.seatable.com/?mail=…&token=…`.

> When `/connector-build-execute seatable` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
