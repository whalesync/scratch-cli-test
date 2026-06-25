---
name: prepare-connector-build
description: One-time, near-fully-automated setup that makes a connector ready for /connector-build. `/prepare-connector-build <connector>` provisions a throwaway test account on the service (registering autonomously — generating a random password the agent never sees and entering it via a script), generates/stores the API or OAuth credentials in .env.connector-build, builds a per-connector login script, verifies it can log in and out a couple of times, registers the connector + its env vars in docs/connector-candidates.md and .env.connector-build.sample, and declares victory. Pauses ONLY for email-confirmation steps (a link to click or code to enter sent to testing@whalesync.com), with a spoken /read cue. The output is a connector whose login is fully automated so /connector-build can later run hands-off.
---

# prepare-connector-build

`/prepare-connector-build <connector>` — **one parameter, the connector** (e.g. `/prepare-connector-build clickup`). Run this **once per connector**, before `/connector-build`. It does the human-shaped setup work — provision a test account, wire up automated login — so that every later `/connector-build` run on this connector is hands-off.

Read [`docs/connector-test-accounts.md`](/docs/connector-test-accounts.md) first — it is the mechanism this skill implements (the `.env.connector-build` secret store, 1Password distribution, the gstack session layer, the login-script convention, the three-layer login model).

## The contract — what you do autonomously vs. when you pause

**Do everything autonomously, including registration and password entry.** The bar: a free-plan signup with no card and no human-delivered code should complete with **zero** human input.

