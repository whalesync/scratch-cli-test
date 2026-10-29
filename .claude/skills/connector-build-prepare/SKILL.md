---
name: connector-build-prepare
user-invocable: true
description: One-time, near-fully-automated setup that makes a connector ready for /connector-build-execute. `/connector-build-prepare <connector>` provisions a throwaway test account on the service (registering autonomously — generating a random password the agent never sees and entering it via a script), generates/stores the API or OAuth credentials in the shared test-credentials store (Secret Manager in the `whalesync-test-credentials` GCP project), builds a per-connector login script, verifies it can log in and out a couple of times, registers the connector + its env vars in connector-build/provisioned-connectors.md, and declares victory. Pauses ONLY for email-confirmation steps (a link to click or code to enter sent to testing@whalesync.com), with a spoken /read cue. The output is a connector whose login is fully automated so /connector-build-execute can later run hands-off.
---

# connector-build-prepare

`/connector-build-prepare <connector>` — **one parameter, the connector** (e.g. `/connector-build-prepare clickup`). Run this **once per connector**, before `/connector-build-execute`. It does the human-shaped setup work — provision a test account, wire up automated login — so that every later `/connector-build-execute` run on this connector is hands-off.

Read [`connector-build/test-accounts-mechanism.md`](/connector-build/test-accounts-mechanism.md) first — it is the mechanism this skill implements (the shared Secret Manager store, the saved browser sessions, the login-script convention, the three-layer login model).

## The contract — what you do autonomously vs. when you pause

**Do everything autonomously, including registration and password entry.** The bar: a free-plan signup with no card and no human-delivered code should complete with **zero** human input.

**FIRST THING — announce the gate plan, so the developer knows whether they can walk away.** Before you start signing up, check the connector's **reg-flow gate** (in `queued-connectors.md` / its provisioning note) and say one of:
- **"No gates — I'll work on my own; you can walk away."** (a `✅ unblocked` service: email code/link auto-read via `gmail-whalesync`).
- **"Heads up: a gate is coming (`<e.g. CAPTCHA on signup>`). When I reach it (~a couple minutes in) I'll open the page and you'll have ~1 minute to pass it, then I continue autonomously."** (a `👤 1-off-human-gate`).
Say this up front, not when you hit it. (And when **batching** several, front-load the single `👤` service so the one human moment is at the very start.)

