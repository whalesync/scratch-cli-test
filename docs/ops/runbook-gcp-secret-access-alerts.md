# Runbook: GCP Secret Manager Access Spike Alert

Guide for investigating the **Secret access spike** security alert that Google Cloud Monitoring posts to Slack **`#feed-gcp-alerts`** for the EU-production project `spv1eu-production`. It fires when an unusually high number of Secret Manager **`AccessSecretVersion`** entries (Data Access audit-log entries) occur in a 10-minute window. A secret value is read at Cloud Run instance **startup** and then lives as a mounted env var, so most bursts are **benign** — a deploy or a scale-up restarting containers — but each one needs a look, because the same signal is what would surface a compromised principal reading secrets in bulk. This is the detective control Oneleet asked for in **DEV-10989 / WSG-008**.

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (region `europe-west1`) |
| Audit-log name | `projects/spv1eu-production/logs/cloudaudit.googleapis.com%2Fdata_access` (Data Access) |
| Alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `google_logging_metric.secret_access_count` + `google_monitoring_alert_policy.secret_access_spike_alert` |
| Audit-config posture | [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf) — `google_project_iam_audit_config.data_access_full` (`secretmanager.googleapis.com`, `DATA_READ` + `DATA_WRITE`) |
| Threshold | `var.secret_access_alert_threshold` (default **50** `AccessSecretVersion` entries / 10-min window) |
| Slack channel | `#feed-gcp-alerts` |
| Notification | Cloud Monitoring → Slack + email. Severity **WARNING** (no PagerDuty). Auto-closes after 7 days; renotifies every 6 h |

> The Secret Manager Data Access audit config is applied in every environment (audit.tf, ungated); this alert is **prod-only** (`var.enable_secret_access_alerts`) because eu-test reads test secrets routinely (`grant_readonly_sa_all_secrets` + dev cloudrun-SA impersonation). The only routine reader in prod is the Cloud Run runtime SA (`cloudrun-service-account`) at container start.

## Prerequisites

- `gcloud` CLI authenticated. The per-dev read-only service account is sufficient for `gcloud logging read`.
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

- **Benign, recurring deploy trips it** — raise `secret_access_alert_threshold` in [`variables.tf`](../../terraform/modules/env/variables.tf) and open an MR. Do **not** `terraform apply`; that stays with whoever owns the deploy.
- **Malicious** — do **not** contain it from a read-only session. Preserve evidence (keep `/tmp/secret-access.json`), escalate to a `role_operations@whalesync.com` admin, **rotate the accessed secrets** (and `ENCRYPTION_MASTER_KEY` / DB creds if touched), and scaffold an incident report with the `create-incident-report` skill.

## Related

- Alert + audit-config definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf), [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf)
- Sibling security runbook: [`runbook-gcp-config-change-spike.md`](runbook-gcp-config-change-spike.md)
- Cost guardrail on the audit-log volume: [`runbook-gcp-log-ingestion-high.md`](runbook-gcp-log-ingestion-high.md)
- Incident reports: [`docs/ops/incidents/`](incidents/)
