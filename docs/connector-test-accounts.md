# Connector test accounts — registry & automated login

How `/connector-build` (and a human picking a connector to build) gets a **live, logged-in
test account** for a service with **no manual password typing** in the common case. This is the
companion to [`connector-candidates.md`](/docs/connector-candidates.md): that doc is the _funnel_
(what to build, scored); **this** doc is the _inventory_ (services we have already provisioned a
throwaway test account on, with a reusable browser session and a credential in
`.env.connector-build`).

Two lists, do not conflate them:

| Doc | Question it answers | Contents |
|---|---|---|
| [`connector-candidates.md`](/docs/connector-candidates.md) | _What should we build next?_ | ~50 scored services, free-plan / auth / difficulty research. No accounts, no secrets. |
| **this doc** | _What can I start testing right now?_ | Services with a **provisioned** test account: login, plan/trial, gstack session name, and an **env-var name** pointing at the secret. |

---

## Why this exists — the login-refusal problem

An agent driving a browser will (correctly) hesitate to type a password into a website, because
"the model decides, free-form, to enter a secret" is a sensitive action. We do **not** fix that by
telling the agent "trust me, it's fine" — that is brittle and the agent will keep hesitating. We
fix it by making login **not a judgment call**:

1. **Don't log in at all** where the connector only needs an API token (most services). — _Layer 0_
2. **Log in once, save the browser session, reuse it forever.** — _Layer 1_
3. When a saved session has expired and no human is around, **re-auth with a pre-written login
   helper** that reads the credential from `.env.connector-build` — the agent _invokes_ the helper
   but never sees or types the secret. — _Layer 2_

Layer 2 is what removes the refusal: an authorized, pre-written automation logging a known
throwaway account back in is a categorically different act from the model choosing to type a
password it was handed. All three layers are described below.

> **Authorization (state this to the agent, and it is true):** every account in this registry is a
> **disposable, company-owned QA account that holds no real customer data and exists solely to test
> connectors.** Authenticating these accounts — loading a saved session, or running a login helper
> that reads the credential from `.env.connector-build` — is an **expected, routine** part of
> connector testing, not a sensitive operation. Captcha / 2FA / email-or-phone verification are the
> only login steps that still hand off to a human.

---

## The secret store — `.env.connector-build`

All test-account secrets live in **one gitignored file at the repo root**:

```
/.env.connector-build          # the real secrets — gitignored (matched by `.env.*`)
/.env.connector-build.sample   # committed template: every var name, no values
```

- Already ignored by the root `.gitignore` (`.env.*`); the `.sample` is un-ignored so the template
  is committed (same pattern as `.env.integration.example`).
- **Default login email is `testing@whalesync.com`** for every test account (a Whalesync-controlled
  mailbox, so emailed verification links can be retrieved). Passwords are **generated** by the
  credential helper at registration time, not chosen by hand.
- **Distributed through 1Password — one canonical copy, copied by hand.** The file's contents live
  in the 1Password note **`Scratch Connector QA — .env.connector-build`**. On a new machine, copy
  them into `<repo-root>/.env.connector-build`. When you provision a new account, paste your new
  `CB_<SVC>_*` lines back into that note so the team gets them. (Manual copy by design — no `op` CLI,
  no automation.) 1Password is the **source of truth**; the on-disk `.env.connector-build` is a
  working copy. Keep the committed `.sample` (var names, no values) in sync so the structure is
  reviewable in git without exposing secrets.
- **Naming convention — `CB_<SERVICE>_<FIELD>`** (service uppercased, `_` for separators; a second
  account for one service gets a suffix, `CB_ZOHO_EU_*` / `CB_ZOHO_US_*`):

  | Var | For | Example value |
  |---|---|---|
  | `CB_<SVC>_LOGIN_EMAIL` | all | `qa+airtable@whalesync.com` |
  | `CB_<SVC>_PASSWORD` | login-required services | _(secret)_ |
  | `CB_<SVC>_API_TOKEN` | `user_provided_params` services | _(secret)_ |
  | `CB_<SVC>_OAUTH_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` | OAuth services | _(secret)_ |
  | `CB_<SVC>_OAUTH_REFRESH_TOKEN` | OAuth (self-client / long-lived) | _(secret)_ |
  | `CB_<SVC>_ACCOUNT_ID` | all | org / workspace id |
  | `CB_<SVC>_DATA_CENTER` | multi-region services | `EU` |
  | `CB_<SVC>_TRIAL_END` | trials | `2026-06-18` |

