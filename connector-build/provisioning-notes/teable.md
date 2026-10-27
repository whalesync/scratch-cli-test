# Teable — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever cloud + self-host free, no card)
**Reg-flow gate:** ✅ unblocked (email code from `hello@notify.teable.ai`)
**Provisioned:** 2026-06-25 by ivan · **Run:** [2026-06-25-provisioning-report-ivan-4-8](../provisioning-runs/2026-06-25-provisioning-report-ivan-4-8.md)

## Account
- Login email: `testing@whalesync.com` (`TEABLE_LOGIN_EMAIL`)
- Password: `TEABLE_PASSWORD` (generated, agent-unseen)

## Credentials (secret `teable` in the shared test-credentials store)
- `TEABLE_API_TOKEN` — Personal Access Token, `Authorization: Bearer <token>`. Created in account settings; the form gates on **scopes + resource access**.
- `TEABLE_LOGIN_EMAIL`, `TEABLE_PASSWORD`

## Validation
`GET https://app.teable.io/api/auth/user` with `Authorization: Bearer <token>` → **HTTP 200**.

## Quirks / notes for the build step
- **PAT form needs "Add all resources"** — without granting base access the token is created but has **no access to any base** (Teable warns about this); add a base + access for data pulls.
- Read scopes + a user-read scope cover the validation endpoint.

> When `/connector-build-execute teable` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
