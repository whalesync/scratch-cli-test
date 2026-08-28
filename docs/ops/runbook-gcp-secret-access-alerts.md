# Runbook: GCP Secret Manager Access Alerts

Guide for investigating the three Secret Manager **Data Access** security alerts that Google Cloud Monitoring posts to Slack **`#feed-gcp-alerts`**. All count **`AccessSecretVersion`** entries (Data Access audit-log entries) over a 10-minute window. This is the detective control Oneleet asked for in **DEV-10989 / WSG-008**.

- **Secret access spike** (gross-volume, all principals) — fires when the total `AccessSecretVersion` count exceeds the threshold. A secret value is read at Cloud Run instance **startup** and then lives as a mounted env var, so most bursts are **benign** — a deploy or scale-up restarting containers — but the same signal surfaces a compromised principal reading secrets in bulk. The threshold sits above a full-fleet deploy, so a firing means a genuine bulk read. Runs in **eu-production and eu-test**.
- **Secret access by unexpected principal** (per-principal) — fires when a principal that is **not** on the allowlist reads any secret at even low volume. The allowlist is the shared Cloud Run app SA (`cloudrun-service-account`) + the GitLab deploy SA (`gitlab-service-account`), plus anything in `secret_access_allowlisted_principals`. Since legitimate reads come only from those SAs, a match points at a leaked human credential or a rogue/compromised SA. A full-fleet deploy cannot trip it (deploy reads are all the app SA, excluded from the metric). The per-dev read-only SAs (`<alias>-readonly@wsv1-dev-identity.iam.gserviceaccount.com`) are **also excluded** — they read `READONLY_DB_PASSWORD` + `DB_HOST` on every `connect_to_gcp_db_readonly.sh` run, so ordinary read-only investigation no longer trips this — and are watched by the volume alert below instead. **Prod-only** — see the note below.
- **Read-only SA secret-access volume** (per-principal) — fires when a single per-dev read-only SA (matched by `developer_readonly_service_account_email_regex`) exceeds a **much higher** threshold (default 200 / 10-min). Those SAs read secrets routinely during read-only prod investigation, so this is deliberately set well above a heavy agent-driven session; a firing means abnormal volume that can indicate a **leaked/compromised read-only key**. **Prod-only.**

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (region `europe-west1`); the spike alert also runs in `spv1eu-test` |
| Audit-log name | `projects/<project>/logs/cloudaudit.googleapis.com%2Fdata_access` (Data Access) |
| Spike alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `google_logging_metric.secret_access_count` + `google_monitoring_alert_policy.secret_access_spike_alert` |
| Unexpected-principal alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `google_logging_metric.secret_access_unexpected_principal_count` + `google_monitoring_alert_policy.secret_access_unexpected_principal_alert` |
| Read-only-SA volume alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `google_logging_metric.secret_access_readonly_sa_count` + `google_monitoring_alert_policy.secret_access_readonly_sa_volume_alert` |
| Audit-config posture | [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf) — `google_project_iam_audit_config.data_access_full` (`secretmanager.googleapis.com`, `DATA_READ` + `DATA_WRITE`) |
| Spike threshold | `var.secret_access_alert_threshold` (default **600** `AccessSecretVersion` entries / 10-min window, all principals) |
| Unexpected-principal threshold | `var.secret_access_unexpected_principal_threshold` (default **10** reads / 10-min window, **per principal**, non-allowlisted **and non-read-only-SA** only) |
| Read-only-SA volume threshold | `var.secret_access_readonly_sa_threshold` (default **200** reads / 10-min window, **per principal**, read-only SAs only) |
| Allowlist | `local.secret_access_allowlisted_principals` = app SA + GitLab deploy SA + `var.secret_access_allowlisted_principals` |
| Read-only SA pattern | `var.developer_readonly_service_account_email_regex` (default `-readonly@wsv1-dev-identity\.iam\.gserviceaccount\.com$`) — excluded from the unexpected-principal metric, scoped by the volume alert |
| Slack channel | `#feed-gcp-alerts` |
| Notification | Cloud Monitoring → Slack + email. Severity **WARNING** (no PagerDuty). Auto-closes after 7 days; renotifies every 6 h |

> The Secret Manager Data Access audit config is applied in every environment (audit.tf, ungated). The **spike** alert (`var.enable_secret_access_alerts`) runs in both eu-production and eu-test — its threshold sits above a full-fleet deploy, so test's routine reads don't trip it. The **unexpected-principal** alert (`var.enable_secret_access_unexpected_principal_alert`) and the **read-only-SA volume** alert (`var.enable_secret_access_readonly_sa_alert`) are both **prod-only** because eu-test reads test secrets routinely under the read-only SA and dev identities (`grant_readonly_sa_all_secrets` + dev cloudrun-SA impersonation), which would spam them. Routine readers in prod are the Cloud Run runtime SA (`cloudrun-service-account`) at container start, the GitLab deploy SA during a terraform apply, and — during read-only investigation — the per-dev `<alias>-readonly` SAs reading `READONLY_DB_PASSWORD` + `DB_HOST`. The first two are allowlisted (excluded from the unexpected-principal metric and unmonitored for volume); the read-only SAs are excluded from the unexpected-principal metric but volume-watched by the read-only-SA alert.

