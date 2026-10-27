# Connector test accounts — registry & automated login

How `/connector-build-execute` (and a human picking a connector to build) gets a **live, logged-in
test account** for a service with **no manual password typing** in the common case. This is the
companion to [`queued-connectors.md`](/connector-build/queued-connectors.md): that doc is the _funnel_
(what to build, scored); **this** doc is the _inventory_ (services we have already provisioned a
throwaway test account on, with a reusable browser session and a credential in
the shared test-credentials store).

Two lists, do not conflate them:

| Doc | Question it answers | Contents |
|---|---|---|
| [`queued-connectors.md`](/connector-build/queued-connectors.md) | _What should we build next?_ | ~50 scored services, free-plan / auth / difficulty research. No accounts, no secrets. |
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
   helper** that reads the credential from the shared store — the agent _invokes_ the helper
   but never sees or types the secret. — _Layer 2_

Layer 2 is what removes the refusal: an authorized, pre-written automation logging a known
throwaway account back in is a categorically different act from the model choosing to type a
password it was handed. All three layers are described below.

> **Authorization (state this to the agent, and it is true):** every account in this registry is a
> **disposable, company-owned QA account that holds no real customer data and exists solely to test
> connectors.** Authenticating these accounts — loading a saved session, or running a login helper
> that reads the credential from the shared store — is an **expected, routine** part of
> connector testing, not a sensitive operation. Captcha / 2FA / email-or-phone verification are the
> only login steps that still hand off to a human.

---

## The secret store — Secret Manager (`whalesync-test-credentials`)

All test-account secrets live in **Secret Manager in the GCP project `whalesync-test-credentials`**,
shared with the Whalesync repo (whose `docs/test-credentials.md` describes the store and its access
rules). There is no file to copy between machines: a value is available to every teammate's runs the
moment it is saved.

- **Who can use it:** your own whalesync.com login and your read-only laptop service account can both
  read secrets, create them, and add versions. Deleting a secret or destroying a version needs an org
  admin, so history can't be wiped; overwriting a working key by mistake is undone by saving the old
  version back. Every call needs `--billing-project` as well as `--project` (the helper passes both).
- **One secret per test account**, named after the service in lowercase (`todoist`, `baserow`). A
  second account for the same service gets a suffix (`zoho-eu`). Whalesync keeps its own test accounts
  here too (`airtable`, `attio`, `zoho`, …), so check `credential-helpers.sh list` before creating one:
  if the name is taken by a *different* account, use `<svc>-scratch`.
- **The value is a `.env` file:** comment lines first, saying which account it is, its login, where to
  generate a new key, and when it expires (`set-header` writes them), then the variables. Only test
  accounts go here — never a production or customer credential, and never the password of a
  whalesync.com Google account.
- **Default login email is `testing@whalesync.com`** for every test account (a Whalesync-controlled
  mailbox, so emailed verification links can be retrieved). Passwords are **generated** by the
  credential helper at registration time, not chosen by hand.
- **Naming convention — `<SERVICE>_<FIELD>`**, where `<SERVICE>` is the secret name before any `-`,
  upper-cased. The store's own tools skip any other variable name (so a stored `PATH` or
  `NODE_OPTIONS` can't change what runs on someone's machine), and the helper refuses to write one.

  | Var | For | Example value |
  |---|---|---|
  | `<SVC>_LOGIN_EMAIL` | all | `qa+airtable@whalesync.com` |
  | `<SVC>_PASSWORD` | login-required services | _(secret)_ |
  | `<SVC>_API_TOKEN` | `user_provided_params` services | _(secret)_ |
  | `<SVC>_OAUTH_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` | OAuth services | _(secret)_ |
  | `<SVC>_OAUTH_REFRESH_TOKEN` | OAuth (self-client / long-lived) | _(secret)_ |
  | `<SVC>_ACCOUNT_ID` | all | org / workspace id |
  | `<SVC>_DATA_CENTER` | multi-region services | `EU` |
  | `<SVC>_TRIAL_END` | trials | `2026-06-18` |