**The email-confirmation gate is no longer a pause — you read the code/link from the mailbox yourself** (Gmail MCP tools; see [Email-gate handling](#email-gate-handling--read-the-verification-codelink-from-the-mailbox-available)). So a clean run with the right access needs **zero** human input. **Pause only** for a genuinely impassable gate: a **captcha**, a **forced credit card**, or a verification email that never arrives / can't be parsed. Services picked from [`queued-connectors.md`](/connector-build/queued-connectors.md) are chosen for free, no-card plans, so even those should be rare.

**Onboarding and other soft UI are NOT pauses — push through to the key.** Welcome/intro modals, "set up your profile / pick a use case" onboarding, consent banners, product tours, "create your first project" nudges: click through all of them (see step 5). The run is only done when you have a **validated** API key (or OAuth connection); don't stop short at a settings page that's merely gated behind onboarding.

**When you pause, speak it — *if* the voice skill is installed.** Post a one-line ask (what you need, where); then, **only if a `/read` skill is available** (check the available-skills list), invoke it so the ask is read aloud — handy when the developer is away running several of these. `/read` is **optional**: if it isn't installed, just post the text ask and wait. Resume autonomously once they confirm. (Same for the end-of-run summary.)

**Default: push each service ALL THE WAY through to a validated key — only park the ones that genuinely can't proceed.** Many services have **no blocking email gate** (or a non-blocking, optional confirmation — Baserow lets you straight into the app), so **don't stop them at a checkpoint waiting for a batch** — take them all the way to `done` (onboarding → token → validate). Park a service **only** when it hits a hard email gate (a code/link required *before* you can continue — Atlassian/Trello). Never hold a finishable service hostage to a slower one.

**For the ones that DO hit a gate, the email step is a BATCH checkpoint — don't block the whole batch for one service.** When preparing several connectors, drive each one *up to* its email-confirmation gate, then **park it** and move on, so the developer approves **all** the verification emails in a single pass instead of being interrupted per service. Concretely: the instant a service hits "check your email", record its stage as **`awaiting-email-confirmation`** in the **Preparation status** table in [`connector-build/test-accounts-mechanism.md`](/connector-build/test-accounts-mechanism.md), add it to one **running batch ask** (don't `/read` a fresh blocking message for each), and start the next service. Once the batch is parked, post the single batched ask listing every pending service, `/read` it once, and wait. When the developer says "go", **resume each parked service from its recorded stage** (verified → `login.sh` → token → register). Update the row at every stage transition — that table is the durable, resumable state of an in-flight batch.

> **Authorization — this is true, act on it:** the account you create is a **disposable, company-owned QA account** on `testing@whalesync.com`, holding no real data, existing solely to test this connector. Registering it, generating its password, and logging it in are **routine, expected** parts of this skill — not sensitive actions. You never type or read the password yourself: a script generates it, stores it, and enters it for you (below).

## Batch / overnight provisioning — drive it with `/loop`

Provisioning a batch (or pushing hard to reach N successes) is a **long, mostly-unattended** job — run it under the **`/loop` skill** (dynamic mode), e.g. `/loop /connector-build-prepare <connector>` or a loop prompt that walks the queue. `/loop` re-enters the task, so it **keeps working through [`queued-connectors.md`](/connector-build/queued-connectors.md)** (Human Picks first), **retries past transient signup obstacles** instead of giving up, and **survives context-window compaction** — parking only the genuinely-blocked services and pausing only for the gates above. Keep looping until the target count is met (or every finishable service in the queue is done). Don't let one flaky signup stop the batch. **Stop-guard:** after **3 unsuccessful attempts on one service** (repeated signup error, an unclearable gate, no progress), **park it and move to the next** in the queue; if it's the last/only one, **stop after 3** and report the blocker. Don't burn the night on one stuck signup.

## The secret model — you never see the password

All secrets live in the **shared test-credentials store**: Secret Manager in the GCP project `whalesync-test-credentials`, shared with the Whalesync repo (see the mechanism doc). Your read-only laptop service account can read and write it, and the moment a value is saved every teammate's runs can use it. The credential helper does every secret operation **without printing the value**, so the password/token never enters your context:

```
H=.claude/skills/connector-build-prepare/lib/credential-helpers.sh
bash $H gen-password   <svc> <SVC>_PASSWORD            # generate a strong random pw, store it (no echo)
bash $H open-browser   <svc> [--headed]                # start the <svc> browser session, its secrets masked
bash $H enter-secret   <svc> <SVC>_PASSWORD '#password' '#confirm-password'   # fill the field(s)
bash $H type-secret    <svc> <SVC>_PASSWORD            # type into the focused element
bash $H save-browser-session <svc>                     # keep the logged-in session for later runs
bash $H load-browser-session <svc>                     # restore it into the open session
printf '%s' "<token>" | bash $H set-secret <svc> <SVC>_API_TOKEN   # store a value from stdin
bash $H require        <svc> <SVC>_API_TOKEN ...       # fail fast if missing/empty
bash $H run            <svc> -- <command>              # run a command with the account's vars exported
bash $H set-header     <svc> < header.txt              # the comment lines describing the account
bash $H names          <svc>                           # which vars are stored (never the values)
```

You locate the password/email fields (you *can* see the form), pass their selectors to the script; the script supplies the value. You see only `set … (value hidden)`, and snapshots of the filled form show `<secret><SVC>_PASSWORD</secret>` in place of the password.

**The browser is Playwright, through `playwright-cli`** — one session per account, named after it: every call carries `-s=<svc>` (`playwright-cli -s=<svc> goto <url>`, `snapshot`, `click e12`, `fill '<selector>' '<text>'`, `--raw eval '<js expression>'`, `screenshot`). `open-browser` registers the account's passwords and tokens as Playwright secrets, which masks them in everything the session prints — but only the values stored **when it opened**, so store a new password before opening (step 3). Never run `playwright-cli open` on a session that's already open: it restarts the browser and drops the login.

`<svc>` is the account's secret name: the connector name in lowercase (`clickup`, `zoho`). `<SVC>` is the same name upper-cased, and **every variable must start with it** (`CLICKUP_API_TOKEN`); the store's tools skip any other name, so the helper refuses them. Default login email is **`testing@whalesync.com`** (`<SVC>_LOGIN_EMAIL`). Before creating a new secret, `bash $H list`: if `<svc>` already exists for a *different* account (Whalesync keeps its own test accounts here too, e.g. `airtable`, `attio`, `zoho`), use a suffixed name such as `<svc>-scratch`.

## Steps

**1. Resolve the connector + its env vars.** Open `server/src/remote-service/connectors/library/<connector>/`; read the connector code to learn its **auth method** (`user_provided_params` → which `--param`s; `oauth`; or UI-login-only) and define the `<SVC>_*` vars it needs (token vs OAuth client/secret/refresh vs login email/password). Note its DC/region param if multi-region.

**2. Store preflight (fail fast).** `bash $H require <svc> <SVC>_...` for whatever should already exist. If the helper says it **can't read Secret Manager**, stop and tell the developer to fix their gcloud login (their own whalesync.com login or their read-only laptop service account), `/read`, and wait. If it says there's **no `<svc>` secret**, the account isn't provisioned yet — that's expected, continue to provision it. If it says the `<svc>` secret **exists but the vars are missing**, it is probably someone else's account (Whalesync keeps its own test accounts here, e.g. `asana`, `mailchimp`): read its header (`gcloud secrets versions access latest --secret=<svc> --project=whalesync-test-credentials --billing-project=whalesync-test-credentials | grep '^#'`). Unless it describes this exact account, use `<svc>-scratch` as the secret name for every later step, **before** any `gen-password` / `set-secret` — those write silently and would overwrite that account's keys.

**3. Browser preflight — try the 3-rung ladder, use the first that works:** (1) **Playwright headless** (`bash $H open-browser <svc>`), (2) **Playwright headed** (`playwright-cli -s=<svc> close`, then `bash $H open-browser <svc> --headed`), (3) **Chrome extension** (`mcp__claude-in-chrome__*`, user-connected via `/chrome`). All need the machine awake. Fall through the ladder; don't let one option's flakiness stop you. **Provisioning a new account? Generate its password first — `bash $H gen-password <svc> <SVC>_PASSWORD` — then open the browser**, so the session masks it. Full ladder + recovery: [connector-build-execute's preflight](/.claude/skills/connector-build-execute/SKILL.md). If a saved session already exists, `bash $H load-browser-session <svc>` and `playwright-cli -s=<svc> goto` the app — if you land authenticated, the account is already provisioned; skip to step 6 (build/verify the login script). If the coworker has **no** browser set up at all, point them at **`/connector-build-onboarding`**.

**4. Register the account — autonomously.** `playwright-cli -s=<svc> goto` the service **sign-up** page. Fill the form (`testing@whalesync.com`, a company name, etc.) with `playwright-cli -s=<svc> fill`/`click`.
   - **At the password step:** `bash $H enter-secret <svc> <SVC>_PASSWORD '<pw-selector>' ['<confirm-selector>']` — the password you generated in step 3. The agent never sees the password. Submit. (If `enter-secret` warns the session shows it in plain text, it was opened before the password existed: submit before taking any snapshot.)
   - **Pause only** if an emailed confirmation link/code is required (or, rarely, a captcha/card): post the ask, `/read`, wait. Otherwise keep going.
   - Capture account/org id, plan, and **trial-end date** (if any) → `printf … | bash $H set-secret <svc> <SVC>_ACCOUNT_ID` etc.

**5. Get the API / OAuth credentials — PUSH ALL THE WAY THROUGH to the key.** **Onboarding is your job, not a blocker.** A fresh account usually drops you into an onboarding flow (welcome modal → name → use-case radios → intro video/tour) that *gates the Settings page* — if you try Settings before finishing it, you bounce to login. **Click through every step** until you land in the real app, then open the developer/API settings. Use JS clicks (`playwright-cli -s=<svc> eval "[...document.querySelectorAll('button,[role=radio]')].find(e=>/let.s go|next|continue|skip|finish/i.test(e.innerText||''))?.click()"`), advancing step by step. **Do not stop at any soft blocker** — onboarding, cookie/consent banners, intro tours, "create your first project" nudges are all things you push past. **Only an *absolutely unbeatable* blocker pauses the run:** an email link you can't read, a captcha, hard 2FA, or a forced credit card.
   - Create/copy the API token (or register the OAuth client / mint a refresh token). **The token is often a readonly `password` input — read its `.value` via `playwright-cli -s=<svc> --raw eval` and pipe straight to `set-secret`, never printing it:** return `'TKN:'+input.value`, then `grep -oE 'TKN:[^[:space:]"]+' | sed 's/^TKN://'` into `set-secret <svc> <SVC>_API_TOKEN` (`--raw` prints the result as a JSON string, so the pattern stops at the closing `"`).
   - **Validate before declaring victory:** `curl` the service API with the stored token and assert HTTP 200 (`bash $H run <svc> -- sh -c 'curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $<SVC>_API_TOKEN" <api-url>'`). A working token is the proof the whole run succeeded. (Watch for deprecated API versions — e.g. Todoist's REST v2 / sync v9 now return 410; the live base is `api.todoist.com/api/v1`.)
   - For OAuth-redirect connectors, the credential proven later is the connection through the web app — record client id/secret here.

**6. Build the login script** at `server/src/remote-service/connectors/library/<connector>/test/login.sh` (template below): it opens the `<svc>` browser session if needed, goes to the login page, enters email + password via the no-echo helper, submits, confirms the authenticated UI, and runs `save-browser-session <svc>`. Add a `logout` path.

**7. Verify login/logout a couple of times.** Prove the automation round-trips: `bash login.sh logout` → confirm you hit a login wall → `bash login.sh` → confirm authenticated UI → repeat **at least twice**. If a cycle fails, fix the selectors/URL in the script and re-verify. This is the gate that earns "victory".

**8. Register it everywhere:**
   - **Describe the account in the secret itself**, so whoever finds it in the store (including Whalesync teammates) can replace the key without asking: `bash $H set-header <svc>` with comment lines on stdin — which account it is and its login, where to generate a new key, and when it expires (trial end, or "never"). Comments only; never a value.
   - Add/update the connector's row in [`connector-build/provisioned-connectors.md`](/connector-build/provisioned-connectors.md) — fill the **Test env vars** column with the `<SVC>_*` names (they live in secret `<svc>`). If the secret got a suffix because the plain name was taken, start the cell with it (`attio-scratch: ATTIO_API_TOKEN`) — `/connector-build-execute` reads the secret name from there.
   - Record the account in the connector's `STATE.md` **Test account** section (account id, plan/trial, session name, where creds live: secret `<svc>` in `whalesync-test-credentials` — never the secret).

**9. Declare victory.** Post a short summary — account provisioned, `<svc>` secret stored (with its header), login script built + verified N×, provisioned-connectors row + STATE.md updated. There is no hand-off step for the secrets: the store is already shared with the team.

Then invoke `/read`. The connector is now ready for `/connector-build-execute <connector>`.

## Login-script template

```bash
#!/usr/bin/env bash
# Automated login for the <connector> test account. Reads creds from the shared test-credentials
# store (secret `<svc>`) via the credential helper — never echoes the password.
#   bash login.sh                                 # browser session `<svc>` (opened headless if it isn't open)
#   PLAYWRIGHT_CLI_SESSION=<name> bash login.sh   # drive another playwright-cli session
#   bash login.sh logout
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
H="$ROOT/.claude/skills/connector-build-prepare/lib/credential-helpers.sh"
ACCOUNT=<svc>                                # the store secret, e.g. clickup
SVC=<SVC>                                    # its variable prefix, e.g. CLICKUP
# Every playwright-cli call below, and the helper's, drives this session.
export PLAYWRIGHT_CLI_SESSION="${PLAYWRIGHT_CLI_SESSION:-$ACCOUNT}"
LOGIN_URL="https://app.<service>.com/login"
APP_URL="https://app.<service>.com/app"

bash "$H" open-browser "$ACCOUNT" >/dev/null

if [ "${1:-}" = "logout" ]; then
  playwright-cli goto "$APP_URL" >/dev/null || true
  playwright-cli eval "[...document.querySelectorAll('button,[role=button],a')].find(e=>/log ?out|sign ?out/i.test(e.innerText||''))?.click()" >/dev/null || true
  echo "logged out"; exit 0
fi

bash "$H" require "$ACCOUNT" "${SVC}_LOGIN_EMAIL" "${SVC}_PASSWORD" >/dev/null

playwright-cli goto "$LOGIN_URL" >/dev/null; sleep 3
bash "$H" enter-secret "$ACCOUNT" "${SVC}_LOGIN_EMAIL" 'input[type=email]'
# password supplied by the helper from the store — never printed here
bash "$H" enter-secret "$ACCOUNT" "${SVC}_PASSWORD" 'input[type=password]'
# submit via JS — a JS click also gets past any overlay covering the button
playwright-cli eval "document.querySelector('button[type=submit]')?.click()" >/dev/null
sleep 6

url="$(playwright-cli --raw eval "location.href" | tr -d '"')"
case "$url" in
  *"/login"*|*"/auth/"*) echo "LOGIN FAILED — still on the login wall ($url)"; exit 1;;
  *) echo "LOGIN OK — $url"; bash "$H" save-browser-session "$ACCOUNT" >/dev/null; echo "session saved for $ACCOUNT";;
esac
```

Fill the `<...>` placeholders from the real signup/login pages while you have them open (record the URLs as UI quick-links in `STATE.md`). Both the email and the password flow through the helper, so the script never needs to read the store itself.

## Notes

- `user_provided_params` (API-token) connectors often need **no browser login at all** to be tested — the login script is still worth building if seeding/verifying in the UI is useful, but the critical path is just the token in the store. OAuth and login-only services are where the saved browser session + login script matter most.
- One account per service by default. For a second account, suffix the secret (`<connector>-b`); its browser session and saved login take the same name. Its variables keep the plain `<SVC>_` prefix, since each secret holds one account.
- This skill **sets up**; [`/connector-build-execute`](/.claude/skills/connector-build-execute/SKILL.md) **tests**. `/connector-build-execute`'s first task is a fast env-var preflight against the candidates row; if vars are missing it points the developer back here.

## Cookie / consent banners — dismiss FIRST (they intercept clicks)

A consent wall (OneTrust, Cookiebot, Usercentrics, Osano, Ketch, …) renders an **overlay that swallows clicks** on the rest of the page. If you don't dismiss it, your "Sign up" / "Try free" click **silently does nothing** — this is exactly what stalled the Capsule run. So **right after every `navigate`/`goto`, clear the banner before doing anything else.**

**Step 1 — JS dismiss (browser-agnostic, reject-first for privacy).** Run the shared snippet:
- Chrome ext: `javascript_tool` with the contents of `lib/dismiss-cookie-banner.js`
- Playwright: `playwright-cli -s=<svc> --raw eval "$(cat .claude/skills/connector-build-prepare/lib/dismiss-cookie-banner.js)"`

It walks the DOM + open shadow roots + same-origin iframes, prefers **"Reject all"/"Decline"** over Accept, and returns what it clicked. Idempotent — safe to run after every navigation.

**Step 2 — screenshot → pixel-click fallback (when JS can't reach it).** Some walls (e.g. **Ketch**, which blocked Capsule) live in a **cross-origin iframe** the snippet can't touch, so it returns `no cookie banner button found` while the banner is plainly visible. Then:
1. Take a **screenshot** (`computer` action `screenshot`, or `playwright-cli -s=<svc> screenshot` and Read the file it names).
2. Locate the **Reject/Decline** button (fall back to Accept only if there's no reject option).
3. **Click the exact pixel** — Chrome ext: `computer` `left_click` at `[x,y]`; Playwright: `playwright-cli -s=<svc> run-code "async page => { await page.mouse.click(<x>, <y>); }"`. Aim for the **center** of the button.
4. Re-screenshot to confirm the banner is gone, then proceed.

Never let a cookie wall be the reason a service is parked — between the JS snippet and the pixel-click fallback, it is always dismissable.

## Outputs & the `connector-build/` folder (top-level — its own thing)

Everything connector-build lives in the top-level **`connector-build/`** folder (NOT under `docs/`):

| Path | What |
|---|---|
| `connector-build/existing-connectors.md` | cross-connector support/playbook table (connectors already built) |
| `connector-build/queued-connectors.md` | **the funnel** — candidate research + scoring + **Human-Pick order**; pick the next connector to provision here |
| `connector-build/provisioned-connectors.md` | **the build-ready registry** — finished provisioning, secrets stored, token validated; `/connector-build-execute` can begin |
| `connector-build/provisioning-notes/<service>.md` | **one doc per provisioned service** — the detailed record (account, creds, validated endpoint, gates, quirks). Write this when you finish a service. |
| `connector-build/provisioning-runs/YYYY-MM-DD-provisioning-report-<person>-<success>-<all>.md` | **one run report per session** (e.g. `…-ivan-2-2.md` = 2 of 2 succeeded) |
| `connector-build/test-accounts-mechanism.md` | the secret-store / login-script / Gmail mechanism doc (secrets themselves live in the shared Secret Manager store, not the repo) |

**Pick the next service from `queued-connectors.md`** (Human Picks first). **When you finish provisioning a service:** (1) **move it out of `queued-connectors.md` into `provisioned-connectors.md`** (with env vars + gate axes), (2) write `connector-build/provisioning-notes/<service>.md`, and (3) at end of session write the run report. **Lifecycle:** when `/connector-build-execute <service>` later starts the real build, it **copies `connector-build/provisioning-notes/<service>.md` into the connector's library folder as `provisioning-notes.md`** (kept there — it's useful if the account ever needs re-provisioning), **lifts only build-useful details into `STATE.md`** (STATE.md is read on every build, so keep it lean — don't dump the whole provisioning doc in), and **removes the central copy** — so a service is in exactly one place: "provisioned, awaiting build" (central `provisioning-notes/`) → or "building/built" (its own folder).

## Payment gating, trials & the 1-off-human-gate

Classify every candidate on **two axes** (legend in `queued-connectors.md`) and record them in its per-service doc:

- **Payment:** 🟢 Free-Tier (ideal) · 🟡 Trial-NO-CC (OK — works now, may expire) · 🔴 Trial-CC (avoid).
- **Reg-flow:** ✅ unblocked · ⛔ blocked (phone/SMS, hard 2FA — park it) · 👤 1-off-human-gate (CAPTCHA).

**Trials (TODO — not fully solved):** a 🟡 Trial-NO-CC is fine — register and use it (note the expiry in its doc). A 🔴 Trial-CC is **parked**: the plan is to register, enter a card, and **schedule a cancel** before the charge — but **entering the credit card is the unsolved problem** (we won't type card details). Until that's solved, treat Trial-CC as blocked-for-now. *(Leaving this here as the open design question to resolve.)*

**The 1-off-human-gate (CAPTCHA) — how to batch it:** a CAPTCHA needs exactly **one** human click; everything after is autonomous. So when a batch includes 👤 services, **start the batch with exactly ONE such service**, drive **straight to the gate fast**, then ask the user to click "I'm not a robot" (a spoken `/read` cue if they're away). The moment they pass it, continue autonomously — and the rest of the batch (✅ services) needs no one. Don't scatter several 👤 services through a run; cluster the single human click at the front.

## Email-gate handling — read the verification code/link from the mailbox (AVAILABLE)

The email-confirmation gate (especially the emailed **short-lived code** — Atlassian/Trello blocks setup until it's entered) used to need a human. **It no longer does: the agent has mailbox access** via the **Gmail MCP tools**. Don't park at the gate — fetch the code/link yourself.

**⚠️ PREREQUISITE — the `gmail-whalesync` MCP must be connected.** This skill reads the email gate through it. **Before relying on the mailbox, check that `mcp__gmail-whalesync__*` tools exist** (e.g. try `ToolSearch` for `mcp__gmail-whalesync__search_emails`, or look for it in the tool list). **If it is NOT defined, stop and prompt the developer to install it first:**
> "The `gmail-whalesync` MCP isn't connected. Run `.claude/skills/connector-build-prepare/gmail-setup` (it connects **your own** `@whalesync.com` Gmail, project-scoped; the OAuth client JSON is in **1Password → "Gmail Auto-Label Desktop OAuth"**), then **restart this session** so the new MCP is picked up."

Don't fall back to a personal inbox — wait for `gmail-whalesync`.

**⚠️ Use the right Gmail MCP — there are two, and one redacts links:**
- **`mcp__gmail-whalesync__*`** (`search_emails`, `read_email`) — the project-scoped **work-Gmail** server (your own `@whalesync.com` account, connected via `gmail-setup`). Returns the **raw email body, no redaction**. **Use this as the default**, and **always for magic-LINK verification** — the link's `?token=…`/`?qs=…` comes through intact so you can `navigate`/`playwright-cli goto` it.
- **`mcp__claude_ai_Gmail__*`** (`search_threads`, `get_thread`) — applies a **redaction layer** that **mangles secret-looking query-string tokens**. Codes in the body survive, but a **magic link comes back with its token replaced by a placeholder → unusable**. Treat as a **fallback for codes only**, never for links.
- The two servers **don't share message-ID namespaces** — always *search within the same server* you'll read from; don't pass one server's id to the other.

**CRITICAL — what mailbox you're reading (don't get confused):** `testing@whalesync.com` is a **group / forwarding address** — mail sent to it is forwarded to team members, including **your own `@whalesync.com` account** that `gmail-whalesync` is connected to. You do **not** log into `testing@whalesync.com` directly; you read the **work mailbox** that receives the forwarded copy. So search `gmail-whalesync` and the verification emails appear there (often `from:testing@whalesync.com` because of the forwarding).

**How to clear the gate (wire into step 4):**
1. Submit the signup, then **immediately** (codes expire in ~10 min) search the mailbox, e.g. `gmail-whalesync__search_emails("verification newer_than:5m")` or `from:atlassian` / `seatable`. Take the **newest** match, then `gmail-whalesync__read_email(<id>)` for the body.
2. **Code-based:** read the code from the body. **Codes are often ALPHANUMERIC, not just digits** — Atlassian's is a 6-char code like `5X4ZGR` (match `[A-Z0-9]{6}`), so don't assume `\d{6}`. **Link-based (magic link):** read the body via **`gmail-whalesync__read_email`** (NOT `claude_ai_Gmail`, which redacts the token), extract the confirm/verify URL, and `navigate`/`playwright-cli goto` it. The token is used by the browser but never needs to be parsed/echoed.
3. Enter the code: **JS-focus the first OTP box, then `playwright-cli -s=<svc> type "<CODE>"`** (auto-distributes across the boxes) — `fill`/`click` on the individual boxes are unreliable here; `type` into a focused field works. Click Verify.
4. Continue the run. Only fall back to a human if no email arrives within a timeout, or a captcha/2FA also blocks.

This is what makes **fully hands-off batch runs** possible. Note some flows (Atlassian) verify the **code first and set the password AFTER** — so enter `<SVC>_PASSWORD` on the post-code step, not before (still generate it before opening the browser).