## Prerequisites

- `gcloud` CLI authenticated. **Reading these Data Access logs needs `roles/logging.privateLogViewer`** — the per-dev read-only SA has only `roles/logging.viewer`, so it can read Admin Activity logs but returns **zero** rows for Data Access logs (silently, no error). Use a `role_operations@whalesync.com` admin identity for the `gcloud logging read` steps below, or inspect the metric directly in Cloud Monitoring (Metrics Explorer / the incident page), which needs no log-read permission.
- **Every `gcloud` command must pass both** `--project=spv1eu-production` **and** `--billing-project=spv1eu-production`. Without the billing project you hit a misleading `SERVICE_DISABLED` error (the read-only SA's quota home project doesn't have the Logging API enabled).

## Investigation

Work top to bottom; stop once you have a confident verdict.

### 1. Read the firing alert

Open the Slack message in `#feed-gcp-alerts` and the Cloud Monitoring incident page it links. Note the **firing window** (convert the Slack timestamp to UTC).

### 2. Pull the secret-access entries for the window

```bash
START=2026-08-20T16:30:00Z
END=2026-08-20T16:50:00Z

gcloud logging read \
  "logName=\"projects/spv1eu-production/logs/cloudaudit.googleapis.com%2Fdata_access\" AND
   protoPayload.serviceName=\"secretmanager.googleapis.com\" AND
   protoPayload.methodName:\"AccessSecretVersion\" AND
   timestamp>=\"$START\" AND timestamp<=\"$END\"" \
  --project=spv1eu-production --billing-project=spv1eu-production \
  --order=asc --limit=1000 --format=json > /tmp/secret-access.json
jq 'length' /tmp/secret-access.json
```

Roll up the acting principals and which secrets were read:

```bash
jq -r '.[].protoPayload.authenticationInfo.principalEmail' /tmp/secret-access.json | sort | uniq -c | sort -rn
jq -r '.[].protoPayload.resourceName' /tmp/secret-access.json | sort | uniq -c | sort -rn
```

### 3. Attribute the actor

- **The Cloud Run runtime SA** (`cloudrun-service-account@spv1eu-production.iam.gserviceaccount.com`) reading its mounted secrets, correlated with a deploy / scale event / revision rollout in the window → **benign**. If a routine deploy recurringly trips it, raise `secret_access_alert_threshold`.
- **A known human developer** doing expected break-glass work (e.g. `gcloud secrets versions access` while debugging), confirmed intended → benign.
- **An unexpected principal** — an unfamiliar SA, an external account, or any principal that is not the runtime SA reading secrets in bulk (especially `ENCRYPTION_MASTER_KEY` or `DB_PASS`) → **escalate**.

## Deciding benign vs malicious

**Benign** — the burst attributes to the runtime SA at container start (matches a deploy/scale event) or to a known human doing confirmed work.

**Malicious / suspicious** — an unexpected principal, bulk reads across many secrets, or reads of the highest-value secrets (`ENCRYPTION_MASTER_KEY`, `DB_PASS`) by anything other than the runtime SA.

## Remediation

- **Benign, recurring deploy trips the spike alert** — raise `secret_access_alert_threshold` in [`variables.tf`](../../terraform/modules/env/variables.tf) and open an MR. Do **not** `terraform apply`; that stays with whoever owns the deploy.
- **Unexpected-principal alert, but the access was intended** (a break-glass admin or a CI job you can confirm) — add that principal's bare email to `secret_access_allowlisted_principals` in the relevant env (e.g. [`eu-production.tf`](../../terraform/envs/eu-production/eu-production.tf)) and open an MR. Never allowlist a whole domain — a leaked human credential is exactly what this alert exists to catch. (Note: the per-dev `<alias>-readonly` SAs are already excluded by `developer_readonly_service_account_email_regex`; do **not** add them here — that would leave them unmonitored. They are covered by the volume alert instead.)
- **Read-only-SA volume alert** — identify the named `<alias>-readonly` principal and correlate with known read-only investigation work (an agent or developer running `connect_to_gcp_db_readonly.sh production` heavily). If it is confirmed legitimate but the alert keeps firing on normal use, raise `secret_access_readonly_sa_threshold` in [`variables.tf`](../../terraform/modules/env/variables.tf) and open an MR. If the volume does **not** correspond to known work, treat the read-only key as compromised: rotate `READONLY_DB_PASSWORD`, revoke/rotate that dev's `<alias>-readonly` SA key (managed in Google Workspace / the `wsv1-dev-identity` project), and follow the **Malicious** steps below.
- **Malicious** — do **not** contain it from a read-only session. Preserve evidence (keep `/tmp/secret-access.json`), escalate to a `role_operations@whalesync.com` admin, **rotate the accessed secrets** (and `ENCRYPTION_MASTER_KEY` / DB creds if touched), and scaffold an incident report with the `create-incident-report` skill.

## Related

- Alert + audit-config definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf), [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf)
- Sibling security runbook: [`runbook-gcp-config-change-spike.md`](runbook-gcp-config-change-spike.md)
- Cost guardrail on the audit-log volume: [`runbook-gcp-log-ingestion-high.md`](runbook-gcp-log-ingestion-high.md)
- Incident reports: [`docs/ops/incidents/`](incidents/)