- **Reference a secret by its account and var name**, never by value, everywhere outside the store
  (this doc, the login helper, the registry table). Scripts get values through the credential helper
  (`.claude/skills/connector-build-prepare/lib/credential-helpers.sh`), which never prints them:

  ```bash
  H=.claude/skills/connector-build-prepare/lib/credential-helpers.sh
  bash $H require todoist TODOIST_API_TOKEN                     # fail fast, naming any missing var
  bash $H run todoist -- sh -c 'curl -s -H "Authorization: Bearer $TODOIST_API_TOKEN" https://api.todoist.com/api/v1/projects >/dev/null'
  bash $H names todoist                                         # which vars are stored, never the values
  ```

  `run` exports the account's `<SVC>_*` vars into that one command only. The raw read,
  `gcloud secrets versions access latest --secret=<svc> --project=whalesync-test-credentials --billing-project=whalesync-test-credentials`,
  prints every value, so agents should stick to the helper.

This **supersedes** the old `connector-build/.env.connector-build` file and its 1Password note
(`connector-build secrets`), and the ad-hoc credential locations that grew up before that —
`~/.zoho-scratch-test.json`, `server/.env.integration` `ZOHO_*`, keys pasted into per-connector
`STATE.md`. Move those into the store as you touch each connector; the encrypted
`ConnectorAccount.encryptedCredentials` in the DB stays as-is (it's the runtime store, not the
source of truth for re-provisioning).

### Moving an account in from the old 1Password note

Accounts provisioned before 2026-10-27 have their secrets only in the 1Password note
**`connector-build secrets`**, as `CB_<SVC>_<FIELD>` lines. A teammate with 1Password access copies
the note into a temporary file once, and then each account moves with one command (no value is
printed; the `CB_` prefix is dropped on the way in):

```bash
H=.claude/skills/connector-build-prepare/lib/credential-helpers.sh
bash $H import /tmp/connector-build-secrets.env todoist CB_TODOIST_   # → secret todoist, TODOIST_* vars
bash $H set-header todoist <<'EOF'
# Todoist test account (free plan). Login: testing@whalesync.com (password in TODOIST_PASSWORD).
# Where to get the token: Settings > Integrations > Developer > API token.
# Expires: never.
EOF
rm /tmp/connector-build-secrets.env
```

`import` refuses to touch a secret that already exists, since the store's account of that name may
be a different one. When you import under a suffixed name (`attio-scratch`), put that name at the
start of the connector's Test env vars cell in `provisioned-connectors.md` (or `queued-connectors.md`)
so `/connector-build-execute` reads the right secret. Put the details for each header from the account's provisioning note or
`STATE.md`.

> **Never echo a secret.** The helper passes values straight to `$B fill` or into a child command's
> environment; it does not `echo` them, write them to logs, or paste them into a message.

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

**[`/connector-build-prepare <connector>`](/.claude/skills/connector-build-prepare/SKILL.md) builds
this script** (and runs the registration that creates the account in the first place). The script —
and the registration before it — handle the secret through the **credential helper**
(`.claude/skills/connector-build-prepare/lib/credential-helpers.sh`), which **never prints a value**:

- At registration, the agent calls `gen-password <svc> <SVC>_PASSWORD` → a strong random password
  is generated, stored in the `<svc>` secret, and entered into the form field
  (`enter-secret <svc> <SVC>_PASSWORD '<selector>'`) — **the agent never sees it**, so signup is
  fully automatable.
- The login script later enters the same `<SVC>_LOGIN_EMAIL` / `<SVC>_PASSWORD` through the
  helper, submits, and `$B state save <connector>` on success.

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
      ├─ login script exists → run it (reads the store, no echo)          → Layer 2: scripted re-auth
      └─ emailed confirmation needed (or no script) → post ask + /read    → human gate
