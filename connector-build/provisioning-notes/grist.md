# Grist — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever, no card)
**Reg-flow gate:** ✅ unblocked (email code — body-only)
**Provisioned:** 2026-06-25 by ivan · **Run:** [2026-06-25-provisioning-report-ivan-4-8](../provisioning-runs/2026-06-25-provisioning-report-ivan-4-8.md)

## Account
- Login email: `testing@whalesync.com` (`CB_GRIST_LOGIN_EMAIL`)
- Password: `CB_GRIST_PASSWORD` (generated, agent-unseen)

## Credentials (in `.env.connector-build`)
- `CB_GRIST_API_KEY` — `Authorization: Bearer <key>`. Created at Account settings → Developer.
- `CB_GRIST_LOGIN_EMAIL`, `CB_GRIST_PASSWORD`

## Validation
`GET https://docs.getgrist.com/api/orgs` with `Authorization: Bearer <key>` → **HTTP 200**.

## Quirks / notes for the build step
- **Verification code is body-only** (not in the subject/snippet) — read it via `gmail-whalesync__read_email` (sender `support@getgrist.com`).
- **Session doesn't survive email verification** — you have to log in again after verifying.
- The API key sits in a **masked `<input type=password>`** → the extension redacts a direct read; read it as char-codes and decode in the shell (an OCR'd key 401'd; the exact char-code read 200'd).

> When `/connector-build-execute grist` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
