# connector-build

How we add new connectors to Scratch, mostly autonomously: an agent provisions a test
account on the service, then builds + exercises the connector end-to-end.

## Quick start (new teammate)
1. **Run `/connector-build-onboarding` once.** It verifies your browser (gstack and/or the
   Claude-for-Chrome extension) and the `gmail-whalesync` MCP, and tells you when you're ready.
   *(Assumes the Scratch dev env is already set up — repo, `yarn install`, Docker, DB+migrations,
   `scratchmd` built, server runnable, node 22.)*
2. **Pick the next connector** from [`queued-connectors.md`](./queued-connectors.md) — **Human Picks first**.
3. **`/connector-build-prepare <connector>`** — provisions a free test account, stores creds in
   `connector-build/.env.connector-build`, validates the API token. The run **tells you up front**
   whether it'll need you for a gate (see below).
4. **`/connector-build-execute <connector>`** — builds + tests the connector against that account.

## The gate rule (do I need to stick around?)
The first thing a prepare/execute run tells you:
- **"No gates — I'll work on my own"** → walk away.
- **"A gate is coming (e.g. a CAPTCHA); I'll open the page, you get ~1 min to pass it"** → stay for that one moment, then it's autonomous again.

Runs need the **machine awake** (a browser is always driven) — that's a requirement.

## Secrets
- Live in `connector-build/.env.connector-build` (gitignored). Building a *new* connector needs no
  existing secrets — but **after** provisioning, paste your new `CB_<SVC>_*` lines to the **bottom**
  of the 1Password note **"connector-build secrets"** so the team gets them.
- The `gmail-whalesync` OAuth (set up during onboarding) is in 1Password **"Gmail Auto-Label Desktop OAuth"**.

## The docs
| File | What |
|---|---|
| [`queued-connectors.md`](./queued-connectors.md) | the funnel — candidates not yet provisioned, scored, Human-Pick order |
| [`provisioned-connectors.md`](./provisioned-connectors.md) | finished provisioning, secrets stored + validated — build can begin |
| [`provisioning-notes/<service>.md`](./provisioning-notes/) | one record per provisioned service (account, creds, gates, quirks) |
| [`provisioning-runs/`](./provisioning-runs/) | one report per provisioning session (`YYYY-MM-DD-…-<person>-<success>-<all>.md`) |
| [`existing-connectors.md`](./existing-connectors.md) | cross-connector support table + build playbook (already-built connectors) |
| [`test-accounts-mechanism.md`](./test-accounts-mechanism.md) | how the secret store / login scripts / Gmail reader work |

## Skills
- `/connector-build-onboarding` — one-time setup check (run first).
- `/connector-build-prepare <connector>` — provision a test account.
- `/connector-build-execute <connector>` — build + test the connector.
- `/start-parallel-session <N>` — isolated server+Redis for running several at once (advanced).