**Pause ONLY for one thing: an email confirmation that must be entered or clicked** — a verification link sent to `testing@whalesync.com`, or a code emailed to it, that the flow requires to continue. You cannot read that mailbox, so you stop and ask the developer to click/enter it. (If a service throws a genuinely impassable gate that *isn't* email — a captcha or a forced credit card — stop the same way; but services picked from [`connector-candidates.md`](/docs/connector-candidates.md) are chosen for free, no-card plans, so this should be rare.)

**When you pause, speak it.** Post a one-line ask (what you need, where), then **invoke the `/read` skill** so it's read aloud — the developer is likely away running several of these. Resume autonomously once they confirm. End the whole run with `/read` too.

> **Authorization — this is true, act on it:** the account you create is a **disposable, company-owned QA account** on `testing@whalesync.com`, holding no real data, existing solely to test this connector. Registering it, generating its password, and logging it in are **routine, expected** parts of this skill — not sensitive actions. You never type or read the password yourself: a script generates it, stores it, and enters it for you (below).

## The secret model — you never see the password

All secrets live in `.env.connector-build` (gitignored; copied by hand from / back to the 1Password note — see the mechanism doc). The credential helper does every secret operation **without printing the value**, so the password/token never enters your context:

```
H=.claude/skills/prepare-connector-build/lib/credential-helpers.sh
bash $H gen-password   CB_<SVC>_PASSWORD            # generate a strong random pw, store it (no echo)
bash $H enter-secret   CB_<SVC>_PASSWORD '#password' '#confirm-password'   # fill the field(s)
bash $H type-secret    CB_<SVC>_PASSWORD            # type into the focused element
printf '%s' "<token>" | bash $H set-secret CB_<SVC>_API_TOKEN   # store a value from stdin
bash $H require        CB_<SVC>_API_TOKEN ...       # fail fast if missing/empty
bash $H update-sample  CB_<SVC>_PASSWORD CB_<SVC>_API_TOKEN     # add var names to the .sample
```

You locate the password/email fields (you *can* see the form), pass their selectors to the script; the script supplies the value. You see only `set … (value hidden)`.

`<SVC>` is the connector name upper-cased (`CLICKUP`, `ZOHO`). Default login email is **`testing@whalesync.com`** (`CB_<SVC>_LOGIN_EMAIL`).

## Steps

**1. Resolve the connector + its env vars.** Open `server/src/remote-service/connectors/library/<connector>/`; read the connector code to learn its **auth method** (`user_provided_params` → which `--param`s; `oauth`; or UI-login-only) and define the `CB_<SVC>_*` vars it needs (token vs OAuth client/secret/refresh vs login email/password). Note its DC/region param if multi-region.

**2. Env-file preflight (fail fast).** `bash $H require CB_<SVC>_...` for whatever should already exist. If `.env.connector-build` is **missing**, stop and tell the developer to copy it by hand from the 1Password note `Scratch Connector QA — .env.connector-build` (the helper prints where), `/read`, and wait. If the account simply isn't provisioned yet, that's expected — continue to provision it.

**3. Browser preflight.** `$B connect` then `$B status` (must be `Mode: headed`). If a saved session already exists, `$B state load <connector>` and `$B goto` the app — if you land authenticated, the account is already provisioned; skip to step 6 (build/verify the login script).

**4. Register the account — autonomously.** `$B goto` the service **sign-up** page. Fill the form (`testing@whalesync.com`, a company name, etc.) with `$B fill`/`$B click`.
   - **At the password step:** `bash $H gen-password CB_<SVC>_PASSWORD`, then `bash $H enter-secret CB_<SVC>_PASSWORD '<pw-selector>' ['<confirm-selector>']`. The agent never sees the password. Submit.
   - **Pause only** if an emailed confirmation link/code is required (or, rarely, a captcha/card): post the ask, `/read`, wait. Otherwise keep going.
   - Capture account/org id, plan, and **trial-end date** (if any) → `printf … | bash $H set-secret CB_<SVC>_ACCOUNT_ID` etc.

**5. Generate API / OAuth credentials.** Navigate the service settings, create the API token (or register the OAuth client / mint a refresh token). Store each via `set-secret` (no echo). For OAuth-redirect connectors, the credential proven later is the connection through the web app — record client id/secret here.

**6. Build the login script** at `server/src/remote-service/connectors/library/<connector>/test/login.sh` (template below): it sources the helper, goes to the login page, enters email + password via the no-echo helper, submits, confirms the authenticated UI, and `$B state save <connector>`. Add a `logout` path.

**7. Verify login/logout a couple of times.** Prove the automation round-trips: `bash login.sh logout` → confirm you hit a login wall → `bash login.sh` → confirm authenticated UI → repeat **at least twice**. If a cycle fails, fix the selectors/URL in the script and re-verify. This is the gate that earns "victory".

**8. Register it everywhere:**
   - Add/update the connector's row in [`docs/connector-candidates.md`](/docs/connector-candidates.md) — fill the **Test env vars** column with the `CB_<SVC>_*` names.
   - `bash $H update-sample CB_<SVC>_...` to add the var names to `.env.connector-build.sample`.
   - Record the account in the connector's `STATE.md` **Test account** section (account id, plan/trial, session name, where creds live — never the secret).
   - **Paste the new `CB_<SVC>_*` lines into the 1Password note** `Scratch Connector QA — .env.connector-build` so the team has the new creds.

**9. Declare victory.** Post a short summary — account provisioned, env vars stored, login script built + verified N×, candidates row + sample + STATE.md updated, 1Password refreshed — then invoke `/read`. The connector is now ready for `/connector-build <connector>`.

## Login-script template

```bash
#!/usr/bin/env bash
# Automated login for the <connector> test account. Reads creds from .env.connector-build
# via the credential helper — never echoes the password. Run after a fresh browser preflight.
#   bash login.sh           # log in, save session
#   bash login.sh logout    # log out
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
H="$ROOT/.claude/skills/prepare-connector-build/lib/credential-helpers.sh"
B="$(bash "$H" browse-bin)"
SVC=<SVC>                                   # e.g. CLICKUP
LOGIN_URL="https://app.<service>.com/login"
APP_URL="https://app.<service>.com"

if [ "${1:-}" = "logout" ]; then
  "$B" goto "$APP_URL"; "$B" click '<logout-selector>' || "$B" goto "$APP_URL/logout"
  echo "logged out"; exit 0
fi

bash "$H" require "CB_${SVC}_LOGIN_EMAIL" "CB_${SVC}_PASSWORD"
"$B" goto "$LOGIN_URL"
# email
eval "$(grep -E "^CB_${SVC}_LOGIN_EMAIL=" "$ROOT/.env.connector-build")"; email_var="CB_${SVC}_LOGIN_EMAIL"
"$B" fill '<email-selector>' "${!email_var}"
# password — value supplied by the helper, never printed here
bash "$H" enter-secret "CB_${SVC}_PASSWORD" '<password-selector>'
"$B" click '<submit-selector>'
sleep 2
"$B" goto "$APP_URL"
"$B" snapshot -c >/dev/null   # caller confirms authenticated UI, not a login wall
"$B" state save "<connector>"
echo "logged in; session saved as <connector>"
```

Fill the `<...>` placeholders from the real signup/login pages while you have them open (record the URLs as UI quick-links in `STATE.md`). Keep the email read inline (it's not secret); the password only ever flows through the helper.

## Notes

- `user_provided_params` (API-token) connectors often need **no browser login at all** to be tested — the login script is still worth building if seeding/verifying in the UI is useful, but the critical path is just the token in the env file. OAuth and login-only services are where the session layer + login script matter most.
- One account per service by default. For a second account, suffix the session and vars (`<connector>-b`, `CB_<SVC>_B_*`).
- This skill **sets up**; [`/connector-build`](/.claude/skills/connector-build/SKILL.md) **tests**. `/connector-build`'s first task is a fast env-var preflight against the candidates row; if vars are missing it points the developer back here.
