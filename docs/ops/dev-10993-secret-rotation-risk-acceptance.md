# DEV-10993 / WSG-012 — Secret Manager automatic rotation: risk acceptance

**Finding:** Oneleet penetration test, WSG-012 ([Linear DEV-10993](https://linear.app/whalesync/issue/DEV-10993)), severity **Low**. Production secrets in Google Cloud Secret Manager (`spv1eu-production`) have no automatic rotation configured — no rotation schedule, no next-rotation time, no rotation Pub/Sub topics. The affected secrets include database passwords, the Redis password, the app credential-encryption key, Clerk / Stripe / SendGrid / PostHog / PagerDuty keys, AI-provider keys, and the connector OAuth client secrets.

**Decision:** **Accept the risk.** We will not build automatic rotation. We keep the existing on-demand rotation tooling, document its full rotation path (including the redeploy step that a value change alone does not trigger — see [`runbook-manage-secrets.md`](/docs/ops/runbook-manage-secrets.md)), and commit to a documented manual rotation cadence for the highest-value secrets (below).

**Owner:** Chris Hoefgen. **Date:** 2026-08-26. **Environment:** `spv1eu-production` (GCP).

This is the Scratch twin of the Whalesync finding **DEV-10979**, accepted the same way in Whalesync MR [!8684](https://gitlab.com/whalesync/whalesync/-/merge_requests/8684). Scratch's controls differ from Whalesync's in a few places; those differences are called out honestly below rather than copied.

---

## Current state

The finding is accurate: no secret has a scheduled rotation. Secret **containers** are declared from [`terraform/secrets.txt`](/terraform/secrets.txt) (one name per line, 64 entries) via a `for_each` in [`terraform/modules/env/secrets.tf`](/terraform/modules/env/secrets.tf), plus two more declared directly in Terraform (`DB_PASS` in [`modules/env/main.tf`](/terraform/modules/env/main.tf), `OTEL_COLLECTOR_CONFIG` in [`modules/env/otel_collector.tf`](/terraform/modules/env/otel_collector.tf)) — **66 containers in production**. Every one uses `replication { auto {} }` with **no rotation block, no `next_rotation_time`, and no rotation topics**. (~46 held a populated version at the pentest scan; the remainder are managed containers whose values are set out-of-band.)

What we do have:

- **On-demand rotation tooling.** [`terraform/tools/update_secret_value.sh <test|production> <name> <value>`](/terraform/tools/update_secret_value.sh) validates the name against `secrets.txt`, prints current-vs-new, prompts, and writes a new version (`gcloud secrets versions add`). Supporting scripts: `add_secret.sh`, `remove_secret.sh`, `get_secrets.sh`, `check_env_secrets.sh`. The lifecycle is documented in [`runbook-manage-secrets.md`](/docs/ops/runbook-manage-secrets.md).

- **Rotation is safe at runtime, but the redeploy is manual.** All four Cloud Run services (`api`, `client`, `cron`, `worker`) read every secret as an env var at container start with `version = "latest"` ([`terraform/modules/env/services.tf`](/terraform/modules/env/services.tf)); the server has **no in-process Secret Manager client**, so secrets only ever arrive as `process.env`. A newly written version therefore does **not** reach running instances until a redeploy. The redeploy is the `force_reload_services` toggle: `terraform apply -var force_reload_services=true` mints a fresh UUID, which rolls a new Cloud Run revision that re-reads all `latest` secrets (rolling, zero extra downtime). Nothing does this on a schedule. **A rotation is two steps: write the new version, then force-reload** — now documented as the canonical path in the runbook.

- **Credential encryption is a single static key (no rollover window).** Connector credentials are encrypted with AES-256-GCM under `ENCRYPTION_MASTER_KEY` ([`server/src/utils/encryption.ts`](/server/src/utils/encryption.ts)) and stored in Postgres (`ConnectorAccount.encryptedCredentials`, `PendingOAuthInstall.encryptedCredentials`). The ciphertext envelope is `{encrypted, iv, salt}` and carries **no key-version tag**, so rotating the master key requires a one-shot bulk re-encrypt of every row — there is no window in which old-key and new-key ciphertext coexist. The rollover pattern _does_ exist elsewhere in the codebase and could be mirrored later: connector OAuth app secrets are versioned (`ConnectorAccount.oauthAppVersion` + the `*_V2` env-var map in [`oauth-app-credential-resolver.service.ts`](/server/src/oauth/oauth-app-credential-resolver.service.ts)), and the admin API key supports a current+previous window in code (`SCRATCH_ADMIN_API_KEY` + an optional `SCRATCH_ADMIN_API_KEY_PREVIOUS` that is not currently provisioned as a secret).

- **No Cloud KMS / CMEK anywhere.** Unlike Whalesync, Scratch has no `google_kms_crypto_key` and no bucket CMEK, so there is no auto-rotating key material of any kind — the "master key" is itself a static Secret Manager secret. This is deliberate and documented in [`modules/env/audit.tf`](/terraform/modules/env/audit.tf).

---

## Why not automatic rotation

Most of these secrets are third-party credentials — Clerk, Stripe, SendGrid, PostHog, PagerDuty, Gemini, OpenRouter, LangSmith, Linear, GitHub, and roughly a dozen connector OAuth client secrets. Rotating them is a provider-side action. Secret Manager's native rotation only sends a timed Pub/Sub notification; it does not mint or install a new upstream credential. Real automatic rotation would require a separate rotation handler for each external provider, and several secrets cannot be rotated cleanly or at all:

- **`STRIPE_WEBHOOK_SECRET`** — needs the application to accept multiple signing secrets before the old one can be retired.
- **Several connector OAuth client secrets** — rotation is provider-dependent; not all developer consoles support it.
- **Database password / `DATABASE_URL` / `DB_PASS`** — require a coordinated new-user (or Cloud SQL root) swap; `DB_PASS` is Terraform-managed via `random_password`.
- **`ENCRYPTION_MASTER_KEY`** — needs multi-key support (bulk re-encrypt of stored credentials) that is not yet built.

The build and ongoing maintenance cost is high, and the marginal risk reduction over on-demand rotation plus the live detective controls below is low. For the case that actually matters — a _suspected_ exposure — on-demand rotation already lets us remediate immediately.

---

## Compensating controls

The risk the finding raises is a credential staying valid indefinitely after an exposure. Several controls already reduce that:

- **Secret-access audit logging + alerting (DEV-10989 / WSG-008).** Secret Manager `DATA_READ`/`DATA_WRITE` audit logs are on in every environment ([`modules/env/audit.tf`](/terraform/modules/env/audit.tf)). Production additionally alerts on a **secret-access spike** (`enable_secret_access_alerts`) and on **any non-allowlisted principal reading a secret** (`enable_secret_access_unexpected_principal_alert`), with a log-ingestion cost guardrail ([`envs/eu-production/eu-production.tf`](/terraform/envs/eu-production/eu-production.tf)). A leaked credential used against Secret Manager is detected even at low volume.
- **Least-privilege on the human / read-only path.** Production does **not** grant the read-only group project-wide secret access (`grant_readonly_sa_all_secrets` is test-only), and the laptop-default read-only service accounts omit `secretmanager.*` entirely — a leaked read-only key cannot read secret payloads in prod.
- **On-demand rotation** means a suspected exposure can be remediated in two documented commands (write version + force-reload), with no scheduled-rotation machinery to maintain.
- **Cheap secrets already rotate cleanly.** Connector OAuth app secrets rotate per-app-version affecting only new connections; the admin API key supports a current+previous rotation window in code.
- **Incident response already prescribes rotation.** [`runbook-gcp-secret-access-alerts.md`](/docs/ops/runbook-gcp-secret-access-alerts.md) directs the responder to rotate the accessed secrets (and `ENCRYPTION_MASTER_KEY` / DB creds if touched) on a malicious-access alert.
- **Related hardening:** Cloud Run ingress lockdown (DEV-10984), assets-bucket access review (DEV-10982), and the org-policy guardrail analysis (DEV-10986).

**Known gaps (stated, not hidden):** the app runtime service account holds a project-wide `roles/secretmanager.secretAccessor` (both envs, by explicit choice in [`modules/env/custom_roles.tf`](/terraform/modules/env/custom_roles.tf)); tightening it to per-secret bindings is a possible later step. There is no `rotate_secret.sh` orchestrator and no per-secret provider instructions — rotation is a value-write primitive plus a manual force-reload. Neither gap blocks the manual cadence below.

---

## Manual rotation cadence

In place of automation, we commit to periodic manual rotation of the highest-value secrets, executed per [`runbook-manage-secrets.md`](/docs/ops/runbook-manage-secrets.md) (write a new version, then `force_reload_services`) and tracked as a recurring ops task.

- **Every 6 months, or immediately on suspected exposure:** `DATABASE_URL` / `DB_PASS` / `READONLY_DB_PASSWORD` / `MIGRATIONS_DB_PASSWORD`, `REDIS_PASSWORD`, `CLERK_SECRET_KEY`, `STRIPE_API_KEY`, `SCRATCH_ADMIN_API_KEY`, `SCRATCH_GIT_AUTH_TOKEN`, `SENDGRID_API_KEY`.
- **On staff offboarding or suspected exposure only:** the connector OAuth client secrets, `POSTHOG_API_KEY` / `POSTHOG_FEATURE_FLAG_API_KEY`, `PAGERDUTY_INTEGRATION_KEY`, the AI-provider keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `LANGSMITH_API_KEY`), `LINEAR_API_KEY`, `GITHUB_RELEASES_TOKEN`, and `SLACK_NOTIFICATION_WEBHOOK_URL`.
- **Special / non-simple (do not treat as a plain value swap):**
  - `ENCRYPTION_MASTER_KEY` — high value, but rotation is a bulk re-encrypt migration of stored credentials with no rollover window; schedule it as planned maintenance, not an ad-hoc rotation. (Multi-key support is a follow-up.)
  - `STRIPE_WEBHOOK_SECRET` — blocked until the app accepts multiple signing secrets.
  - Any connector whose provider does not support client-secret rotation.

---

## Follow-ups (not committed here; captured for later)

- Tighten the app runtime SA from project-wide `secretAccessor` to per-secret bindings.
- Add `ENCRYPTION_MASTER_KEY` multi-key / rollover support (mirror the OAuth-app-version and admin-key patterns already in the codebase), which would let it rotate without a bulk re-encrypt migration.
- If the manual cadence proves burdensome, add a `rotate_secret.sh` orchestrator (drift/clean-git gate + auto force-reload) and per-secret provider instructions.
