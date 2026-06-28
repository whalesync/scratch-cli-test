# Local read-only access for laptops & AI agents — Spinner (spv1eu)

**Status:** In Progress · **Author:** Curtis Fonger · **Linear:** [DEV-10401](https://linear.app/whalesync/issue/DEV-10401/local-read-only-gcp-access-for-spinner-spv1eu-laptops-and-ai-agents) (High) · **MR:** [!2697](https://gitlab.com/whalesync/spinner/-/merge_requests/2697)

Sibling of the whalesync effort [DEV-10397](https://linear.app/whalesync/issue/DEV-10397/read-only-by-default-gcp-access-for-laptops-and-ai-agents). Same threat
(AI coding agents run on developer laptops with whatever `gcloud` / ADC credential is active; `curtis@whalesync.com` is
Org Owner, so an unsupervised agent inherits full admin on **production**), now applied to the **Spinner** GCP projects:
`spv1eu-test` and `spv1eu-production`.

## Goal

Make a developer's laptop **read-only by default** against the Spinner projects too — for both credential stores
`gcloud` uses (the **gcloud CLI** active account and **Application Default Credentials**), with **admin reachable on
demand** via an interactive `gcloud auth login` a headless agent cannot complete.

The whole point of this plan: **reuse the identity already built for whalesync.** Do not mint a new service account, a
new key, or new local `gcloud` config. The single change is on the Spinner Terraform side — bind the existing
org-level group to a read-only role set in the Spinner env module — and the laptop identity that already exists lights
up against `spv1eu-test`/`spv1eu-production` automatically.

## The reuse insight (why this is small)

The whalesync work (DEV-10397) created, per developer, an `<alias>-readonly` service account
(`curtis-readonly@wsv1-dev-identity.iam.gserviceaccount.com` — the SAs were moved into a dedicated, billing-free identity
project `wsv1-dev-identity` in whalesync MR 9, so a 30-day key-expiry org policy can apply there without touching any app
key) and granted it read access **through membership in the org-level Google Group `role_readonly_sa@whalesync.com`**,
not through per-project bindings. That group, its members, the laptop's JSON key (auto-expiring after 30 days), and the
`readonly`/`admin` `gcloud` configs (with `gcp-admin` / `gcp-ro` helpers) are **already in place**.

Both project sets live in the **same `whalesync.com` Cloud Identity org** — confirmed by the fact that the Spinner env
module already binds `group:role_operations@whalesync.com` and `group:role_developers@whalesync.com` in
`terraform/modules/env/main.tf`. A Google Group can be granted IAM on **any** project in the org, regardless of which
project the member SA happens to live in. So:

- The `curtis-readonly@wsv1-dev-identity…` SA is already a member of `role_readonly_sa@`.
- The moment the Spinner env module binds that group to a read-only role set, the **existing** laptop identity gains
  read on `spv1eu-test` and `spv1eu-production`.
- **Zero** new SA, key, or local config. The whalesync per-dev local setup (steps 3–5 of DEV-10397) is the local setup
  for Spinner too — there is nothing per-dev to redo.

This is the deliberate payoff of DEV-10397's "read access via a dedicated group, not per-project bindings" decision:
adding a whole second project family is a one-place Terraform change, and every already-onboarded dev is covered the
instant it applies.

## Design & key decisions

### Reuse the existing group + SAs; do NOT create Spinner-side SAs

We bind the **same** `role_readonly_sa@whalesync.com` group in the Spinner env module. We deliberately do **not** port
whalesync's `google_service_account.dev_readonly` / `var.dev_readonly_emails` machinery into this repo: that would mint
a *second* `curtis-readonly@spv1eu-production…` SA, a second key on the laptop, and a second `gcloud` config to switch —
all redundant. One SA per dev, org-wide, one key, reads everything. (If we ever want Spinner-resident SAs for blast-radius
isolation between the two project families, that's a future option; not now.)

### Same genuinely-read-only role set, defined once in the shared env module

Add a `readonly_sa_roles` local to `terraform/modules/env/main.tf` and bind it to the group in `principals_to_roles`.
Because both envs instantiate that one module, the binding applies to `eu-test` and `eu-production` from a single edit —
the "one knob" property. The set is the viewer/reader subset, mirroring whalesync:

```hcl
# Genuinely read-only roles for the org-level role_readonly_sa@ group — the default local gcloud/ADC identity on a
# laptop (the per-dev "<alias>-readonly" SAs from whalesync DEV-10397, reused here cross-project). Deliberately TIGHTER
# than developer_roles, which is NOT read-only: that set grants storage.objectUser (writes), run.developer (deploy),
# oauthconfig.editor, iam.serviceAccountUser (actAs/impersonation) and cloudsql.studioUser. We omit secretmanager.*
# entirely so a leaked read-only key cannot read secret payloads. Widen read-only access for everyone by adding a read
# role HERE — never a write/escalation role.
readonly_sa_roles = [
  "roles/browser",
  "roles/cloudsql.viewer",
  "roles/compute.viewer",
  "roles/storage.objectViewer",
  "roles/redis.viewer",
  "roles/artifactregistry.reader",
  "roles/run.viewer",
  "roles/monitoring.viewer",
  "roles/logging.viewer",
  "roles/vpcaccess.viewer",
  "roles/iam.roleViewer",
  "roles/errorreporting.viewer",
  "roles/aiplatform.viewer",
]
```

```hcl
principals_to_roles = {
  "group:role_operations@whalesync.com" : [local.terraform_roles, local.operations_roles],
  "group:role_developers@whalesync.com" : local.developer_roles,
  # Per-dev "<alias>-readonly" laptop SAs (members managed in Workspace; SAs minted in whalesync DEV-10397, reused here).
  "group:role_readonly_sa@whalesync.com" : local.readonly_sa_roles,
}
```

That's the entire **required** change. It is purely additive (one new principal × 13 roles per env, 0 change/destroy),
mirroring the whalesync apply.

### No secret payload access on the key

`readonly_sa_roles` omits `secretmanager.*` entirely. A leaked read-only key cannot read any Spinner secret payload;
reading one requires elevating to admin. (Contrast `developer_roles`, which grants `secretmanager.secretAccessor` +
`secretmanager.viewer`.)

### Elevation is unchanged — it's the same laptop tooling

`gcp-admin` (interactive `gcloud auth login --update-adc`) and `gcp-ro` (`gcloud auth revoke`, scrubbing the cached
admin token) already exist from DEV-10397 and are project-agnostic: once elevated, the human admin identity
(`curtis@`, Org Owner) has admin on the Spinner projects too. The security boundary remains the **deletion** of the
cached admin credential by `gcp-ro`, not the login flow. Nothing to add here.

### Read-only DB inspection (`connect_to_gcp_db_readonly.sh`) — implemented in MR !2697, with two Spinner-specific wrinkles

The repo already ships `terraform/tools/connect_to_gcp_db_readonly.sh`, which opens an IAP-tunnelled SSH to the
`cloudsql-proxy` bastion and connects with `psql` as the SELECT-only `readonly` Postgres user. Enabling it **for the
read-only SA** (so an agent can inspect a live DB) takes connect/login-only grants and **nothing that can mutate**:

- `secretmanager.secretAccessor` on **exactly two secrets**, `READONLY_DB_PASSWORD` and `DB_HOST` (per-secret IAM, never
  project-wide). Spinner needs two — fewer than whalesync's four — because the script reads the host from a `DB_HOST`
  secret (terraform writes the primary instance's private IP to it) instead of the Cloud SQL Admin API, and hardcodes
  the user
  (`readonly`) and database (`scratchpad`).
- `iap.tunnelResourceAccessor` **scoped to the `cloudsql-proxy` instance**.
- `compute.osLogin` (non-sudo) **scoped to the instance**, plus flipping the bastion to OS Login. OS Login is required
  because the current `gcloud compute ssh` path writes an ephemeral key to *instance metadata* — a
  `compute.instances.setMetadata` write a read-only principal can't (and shouldn't) do.

**Spinner-specific wrinkle:** the Spinner `gce` module (`terraform/modules/gce/`) doesn't just lack an OS Login knob — it
**explicitly disables it**: `terraform/modules/gce/main.tf:38-41` hardcodes `enable-oslogin = "FALSE"` and
`block-project-ssh-keys = "true"`, and line 53 has `lifecycle { ignore_changes = [metadata["ssh-keys"]] }`. The bastion
is deliberately wired for the **instance-metadata SSH-key** model — the path `gcloud compute ssh` uses by default
(ephemeral key pushed into instance metadata per connect; the `ignore_changes` keeps Terraform from reverting it).

**This was a deliberate, security-driven setting — and it has a history Spinner inherited.** In whalesync the bastion
originally ran OS Login `"TRUE"` (recommended by a **pentest**), then commit `83ababfaf` (2025-07-17, "Disable OS Login
feature on cloudsql-proxy vm") flipped it to `"FALSE"` because OS Login *"appears to break the `--tunnel-through-iap`
feature of the gcloud cli."* Spinner's `gce` module is a copy of whalesync's **at that disabled state** (single setup
commit `f0b7cad8`, byte-identical `enable-oslogin = "FALSE"`), so Spinner carries the same pentest-era rationale, not a
fresh decision. whalesync's DEV-10397 then **re-enabled** OS Login (variable + `enable_oslogin = true` on the bastion)
and validated read-only DB inspection end-to-end through the IAP tunnel — proving OS Login and `--tunnel-through-iap`
**do** coexist. The 2025 "appears to break the tunnel" was almost certainly the `Permission denied (publickey)` symptom
that DEV-10397 root-caused to a **missing `iam.serviceAccountUser` (actAs) grant on the bastion SA**, not an OS Login /
IAP incompatibility.

**The lesson for Spinner step 4:** the actAs grant is not optional polish — it is the fix for the exact failure that got
OS Login rolled back in 2025. Grant `role_readonly_sa@` `iam.serviceAccountUser` on `cloudsql-proxy-service-account`
*in the same change* that flips OS Login on, or we reproduce the 2025 symptom.

The module change itself is the trivial DEV-10397 diff, applied to Spinner's now-identical module —
add an `enable_oslogin` bool to `terraform/modules/gce/variables.tf` and change `main.tf:40` to
`enable-oslogin = var.enable_oslogin ? "TRUE" : "FALSE"` — then set `enable_oslogin = true` on the bastion in
`terraform/modules/env/main.tf:275` (the `module "gce_instance"` block; it already outputs `instance_name`, which the
IAP-tunnel / osLogin IAM members need). The flip changes SSH auth
for **everyone** on that bastion, so — exactly as in whalesync — also grant the **operations** group `osAdminLogin` on
the instance as a lockout guard, grant the group `iam.serviceAccountUser` on `cloudsql-proxy-service-account` via the
iam-sa module's `service_account_users` (the actAs OS Login SSH needs), and roll out **test → prod**, verifying admin
SSH at each step.

**Second wrinkle — the SA's OS Login home project (no Spinner change needed).** OS Login provisions the SA's POSIX/SSH
profile in the SA's *home* project, so that project must have `oslogin.googleapis.com` enabled — for the reused SAs
that's `wsv1-dev-identity`, already enabled in whalesync MR 9 (the gotcha that surfaced there as `SERVICE_DISABLED` once
the SA moved out of prod). The **bastion's** project (`spv1eu-*`) does **not** need the API: whalesync applied the same
bastion flip across its envs without ever enabling `oslogin` in the env module, so MR !2697 adds no API enablement on the
Spinner side.

This widening is bounded and still strictly read-only. It and the read-only-by-default binding (step 2) landed together
in MR !2697; the rollout still applies them **test → prod**, verifying SSH at each step.

## MR / rollout sequence

Order matters less than whalesync because the group already exists — but the env-module binding (step 2) must land and
apply before the read-only identity can read Spinner.

| # | Step | Type | What it does | Status |
| - | ---- | ---- | ------------ | ------ |
| 1 | Reuse `role_readonly_sa@whalesync.com` + the existing `<alias>-readonly` SAs | ops (Workspace) | **Already done in DEV-10397** — group exists, `curtis-readonly@` is a member, laptop key + `readonly`/`admin` configs + `gcp-admin`/`gcp-ro` already set up. Nothing to create. | **Done (inherited)** |
| 2 | Terraform: bind the group to `readonly_sa_roles` in the Spinner env module | infra (terraform) | Add `readonly_sa_roles` local + `"group:role_readonly_sa@whalesync.com"` to `principals_to_roles` in `modules/env/main.tf`; applies to `eu-test` + `eu-production`. Apply **test → prod** (additive: +13 bindings/env, 0 change/destroy). | **Applied + validated 2026-06-11 (test + prod)** |
| 3 | Validate per dev | per-dev | As `curtis-readonly@`: `gcloud projects describe spv1eu-test`/`spv1eu-production` and `gcloud compute instances list` succeed; a write (`gcloud … delete`) and `gcloud secrets list` are denied. `gcp-admin` elevates; `gcp-ro` scrubs. | **Validated 2026-06-11 (test + prod): reads OK, write + secret-list denied; agent could NOT run plan/apply (read-only), human could** |
| 4 | Enable read-only DB inspection for the SA | infra (terraform) | Per-secret `secretAccessor` on `READONLY_DB_PASSWORD`; instance-scoped `iap.tunnelResourceAccessor` + `compute.osLogin`; **add `enable_oslogin` to the `gce` module** + set it on the bastion; group `iam.serviceAccountUser` on `cloudsql-proxy-service-account` (via `service_account_users`); `osAdminLogin` lockout guard for ops. Roll out **test → prod**, verifying admin SSH each step. | **Applied + validated 2026-06-11: DB inspection end-to-end as the read-only SA in test + prod (host from DB_HOST secret → OS Login SSH → IAP → readonly psql)** |
| 4.1 | Read-only SA reads ALL **test** secrets | infra (terraform) | `grant_readonly_sa_all_secrets = true` in `eu-test` only → project-wide `secretmanager.secretAccessor` for `role_readonly_sa@` in `spv1eu-test`, so devs/agents can run the Spinner server locally against test. **Never** in production (defaults `false`). | **Applied + validated in test 2026-06-11; confirmed ABSENT in prod (non-DB secrets denied there)** |
| 5 | Team rollout | ops/per-dev | Each teammate already onboarded to the whalesync read-only flow is **auto-covered** the moment step 2 applies (their SA is already in the group). A dev not yet onboarded does the one-time whalesync local setup once; Spinner is then free. | **After validation** |

## Risks

- **Read-only ≠ harmless.** A leaked `<alias>-readonly` key can now read **both** project families' data (DB rows via
  Cloud SQL, logs/PII, GCS objects) across test + prod. Mitigations unchanged: no secret payloads in the role set; key
  stored `0600` outside repos/agent workspaces; keys auto-expire after 30 days (whalesync MR 9) and rotate via
  whalesync's `tools/ops/rotate_readonly_sa_key.sh` (MR 8); the key grants no write/escalation.
- **Binding the group is low-risk here** (it already exists, de-risking whalesync's "unknown principal" rejection), but
  the apply still touches **production IAM** — review the plan is additive (+13 bindings, 0 destroy) before applying prod.
- **The OS Login flip (step 4) has a documented prior failure.** OS Login on this bastion was disabled in whalesync in
  2025 because it "appeared to break `--tunnel-through-iap`"; DEV-10397 re-enabled it and traced that symptom to a
  missing `iam.serviceAccountUser` (actAs) grant on the bastion SA. Mitigation: grant `role_readonly_sa@` actAs on
  `cloudsql-proxy-service-account` in the same change as the flip; keep the ops `osAdminLogin` lockout guard; roll out
  test → prod, verifying both admin SSH *and* read-only-SA SSH-through-IAP at each step before advancing.
- **Discipline on switch-back** (after `gcp-admin`, the powerful user ADC lingers until `gcp-ro`) is identical to
  whalesync and already documented in `docs/local-readonly-agent-setup.md` there.
- **Test-secret sensitivity (step 4.1 — now enabled).** `grant_readonly_sa_all_secrets = true` in `eu-test` gives the
  read-only SA EVERY `spv1eu-test` secret payload — materially broader than whalesync's "non-sensitive" assumption.
  Spinner's test set includes **write-capable DB creds** (`DATABASE_URL`, `MIGRATIONS_DB_USER`/`MIGRATIONS_DB_PASSWORD`),
  `SCRATCH_ADMIN_API_KEY`, `ENCRYPTION_MASTER_KEY` (decrypts stored connection credentials), and connector OAuth client
  secrets + AI/observability keys (`GEMINI`/`OPENROUTER`/`LANGSMITH`/`POSTHOG`/`LINEAR`). Two consequences this accepts:
  (a) "read-only" still holds on the GCP IAM plane, but the SA now holds **write** creds *inside test* (DB + admin API);
  (b) any secret whose value is **shared with prod** (some connector OAuth apps, org-wide AI keys) is effectively exposed
  via its test copy. **Reviewed and accepted:** Curtis confirmed (2026-06-11) the `spv1eu-test` secrets are test-scoped
  and acceptable to expose wholesale, so the whalesync-style blanket grant stands. Enabled in `spv1eu-test` only; never
  production.

## Exit criteria

- `role_readonly_sa@whalesync.com` is bound to `readonly_sa_roles` in `spv1eu-test` **and** `spv1eu-production`.
- A fresh laptop shell already authenticated as `curtis-readonly@` reads both Spinner projects with **no new local
  setup**; a representative write and `gcloud secrets list` are denied.
- `gcp-admin` restores full admin on the Spinner projects via interactive login; `gcp-ro` returns to read-only.
- This doc moves to `docs/plans/resolved/` once ≥1 other dev confirms Spinner reads work off their existing identity.

## Testing / validation

- `terraform validate` on `envs/eu-test` and `envs/eu-production`.
- After apply:
  `gcloud asset search-all-iam-policies --scope=projects/spv1eu-production --query='policy:role_readonly_sa'`
  shows the group bound to exactly the read-only roles.
- As the read-only SA: `gcloud projects describe spv1eu-test` / `spv1eu-production` and `gcloud compute instances list`
  succeed; `gcloud secrets list` and `gcloud compute instances delete …` are denied.
- (Step 4, per env after each apply) an **operations** member can still
  `gcloud compute ssh cloudsql-proxy --tunnel-through-iap` (no lockout from the OS Login flip); the **read-only SA** can
  run `terraform/tools/connect_to_gcp_db_readonly.sh <env> "SELECT 1;"` end-to-end; and the read-only SA still cannot
  read any non-DB secret.

## Open questions

- **Spinner-resident SAs ever?** Kept out for now (reuse the whalesync org-wide SAs via the group). Revisit only if we
  want blast-radius isolation between the `wsv1` and `spv1eu` project families on a per-key basis.
- **Add `secretmanager.viewer` (metadata only) to `readonly_sa_roles`?** Excluded, same as whalesync; cheap to add if
  listing secret *names* without elevating proves useful. Would apply to both project families at once.
- **Key rotation / expiry** is shared with whalesync — one key, org-wide: 30-day forced expiry via the
  `wsv1-dev-identity` org policy (MR 9) plus on-demand `tools/ops/rotate_readonly_sa_key.sh` (MR 8). No separate Spinner
  track.
- **`iam_service_accounts` `for_each` filter bug.** Spinner's module still uses `service_account_users != []` — the same
  latent bug whalesync fixed in `1dba84363` (→ `length(...) > 0`). It does **not** affect MR !2697's actAs grant (which
  has a non-empty `service_account_users`, so it's correctly included), but it can leave a spurious empty binding on the
  no-users `scratch-git-service-account`. Worth porting the one-line fix in a small follow-up.

## Resolved questions

- **New SA/key/config for Spinner, or reuse?** Reuse. Both project families are in the same `whalesync.com` org, the
  group binds cross-project, and the existing `curtis-readonly@` SA is already a member — so the laptop identity, key,
  and `gcloud` configs from DEV-10397 cover Spinner with a single Terraform binding and no per-dev work.
- **Per-project bindings or the group?** The group, mirroring DEV-10397 — that decision is exactly what makes adding a
  second project family a one-line, propagates-to-everyone change.
- **How many DB-inspection secret grants?** Two (`READONLY_DB_PASSWORD`, `DB_HOST`), not four: the script hardcodes the
  user + database, so those two are the only secrets it reads. **Originally one** (`READONLY_DB_PASSWORD`) with the host
  discovered via `gcloud sql instances list` — but that call returns `SERVICE_DISABLED` for the read-only SA, because
  gcloud bills the Cloud SQL Admin API to the SA's *home* project (the bare `wsv1-dev-identity`, which lacks that API),
  not the target project. Switched to sourcing the host from a `DB_HOST` secret (terraform writes the private IP),
  exactly as whalesync does — no Cloud SQL Admin API dependency, and no new IAM role on the read-only set.
- **Does whalesync MR 9 (SAs moved to `wsv1-dev-identity`) change anything here?** No code change. The reused SAs now
  live in a dedicated identity project (not `wsv1-production`) so 30-day key auto-expiry can apply without touching any
  app key. Spinner is unaffected because the binding targets the **group**, not the SA's email, and a group holds SAs
  from any project. The only ripple is OS Login's home-project API requirement (`oslogin.googleapis.com` on
  `wsv1-dev-identity`), already satisfied there — the bastion's own `spv1eu-*` project needs nothing.
- **How does the read-only SA run the server locally if it needs GCS writes?** The server's only GCP writes are GCS
  (asset rehosting `file.save()` + V4 signed URLs for `/upload-patch`); everything else is local docker / an API key /
  reads. It does those writes by **impersonating the cloudrun SA** (`GCS_LOCAL_SIGNING_SA` → the cloudrun SA holds
  `storage.objectAdmin` on both buckets), so the local identity needs **only `iam.serviceAccountTokenCreator` on the
  cloudrun SA** — not direct `storage.objectUser` or any other write role. Granted **test-only** by adding
  `role_readonly_sa@` to `cloudrun_service_account_token_creators` in `eu-test.tf` (mirrors what developers already
  had). Dropped the explicit `user:curtis@` there — local dev now runs as `curtis-readonly@` (in the group). Trade-off:
  in test the read-only SA can now impersonate the powerful cloudrun SA — developer-parity, test-only, **never in
  prod** — consistent with the accepted permissive-test posture (all-secrets). Not needed: `run.developer` (deploy is
  CI), `cloudsql.studioUser`, `oauthconfig.editor`, `aiplatform.expressUser` (Vertex isn't used; AI goes via the Gemini
  API key).