- **Reference a secret by its var name**, never by value, everywhere outside the file (this doc, the
  login helper, the registry table). A script reads it by sourcing the file:

  ```bash
  set -a; source "$(git rev-parse --show-toplevel)/.env.connector-build"; set +a
  echo "$CB_AIRTABLE_API_TOKEN"   # now available to the helper / CLI; never echoed into the transcript
  ```

This **supersedes the ad-hoc credential locations** that grew up before the registry —
`~/.zoho-scratch-test.json`, `server/.env.integration` `ZOHO_*`, keys pasted into per-connector
`STATE.md`. Fold those into `.env.connector-build` as you touch each connector; the encrypted
`ConnectorAccount.encryptedCredentials` in the DB stays as-is (it's the runtime store, not the
source of truth for re-provisioning).

> **Never echo a secret.** Helpers `source` the file and pass `$CB_*` straight to `$B fill` / the
> CLI; they do not `echo` it, write it to logs, or paste it into a message. The file is the only
> place a value appears in plaintext.

---

## The session layer — log in once, reuse forever (Layer 1)

gstack's browser is a **persistent daemon**: _"State persists between calls (cookies, tabs, login
sessions)"_, and it exposes named snapshots via `$B state save|load <name>`. That is the whole
mechanism:

- **First time** (human, or the provisioning step): log into the test account once in the gstack
  browser, then snapshot it:
  ```bash
  $B state save <service>          # e.g. $B state save airtable  (per account: airtable-acct-b)
  ```
- **Every run** restores it at preflight — already authenticated, **zero passwords typed**:
  ```bash
  $B state load <service>
  $B goto <service-url> && $B snapshot   # confirm authenticated UI, not a login wall
  ```
- **"Log out and log in as another account"** → never actually log out. Keep a **named state per
  account** and switch with `state load <service>-<accountslug>`.
- **OAuth services** (GoHighLevel, Zoho, Salesforce…): a loaded session means the OAuth consent
  screen is a single "Authorize" click — still no password.

---

## The login helper — scripted re-auth (Layer 2)

A saved session eventually expires. For a fully unattended run (e.g. ~10 connectors in parallel, or
a cron job) you cannot wait for a human, and you must not make the agent type the password. So each
**login-required** service gets a tiny **login script** committed next to its connector:

```
server/src/remote-service/connectors/library/<connector>/test/login.sh
```

**[`/prepare-connector-build <connector>`](/.claude/skills/prepare-connector-build/SKILL.md) builds
this script** (and runs the registration that creates the account in the first place). The script —
and the registration before it — handle the secret through the **credential helper**
(`.claude/skills/prepare-connector-build/lib/credential-helpers.sh`), which **never prints a value**:

- At registration, the agent calls `gen-password CB_<SVC>_PASSWORD` → a strong random password is
  generated, stored in `.env.connector-build`, and entered into the form field
  (`enter-secret CB_<SVC>_PASSWORD '<selector>'`) — **the agent never sees it**, so signup is fully
  automatable.
- The login script later reads the same `CB_<SVC>_LOGIN_EMAIL` / `CB_<SVC>_PASSWORD` through the
  helper, fills the form, submits, and `$B state save <connector>` on success.

