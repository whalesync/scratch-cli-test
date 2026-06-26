# Coda — provisioning record

**Status:** ✅ provisioned & validated (HTTP 200)
**Payment gating:** 🟢 Free-Tier (free-forever, Maker billing, no card)
**Reg-flow gate:** 👤 1-off-human-gate (reCAPTCHA "I'm not a robot" on signup) + magic-link email
**Provisioned:** 2026-06-26 by ivan · **Run:** [2026-06-26-provisioning-report-ivan-2-2](../provisioning-runs/2026-06-26-provisioning-report-ivan-2-2.md)

## Account
- Login email: `testing@whalesync.com` (`CB_CODA_LOGIN_EMAIL`)
- **Passwordless** by default (magic-link sign-in). A password can be added under Account settings → Security if a scripted UI login is ever needed; the connector itself only needs the API token.

## Credentials (in `.env.connector-build`)
- `CB_CODA_API_TOKEN` — REST API token, **read+write**, unrestricted. Created at Account settings → Developer tools (toggle **Enable developer mode**) → **API connections → Generate API token**.
- `CB_CODA_LOGIN_EMAIL`

## Validation
`GET https://coda.io/apis/v1/whoami` with `Authorization: Bearer <token>` → **HTTP 200**.

## Quirks / notes for the build step
- **reCAPTCHA on signup** — needs one human click (1-off-human-gate). After it's cleared, Coda emails a magic link; read it via `gmail-whalesync` and navigate to it.
- **Token reveal:** the new-token modal only offers **"Copy token"** (no inline reveal). The async clipboard API (`navigator.clipboard.readText()`) **hangs under CDP** — instead create a `<textarea>`, focus it, send a real `cmd+v`, then read its `.value` as char-codes and decode in the shell (the value reads redacted otherwise).
- API model is doc/table oriented (`/docs`, `/docs/{id}/tables`, …) and rate-limited.

> When `/connector-build-execute coda` starts, it copies this file to the connector's library folder as `provisioning-notes.md` (kept for future re-provisioning) and lifts only build-useful details into `STATE.md`, then removes this central copy.
