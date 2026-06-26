# Trello — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever, no card)
**Reg-flow gate:** ✅ unblocked (Atlassian MFA — **email code**)
**Provisioned:** 2026-06-25 by ivan

## Account
- Login email: `testing@whalesync.com` (`CB_TRELLO_LOGIN_EMAIL`) — Atlassian SSO account
- Password: `CB_TRELLO_PASSWORD` (generated, agent-unseen)

## Credentials (in `.env.connector-build`)
- `CB_TRELLO_API_KEY` — from creating a **Power-Up** (Trello no longer hands out a key directly).
- `CB_TRELLO_TOKEN` — authorized via `https://trello.com/1/authorize?...&key=<key>&...` (manual approve).
- `CB_TRELLO_LOGIN_EMAIL`, `CB_TRELLO_PASSWORD`

## Validation
`GET https://api.trello.com/1/members/me?key=<key>&token=<token>` → **HTTP 200**.

## Quirks / notes for the build step
- **Atlassian login uses an MFA email code** — read it via `gmail-whalesync` (often alphanumeric, e.g. `5X4ZGR` → match `[A-Z0-9]{6}`).
- API key requires creating a **Power-Up**; its form has a **required support-contact** field.
- The token is recoverable from the `/1/authorize?...&token=` redirect URL if the reveal is awkward.
- No login script yet (Atlassian SSO makes scripted login harder; API is key+token so the build step may not need UI login).

> When `/connector-build-execute trello` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