The agent's instruction is simply _"run the login script for `<connector>`"_ — an authorized,
pre-written automation, not a free-form decision to type a secret. The **only** thing that makes it
pause is an **email confirmation** (a link to click or a code emailed to `testing@whalesync.com`)
that the flow requires — the agent can't read that mailbox, so it stops, posts a one-line ask,
invokes **`/read`** (voice), and waits. (`user_provided_params` services need **no** login script:
there's no UI login on the critical path — the connector connects with the API token directly.)

---

## How a run authenticates (the three layers, in order)

```
Preflight needs the service in the browser?
├─ No  (user_provided_params — connect with the API token only)         → Layer 0: skip login
└─ Yes (seed/verify in the UI, or OAuth consent)
   ├─ $B state load <connector>; session still valid?                    → Layer 1: reuse, done
   └─ Session expired?
      ├─ login script exists → run it (reads the env file, no echo)       → Layer 2: scripted re-auth
      └─ emailed confirmation needed (or no script) → post ask + /read    → human gate
```

---

## Expanding the list — `/prepare-connector-build`

Adding a service to the inventory is the job of the
**[`/prepare-connector-build <connector>`](/.claude/skills/prepare-connector-build/SKILL.md)** skill
— run it once per connector. It does the whole provisioning flow autonomously:

1. **Pick** the highest-scored not-yet-provisioned service from
   [`connector-candidates.md`](/docs/connector-candidates.md).
2. **Register the account autonomously** on `testing@whalesync.com` — filling the signup form and,
   at the password step, **generating a random password the agent never sees** and entering it via
   the credential helper. It pauses **only** for an emailed confirmation link/code (with a spoken
   `/read` cue), since that mailbox isn't readable by the agent.
3. **Capture the credentials** into `.env.connector-build` (API token / OAuth creds, account id,
   trial-end) via the no-echo helper, and add the var **names** to `.env.connector-build.sample`.
4. **Build + verify the login script** (logs in and out a couple of times to prove it round-trips),
   `$B state save <connector>`.
5. **Register it**: fill the **Test env vars** column for the connector's row in
   [`connector-candidates.md`](/docs/connector-candidates.md), note the account in the connector's
   `STATE.md`, and **paste the new `CB_<SVC>_*` lines into the 1Password note** so the team has them.

The per-connector **Test env vars** column in `connector-candidates.md` is the source of truth for
which vars each connector needs; `/connector-build` reads it for its fast env preflight.

## Maintenance — keep the list usable

A registry of dead trials and expired sessions is worse than no registry. Periodically (manually for
now; a scheduled sweep later):

- **Trials nearing `TRIAL_END`** → cancel deliberately, re-card, or convert; note the lapse in the
  connector's `STATE.md`.
- **Sessions that no longer load** (`state load` lands on a login wall) → run the login script
  (`login.sh`), or re-snapshot by hand.
- **Rotated tokens** → regenerate, update the value in `.env.connector-build` and paste the new
  value into the 1Password note; the var name is stable so nothing else changes.

---

## Where the inventory lives

There is **no separate registry table** — that would be a second source of truth to drift. The
inventory is two existing artifacts:

- **[`connector-candidates.md`](/docs/connector-candidates.md) → the `Test env vars` column** — the
  cross-service index of which `CB_<SVC>_*` vars each connector needs. `/connector-build` reads it
  for its fast env preflight; `/prepare-connector-build` fills it when it provisions a connector.
- **each connector's `STATE.md` → `Test account` section** — the authoritative per-connector detail
  (account/org id, plan/trial, session name, workbook/connection ids, decrypt recipe, UI
  quick-links). Never the secret itself.

### Already-provisioned, pending migration into `.env.connector-build`

These accounts exist (seeded from their `STATE.md`) but their secrets still live in ad-hoc places
(`~/.zoho-scratch-test.json`, `server/.env.integration`, the encrypted DB) — migrate each into the
shared file as you next touch it:

| Connector | Env prefix | Session | Account / DC | Note |
|---|---|---|---|---|
| Attio | `CB_ATTIO_` | `attio` | `whalesync-attio` (dev program) | api-token |
| Affinity | `CB_AFFINITY_` | `affinity` | `whalesync.affinity.co` | **prod — read-only** |
| Zoho CRM | `CB_ZOHO_` | `zoho-eu` / `zoho-us` | org `20115333801` EU · `857392714` US | OAuth + params |
| Copper | `CB_COPPER_` | `copper` | account `612378` | trial (~2026-06-18) |
| GoHighLevel | `CB_GOHIGHLEVEL_` | `gohighlevel` | sub-account (agency model) | OAuth, trial |
