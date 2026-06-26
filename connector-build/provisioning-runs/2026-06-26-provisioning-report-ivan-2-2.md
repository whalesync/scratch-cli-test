# Provisioning run — 2026-06-26 — ivan — 2/2

Re-pass of the two services that failed the overnight batch for fixable reasons. Both succeeded.

| Service | Result | Gate(s) | How the fix carried it |
|---|---|---|---|
| **SeaTable** | ✅ HTTP 200 | magic-link verify | `gmail-whalesync__read_email` returned the verify link with `?token=` **intact** (vs `claude_ai_Gmail` which redacted it overnight). Completed the 5-step wizard, got the account API token via `api2/auth-token/`, validated `api2/account/info/`. |
| **Coda** | ✅ HTTP 200 | reCAPTCHA + magic-link | Cookie banner intercepted Continue → rejected it. reCAPTCHA appeared → **one human click** (1-off-human-gate). Then magic link read via `gmail-whalesync`, token generated in Developer tools, validated `apis/v1/whoami`. |

## What this run proved
- **The `gmail-whalesync` fix works end-to-end** — link-based verification is no longer a blocker. This is the same fix that unblocks most CRMs.
- **The cookie-dismissal step matters** — Coda's Continue silently no-op'd until the consent banner was rejected.
- **CAPTCHA = 1-off-human-gate** — not a hard blocker; one click and the rest is autonomous. Worth batching (start a run with exactly one such service).

## Tally
- This run: **2/2** (SeaTable, Coda).
- Cumulative provisioned & validated: Todoist, Trello, Baserow, NocoDB, Teable, Grist, Shortcut, **SeaTable, Coda** = **9**.
- Still blocked: Capsule (no free plan — 🔴 trial-only), Stackby (⛔ phone/SMS).

Per-service detail: [`connector-build/provisioning-notes/seatable.md`](../provisioning-notes/seatable.md), [`connector-build/provisioning-notes/coda.md`](../provisioning-notes/coda.md).
