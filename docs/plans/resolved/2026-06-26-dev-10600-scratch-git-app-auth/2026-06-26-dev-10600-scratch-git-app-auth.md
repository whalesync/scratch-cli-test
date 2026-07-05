# DEV-10600 — App-level auth for the scratch-git manage/write REST API

**Status:** Resolved — all three MRs (MR1 lenient receiving end + terraform, MR2 server
presents the token, MR3 strict enforcement) are landed and **deployed to prod**. Token
activated durably on both scratch-git VMs (Option B recreate). Both envs boot
`configured (enforcing)`; server↔git shows 0 `401`s (legit traffic unaffected). **Acceptance
verified in prod 2026-07-05**: a `gcp-ro` read-only SA port-forwarding to `:3100` gets `401`
on a manage endpoint (no token → 401, wrong token → 401), while `/health` stays `200` — a
read-only credential can no longer mutate a repo, and the `sudo gitops-*` read-only wrappers
are unaffected.
**Linear:** [DEV-10600](https://linear.app/whalesync/issue/DEV-10600) (High, S)
**Author:** Curtis Fonger

## Problem

The scratch-git microservice (Rust, on the GCE VM) exposes its REST API on `:3100`
(manage/write) and a git smart-HTTP backend on `:3101` with **no application-layer
authentication** — it authorizes purely by network position. Anyone who can reach the
ports can call any endpoint, read or write: `fsck`/`repair`/`reset`/delete-repo, write/
delete files, rename folders, and `git-receive-pack` (push) on `:3101`.

It is **not** internet-exposed (the VM has no public IP; the firewall opens 3100/3101
only to the VPC CIDR + GCP health-check ranges). The real gap is **least-privilege**:
the per-dev read-only `gcp-ro` service accounts (`group:role_readonly_sa@whalesync.com`)
have IAP + OS-Login on the VM (granted in DEV-10366 for read-only inspection), so they
can open an SSH tunnel, `-L`-forward `:3100`/`:3101`, and issue **unauthenticated
mutating** calls. A credential intended to be read-only can destroy every connection's
git repo (all user content) in prod.

## Goal

Require a **shared bearer token** on the scratch-git `:3100` manage/write API **and** the
`:3101` git smart-HTTP backend. The NestJS server (the only legitimate caller) holds the
token and presents it; the git service rejects unauthenticated/invalid calls with `401`.
`/` and `/health` stay open (deploy health probe + GCP TCP checks). A `gcp-ro` principal
port-forwarding to the ports can no longer mutate a repo; read-only inspection via the
`sudo gitops-*` wrappers (on-disk `git`, not HTTP) is unaffected.

## Design

### Topology (verified)

- **Only the NestJS server calls scratch-git.** CLI / desktop / web all go through the
  server (`API-Token` auth) — the server proxies git smart-HTTP at
  `/cli/v1/workbooks/:id/.../git/*` to `:3101` and calls `:3100` via `ScratchGitClient`.
  Laptops can't even route to the VM (no public IP). So the token is a **server↔scratch-git
  internal credential**; clients are insulated and need no change.
- `:3100` has a **single client chokepoint**: every `ScratchGitClient` method funnels
  through `callGitApi()` (`server/src/scratch-git/scratch-git.client.ts:73`).
- `:3101` is reached only through `proxyToGitBackend()`
  (`server/src/cli/cli-workbook.controller.ts:272`, three proxy routes).
- The server runs as three Cloud Run services (`api`, `worker`, `cron`) — **all three**
  call scratch-git, so all three must present the token.
- On the VM, nginx (`scratch-git-proxy`) fronts `:3100`/`:3101` and blue/green-routes to
  the app slots. nginx **passes `Authorization` through** (it only adds Host/X-Forwarded-For),
  so enforcement in the Rust app works behind the proxy. `deploy.sh`'s health probe hits
  the app's `/health` directly (must stay exempt). The GCP health check is a bare TCP
  connect on `:3100` (no HTTP — unaffected).

### Enforcement is gated on the token being configured

The Rust service reads `SCRATCH_GIT_AUTH_TOKEN`:

- **Not configured** (unset/empty) → **no auth at all** (today's behavior). This keeps
  local dev, `cargo test`, and the smoke-test Docker stack working with zero config, and
  makes the code a true no-op in prod until ops populates the secret.
- **Configured** → enforce (lenient in MR1, strict in MR3 — see rollout).

The server reads the same env var name and attaches `Authorization: Bearer <token>` to
every scratch-git call **only when configured** (else sends nothing).

Because each side independently no-ops without the var, the code can land with no behavior
change; ops enables it later by populating the secret and setting the var.

### Token comparison

Constant-time: SHA-256 both the provided and expected token (fixes the compare length so
it doesn't leak the secret length) and compare the 32-byte digests with an XOR accumulator.
`sha2` is already a dependency — no new crate.

## Rollout — three MRs, deployed to prod in order

Split so each deploy is independently safe and the wiring is proven end-to-end *before*
any request is rejected.

### MR1 — Receiving end (lenient) + all terraform/runbook/plan  ← this MR

scratch-git middleware on **both `:3100` and `:3101`**:

| Service token | Request `Authorization` | MR1 result |
| --- | --- | --- |
| not configured | (any) | allow (legacy) |
| configured | absent | **allow** (lenient — callers don't send it yet) |
| configured | present & correct | allow |
| configured | present & wrong/garbage | **401** |

`/` and `/health` always exempt.

Also in MR1: the secret declaration, IAM, VM injection, Cloud Run injection (api+worker+
cron), this plan, and the runbook. Landing MR1 + populating the secret puts the service
into lenient mode — but since no caller sends a token yet, every server call has no header
→ allowed. No breakage.

### MR2 — Callers send the token

Server attaches `Authorization: Bearer <token>` in `callGitApi()` and `proxyToGitBackend()`
(gated on the env var). After deploy, all legit traffic carries a valid token and the
service validates it leniently — proving the wiring before we enforce. Unauthenticated
attackers are still allowed at this stage (gap still open mid-rollout).

### MR3 — Enforce (strict)

Flip the middleware's "request with no `Authorization`" branch from **allow** to **401**
on both ports. By now every caller (MR2, deployed + verified) sends a valid token, so only
unauthenticated/invalid callers are rejected. Gap closed.

| Service token | Request `Authorization` | MR3 result |
| --- | --- | --- |
| not configured | (any) | allow (legacy — non-prod) |
| configured | absent | **401** |
| configured | present & correct | allow |
| configured | present & wrong | **401** |

Rollback if a caller was missed: redeploy MR2's scratch-git binary (lenient) — instant
revert to non-rejecting without touching the secret.

## Operational runbook

### One-time secret setup (before/with MR1 deploy)

The token is generated **out-of-band** and stored as a normal Secret Manager secret — it is
**not** placed in terraform state. In prod, `gcp-ro` cannot read it (no
`secretmanager.secrets.list`, no project-wide accessor; only `READONLY_DB_PASSWORD` +
`DB_HOST` are granted). ⚠️ In **eu-test**, `grant_readonly_sa_all_secrets = true` lets
`gcp-ro` read *all* test secrets — so use a **distinct, test-only** token value there; the
design must not depend on test-secret secrecy.

Per env (`eu-test`, then `eu-production`):

1. **Declare the secret** (already in `secrets.txt` via this MR). Create the empty secret:
   `terraform apply --target 'module.<env>.google_secret_manager_secret.required'`
2. **Add a value** (per env, distinct values):
   `openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add SCRATCH_GIT_AUTH_TOKEN --data-file=- --project=spv1eu-<env>`
   The `tr -d '\n'` is required: `openssl rand` emits a trailing newline, and Cloud Run's
   `secret_key_ref` injects the payload **verbatim** (no trim), so without it the server would
   present `Bearer <token>\n` in MR2 and fail the match (the Rust side trims, so the expected
   token has no newline). (Cloud Run's `secret_key_ref { version = "latest" }` also needs a
   version to exist before the service can reference it.)
3. **Full `terraform apply`** — grants IAM (VM SA), wires the env into Cloud Run (api/worker/
   cron) and into the VM scripts. The VM `deploy.sh`/`startup.sh` fetch is tolerant of a
   missing secret (`|| echo ""`), so apply ordering can't hard-fail a scratch-git deploy.

### Rollout progress

- **eu-test secret**: ✅ created + value added (2026-06-27). Verified: 64 bytes, no trailing
  newline. IAM grant + Cloud Run/VM wiring NOT yet applied (come with the MR1 deploy).
- **eu-production secret**: ✅ created + value added (2026-06-27, distinct value). gcp-ro
  `versions.access` is correctly DENIED (token out of read-only reach — the core requirement).
  Byte length verified out-of-band by the operator (`wc -c` = 64). IAM grant + wiring come
  with the MR1 deploy.
- **MR1 + MR2 code**: ✅ on master, deployed to prod via CI. Both Cloud Run token wiring
  (api/cron/worker) is applied in **both** envs (`terraform apply` done 2026-07-02), so the
  server presents the token.
- **Token activation on the scratch-git VM** — this is the step CI does NOT do (the VM's
  `deploy.sh`/`startup.sh` are frozen by `lifecycle.ignore_changes`, so the on-disk deploy
  script must be updated + the container restarted per env). Status:
  - **eu-test**: ✅ **activated + validated 2026-07-02** via Option A (scp updated `deploy.sh` →
    blue/green redeploy). scratch-git boots `configured (MR1 lenient)`, server sends the token,
    **0 `401`s** = token matches end-to-end.
  - **eu-production**: ✅ **activated + DURABLE + validated 2026-07-03** via Option B
    (`terraform apply -replace` of the instance — recreated VM bakes the token into `startup.sh`,
    survives reboots). Both slots boot `configured (MR1 lenient)`; server sends the token;
    **0 `401`s** = token matches end-to-end. Data disk (repos) survived the recreate.
- **Durability (Option B)**:
  - **eu-production**: ✅ done (the recreate above).
  - **eu-test**: ✅ done 2026-07-02 (VM recreated ~23:25 UTC; both slots boot `configured`,
    0 `401`s over 6h). Durable in both envs now.
- **MR3** (flip lenient→strict): ✅ landed + **deployed to prod**. Both envs boot
  `configured (enforcing)` (test build @2026-07-05 15:30, prod build `761b46ee`/`latest`
  @2026-07-03 22:20). **Acceptance verified in prod 2026-07-05** via a `gcp-ro` IAP
  port-forward to `:3100`: `/health` → `200`; manage `fsck` with no token → `401`; with a
  wrong token → `401`. Server-side `401`s = 0 in both envs (legit traffic unaffected).
  DEV-10600 acceptance criteria met.

### Deploy order (the safety-critical part)

1. **MR1** → merge + deploy. Cloud Run picks up the env (unused by MR1 server code). The VM
   gets the token on its next scratch-git image deploy (CI `deploy.sh`) → lenient mode. All
   server calls have no header → allowed. **Verify:** an unauthenticated `curl` to a manage
   endpoint still succeeds (lenient); a `curl` with a *wrong* bearer returns 401.
2. **MR2** → merge + deploy. Server now sends the token. **Verify:** server end-to-end
   (pull/publish/sync/repair) works; scratch-git logs show authenticated calls.
3. **MR3** → merge + deploy. Strict mode. **Verify (acceptance criteria):**
   - Unauthenticated `curl` to a `manage`/`write` endpoint (and a `:3101` git op) → **401**.
   - Server end-to-end still works (pull/publish/sync/repair).
   - A `gcp-ro` IAP port-forward to `:3100` **cannot** mutate a repo; `sudo gitops-*`
     read-only inspection unaffected.

## Files

### MR1 (this MR)

- `scratch-git-2/src/service/config.rs` — read `SCRATCH_GIT_AUTH_TOKEN` (trim, empty→None).
- `scratch-git-2/src/service/mod.rs` — `require_auth` middleware (lenient) layered on both
  routers via `from_fn_with_state`; `bearer_tokens_match` (SHA-256 constant-time); tests.
- `scratch-git-2/docs/README.md` — document the new env var.
- `terraform/secrets.txt` — add `SCRATCH_GIT_AUTH_TOKEN`.
- `terraform/modules/scratch_git_gce/main.tf` — grant the VM SA `secretAccessor`.
- `terraform/modules/scratch_git_gce/scripts/startup.sh` + `scripts/deploy.sh` — tolerant
  fetch + `-e SCRATCH_GIT_AUTH_TOKEN` on both blue/green containers.
- `terraform/modules/env/services.tf` — add the secret to api + worker + cron env lists.
- `docs/plans/2026-06-26-dev-10600-scratch-git-app-auth/2026-06-26-dev-10600-scratch-git-app-auth.md` — this doc.

### MR2 (later)

- `server/src/config/scratch-config.service.ts` — `getScratchGitAuthToken()`. **`.trim()` the
  value** defensively (Cloud Run injects the secret payload verbatim) so a stray trailing
  newline in the stored secret can't produce `Bearer <token>\n`.
- `server/src/scratch-git/scratch-git.client.ts` — attach header in `callGitApi()`.
- `server/src/cli/cli-workbook.controller.ts` — attach header in `proxyToGitBackend()`.
- `server/.env.example` — document `SCRATCH_GIT_AUTH_TOKEN`.

### MR3 (later)

- `scratch-git-2/src/service/mod.rs` — flip lenient → strict (no/invalid token → 401);
  update tests.

## Out of scope

- Root-causing how the `dirty` branch loses objects mid-sync/publish (separate).
- Per-caller identity auth (a raw SSH `-L` tunnel forwards TCP, not identity — a shared
  service token is the realistic design).
