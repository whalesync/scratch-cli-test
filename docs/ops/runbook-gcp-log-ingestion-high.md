# Runbook: GCP Monthly Log Ingestion High

Guide for the **Monthly ingestion volume high** cost alert that Google Cloud Monitoring posts to Slack **`#feed-gcp-alerts`** for the EU-production project `spv1eu-production`. It fires when **month-to-date Cloud Logging ingestion** exceeds the threshold (default **300 GiB**). This is a **cost guardrail, not a security alert** — it was added alongside the Data Access audit logs (DEV-10989 / WSG-008) so that any unexpected growth in log volume is caught before it shows up on the bill.

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (region `europe-west1`) |
| Metric | `logging.googleapis.com/billing/monthly_bytes_ingested` (built-in GAUGE; month-to-date billable bytes, resets each calendar month) |
| Alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `google_monitoring_alert_policy.monthly_log_ingestion_alert` |
| Threshold | `var.log_ingestion_alert_threshold_gib` (default **300** GiB) |
| Slack channel | `#feed-gcp-alerts` |
| Notification | Cloud Monitoring → Slack + email. Severity **WARNING**. Notifies once; auto-closes when the metric resets at month start |

> Cloud Logging bills per GiB ingested into the `_Default` bucket, with the first **50 GiB/month free**. Admin Activity audit logs are free (`_Required` bucket) and don't count. The Data Access audit logs from WSG-008 were deliberately scoped (Secret Manager R/W, Cloud Storage **write-only** — no public-asset read firehose) to stay well inside the free tier, so a breach of this threshold usually means something *else* grew.

## Investigation

### 1. Confirm current month-to-date volume

Cloud Console → **Logging → Log Router → Bytes ingested** (or **Monitoring → Metrics Explorer**, metric `logging.googleapis.com/billing/monthly_bytes_ingested`, resource `global`). Note the current GiB and the trend.

### 2. Break down by log source

In **Logs Explorer**, use the **Log Analytics / "Bytes ingested"** breakdown (or group by `resource.type` / `logName`) to find the top contributors. Usual Scratch sources, largest first:

- **Cloud Run request/app logs** (`cloud_run_revision`) — the normal bulk.
- **Cloud SQL** `pgaudit` + connection logs (`cloudsql_database`).
- **VPC Flow Logs** (`gce_subnetwork`).
- **Data Access audit logs** (`cloudaudit.googleapis.com/data_access`) — Secret Manager + Cloud Storage **writes**. If this is unexpectedly large, check whether Cloud Storage `DATA_WRITE` (asset rehosting) is the driver.

### 3. Identify the driver

- A **new / changed service** logging verbosely (a debug log level left on, a crash loop spamming errors).
- A **Data Access audit-log surprise** — e.g. an asset-rehosting spike inflating Cloud Storage `DATA_WRITE`, or (a bug/misconfig) `DATA_READ` accidentally enabled on `storage.googleapis.com`.
- Genuine **traffic growth**.

## Remediation

- **Expected growth** — raise `log_ingestion_alert_threshold_gib` in [`variables.tf`](../../terraform/modules/env/variables.tf) and open an MR.
- **Unneeded volume** — add or tighten a `google_logging_project_exclusion` on the noisy source (e.g. drop a chatty log level, or exclude a specific Data Access log source) and open an MR. If Cloud Storage `DATA_WRITE` audit volume is the culprit and not worth the cost, drop that `audit_log_config` in [`audit.tf`](../../terraform/modules/env/audit.tf) (bucket access logs still cover object activity).
- Do **not** `terraform apply` from a read-only session; that stays with whoever owns the deploy.

## Related

- Alert definition: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf)
- Audit-log scope (what feeds Data Access ingestion): [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf)
- Sibling security runbook: [`runbook-gcp-secret-access-alerts.md`](runbook-gcp-secret-access-alerts.md)