```

---

## Expanding the list — `/connector-build-prepare`

Adding a service to the inventory is the job of the
**[`/connector-build-prepare <connector>`](/.claude/skills/connector-build-prepare/SKILL.md)** skill
— run it once per connector. It does the whole provisioning flow autonomously:

1. **Pick** the highest-scored not-yet-provisioned service from
   [`provisioned-connectors.md`](/connector-build/provisioned-connectors.md).
2. **Register the account autonomously** on `testing@whalesync.com` — filling the signup form and,
   at the password step, **generating a random password the agent never sees** and entering it via
   the credential helper. It pauses **only** for an emailed confirmation link/code (with a spoken
   `/read` cue), since that mailbox isn't readable by the agent.
3. **Capture the credentials** into the account's secret (API token / OAuth creds, account id,
   trial-end) via the no-echo helper, and describe the account in the secret's header (`set-header`).
4. **Build + verify the login script** (logs in and out a couple of times to prove it round-trips),
   `$B state save <connector>`.
5. **Register it**: fill the **Test env vars** column for the connector's row in
   [`provisioned-connectors.md`](/connector-build/provisioned-connectors.md), note the account in the connector's
   `STATE.md`. Nothing to hand off: the store is already shared with the team.

The per-connector **Test env vars** column in `provisioned-connectors.md` is the source of truth for
which vars each connector needs; `/connector-build-execute` reads it for its fast env preflight.

## Preparation status — the email step is a BATCH checkpoint

`/connector-build-prepare` is built so the **email-confirmation step is a batch checkpoint**, not a
per-service full stop. The expensive human action — clicking verification links — is **batched**:
drive many services *up to* their email gate, let the developer approve **all** the emails in one
pass, then resume **every** service to completion. The table below is how that batch is tracked and
made resumable.

**The flow:**
1. For each service, run the autonomous part (signup → generated password → submit). The moment it
   hits "check your email", set its stage to **`awaiting-email-confirmation`** in the table below,
   add it to a **single running batch ask** (don't post a fresh blocking message per service), and
   **move on to the next service** — do not block the batch.
2. Once the whole batch is parked at `awaiting-email-confirmation`, post the batched ask naming every
   pending service (all emails go to `testing@whalesync.com`), **`/read` it once**, and wait.
3. The developer clicks every verification link, then says "go".
4. **Resume each parked service** from its recorded stage: `verified` → log in via `login.sh`
   (`login-verified`) → grab the API token (`creds-stored`) → register (`done`). Update the row at
   every transition so an interrupted batch is always resumable.

**Stages:** `signup-started` → `awaiting-email-confirmation` → `verified` → `login-verified` →
`creds-stored` → `done`. Update the row **the moment** the stage changes (this table is the durable
state of an in-flight batch — treat it like STATE.md for provisioning).

| Service | Account email | Stage | Session | Env vars stored | Updated | Notes |
|---|---|---|---|---|---|---|
| Todoist | testing@whalesync.com | `done` | `todoist` | `TODOIST_LOGIN_EMAIL`, `TODOIST_PASSWORD`, `TODOIST_API_TOKEN` | 2026-06-25 | Fully prepared: signup → email-verify → onboarding → `login.sh` proven live (headed); token captured (unseen) + validated HTTP 200 against `api.todoist.com/api/v1` (REST v2 & sync v9 are 410-gone — connector must target v1). |
| NocoDB | testing@whalesync.com | `done` | (Chrome ext) | `NOCODB_LOGIN_EMAIL`, `NOCODB_PASSWORD`, `NOCODB_API_TOKEN` | 2026-06-25 | **Done via Chrome ext, fully autonomous.** Signup → email code `759011` fetched from Gmail (sender `noreply@nocodb.com`, not the forward-from — search broadly with `in:anywhere`) → onboarding skipped → personal API token (Records+Base scopes, all resources, 90-day exp) created at `/account/tokens`. Token shown once in a modal (read leaf-element textContent, not an input). Validated HTTP 200 at `api/v2/meta/workspaces/{wnrusqvf}/bases` — **NocoDB cloud API is workspace-scoped** (`/api/v2/meta/bases` and v1 `/db/meta/projects` return 403). |
| Teable | testing@whalesync.com | `done` | (Chrome ext) | `TEABLE_LOGIN_EMAIL`, `TEABLE_PASSWORD`, `TEABLE_API_TOKEN` | 2026-06-25 | **Done via Chrome ext, fully autonomous.** Signup (app.teable.ai) → email code `1008` from Gmail (`hello@notify.teable.ai`) → straight into a base (no onboarding gate) → Permanent PAT at `/setting/personal-access-token` (scopes Read record/base + Read current user email; token value read from the list-page input). Validated HTTP 200 at `/api/auth/user`. **Caveat:** token created with NO base resources attached (confirm dialog warned) — for actual data pulls, recreate the PAT with "Add all resources"/a base added. |
| Grist | testing@whalesync.com | `done` | (Chrome ext) | `GRIST_LOGIN_EMAIL`, `GRIST_PASSWORD`, `GRIST_API_KEY` | 2026-06-25 | **Done via Chrome ext.** Signup (login.getgrist.com) → email **code in body only** (snippet truncated → used Gmail `get_thread` FULL_CONTENT; code `484986`, sender `support@getgrist.com`) → verified, but session didn't carry → had to log in again → Account settings → Developer → Create API key. **Key sits in a masked password input → extension fully redacts JS reads ("[BLOCKED: Base64]").** Worked around by reading the input value as char-codes and decoding in shell. Validated HTTP 200 at `/api/orgs`. |
| Shortcut | testing@whalesync.com | `done` | (Chrome ext) | `SHORTCUT_LOGIN_EMAIL`, `SHORTCUT_PASSWORD`, `SHORTCUT_API_TOKEN` | 2026-06-25 | **Done via Chrome ext.** Signup at shortcut.com/signup (rejected cookie banner) → email code `1356` (sender `testing@whalesync.com`) → onboarding (workspace `scratch-qa`, name, password, profession required) → Settings→API Tokens→Create Token (modal: name + permissions). Token `sct_r_scratch-qa_…` read from the one-time green reveal block via leaf textContent. Validated HTTP 200 at `api.app.shortcut.com/api/v3/member` (header `Shortcut-Token`). **Caveat:** token is Read-only; for connector writes create a Full-access token. |
| Capsule CRM | testing@whalesync.com | `blocked` | — | — | 2026-06-25 | Slot-#5 attempt. **Free-forever plan removed** — only paid plans w/ 14-day no-card trials now (candidates-table staleness). Cookie consent wall intercepted the "Try Free" click. Swapped. |
| Stackby | testing@whalesync.com | `blocked` | — | `STACKBY_LOGIN_EMAIL`, `STACKBY_PASSWORD` (unused) | 2026-06-25 | Slot-#5 attempt. Signup form has a **phone field**; submit → "Something went wrong" (likely phone/SMS-gated). Swapped. |
| SeaTable | testing@whalesync.com | `blocked` | — | `SEATABLE_LOGIN_EMAIL` | 2026-06-25 | Slot-#5 attempt. Account created (email submitted) but verification is a **magic LINK** whose token `get_thread` **redacts** → link unusable. Workaround = click it in-browser via the connected Gmail (Chrome is logged into `ivan.jd@gmail.com`), but Gmail UI search didn't surface the email this run. See report. |
| Coda | testing@whalesync.com | `blocked` | — | — | 2026-06-25 | Slot-#5 attempt. Passwordless **magic-link** signup → same redaction blocker as SeaTable. |

> **Batch result (overnight run):** 4 NEW validated (NocoDB, Teable, Grist, Shortcut) + Todoist + Trello = **6 live**. Slot #5 unfilled — blocked by free-plan-removal / phone-gating / **magic-link verification redaction** (the key limitation). Full analysis + skill-integration plan: [`connector-build/provisioning-runs/2026-06-25-provisioning-report-ivan-4-8.md`](/connector-build/provisioning-runs/2026-06-25-provisioning-report-ivan-4-8.md).
| Trello | testing@whalesync.com | `done` | (Chrome ext) | `TRELLO_LOGIN_EMAIL`, `TRELLO_PASSWORD`, `TRELLO_API_KEY`, `TRELLO_TOKEN` | 2026-06-25 | **Fully done via the Chrome extension** (gstack kept failing). Login: password + **MFA email code (`VNAGAM`) fetched from Gmail** and entered autonomously. Created Power-Up `6a3da71a4ecfaffb2c1432ba` (Trello Workspace; support-contact is a required field), generated API key, authorized a token via `/1/authorize` (Allow). Validated `GET /1/members/me` → HTTP 200. Premium trial ends **2026-07-09**. Note: Chrome extension redacts secret-looking values from JS reads, but the key was in the authorize URL and the token in page article-text via get_page_text. |
| Baserow | testing@whalesync.com | `done` | `baserow` | `BASEROW_LOGIN_EMAIL`, `BASEROW_PASSWORD`, `BASEROW_API_TOKEN` | 2026-06-25 | Fully prepared: signup (generated pw, unseen) → onboarding skipped → logged in, session saved; **no blocking email gate**. Database token created via the management API (`POST /api/database/tokens/` after `token-auth` login with stored creds) and validated HTTP 200 at `api.baserow.io/api/database/tokens/check/`. workspace_id `213959`. (DB tokens aren't in the workspace-settings UI — minted via API.) |

## Maintenance — keep the list usable

A registry of dead trials and expired sessions is worse than no registry. Periodically (manually for
now; a scheduled sweep later):

- **Trials nearing `TRIAL_END`** → cancel deliberately, re-card, or convert; note the lapse in the
  connector's `STATE.md`.
- **Sessions that no longer load** (`state load` lands on a login wall) → run the login script
  (`login.sh`), or re-snapshot by hand.
- **Rotated tokens** → regenerate and save it with `set-secret <svc> <VAR>` (a new version; the old
  one stays readable); the var name is stable so nothing else changes. If the expiry changed, keep
  the rest of the header: `set-header` replaces the whole leading comment block, so pipe the
  existing one back with only the `Expires` line edited:
  `gcloud secrets versions access latest --secret=<svc> --project=whalesync-test-credentials --billing-project=whalesync-test-credentials | awk '!/^[[:space:]]*(#|$)/{exit} {print}' | sed 's/^# Expires:.*/# Expires: <new date>/' | bash $H set-header <svc>`.

---

## Where the inventory lives

There is **no separate registry table** — that would be a second source of truth to drift. The
inventory is two existing artifacts:

- **[`provisioned-connectors.md`](/connector-build/provisioned-connectors.md) → the `Test env vars` column** — the
  cross-service index of which `<SVC>_*` vars each connector needs (in secret `<svc>`). `/connector-build-execute` reads it
  for its fast env preflight; `/connector-build-prepare` fills it when it provisions a connector.
- **each connector's `STATE.md` → `Test account` section** — the authoritative per-connector detail
  (account/org id, plan/trial, session name, workbook/connection ids, decrypt recipe, UI
  quick-links). Never the secret itself.

### Already-provisioned, pending migration into the store

These accounts exist (seeded from their `STATE.md`) but their secrets still live in ad-hoc places
(`~/.zoho-scratch-test.json`, `server/.env.integration`, the encrypted DB) — move each into the
store as you next touch it:

| Connector | Secret | Session | Account / DC | Note |
|---|---|---|---|---|
| Attio | `attio-scratch` | `attio` | `whalesync-attio` (dev program) | api-token. The store's `attio` secret is Whalesync's "Whalesync Testing" workspace, a different account |
| Affinity | — | `affinity` | `whalesync.affinity.co` | **prod — read-only. Never goes in the store** (production credential) |
| Zoho CRM | `zoho-eu` / `zoho-us` | `zoho-eu` / `zoho-us` | org `20115333801` EU · `857392714` US | OAuth + params. The store's `zoho` secret is shared with Scratch's audit harness; check which org it is before adding another |
| Copper | `copper` | `copper` | account `612378` | trial (~2026-06-18) |
| GoHighLevel | `gohighlevel` | `gohighlevel` | sub-account (agency model) | OAuth, trial |
