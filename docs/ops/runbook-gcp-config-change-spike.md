# Runbook: GCP Configuration-Change Spike Alert

Guide for investigating the **Configuration-change spike** security alert that Google Cloud Monitoring posts to Slack **`#feed-gcp-alerts`** for the EU-production project `spv1eu-production`. It fires when an unusually high number of **Admin Activity audit-log entries** (resource create/update/delete and IAM `SetIamPolicy` changes) occur in a 10-minute window. Most spikes are **benign** — a `terraform apply`, a deploy, or a bulk console change — but each one needs a look, because the same signal is what would surface a compromised account or automation mass-modifying infrastructure. This is the detective control Oneleet asked for in **DEV-10978 / WSG-011**.

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (region `europe-west1`) |
| Audit-log name | `projects/spv1eu-production/logs/cloudaudit.googleapis.com%2Factivity` (Admin Activity) |
| Alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `google_logging_metric.config_change_count` + `google_monitoring_alert_policy.config_change_spike_alert` |
| Audit-config posture | [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf) — `google_project_iam_audit_config` (all services, `ADMIN_READ`) |
| Threshold | `var.config_change_alert_threshold` (default **100** entries / 10-min window on one monitored-resource surface) — measured 7-day peak was 24 |
| Monitored surfaces | `var.config_change_alert_resource_types` (default `["audited_resource"]`) |
| Slack channel | `#feed-gcp-alerts` |
| Notification | Cloud Monitoring → Slack + email. Severity **WARNING** (no PagerDuty). Auto-closes after 7 days; renotifies every 6 h |

> Admin Activity audit logs are always on and free, retained ~400 days in the immutable `_Required` bucket. This alert does not change what is logged — it watches the volume. `ADMIN_READ` (config/metadata reads) was additionally enabled in `audit.tf` for explicit posture.

## Prerequisites

- `gcloud` CLI authenticated. The per-dev read-only service account is sufficient for `gcloud logging read`.
- **Every `gcloud` command must pass both** `--project=spv1eu-production` **and** `--billing-project=spv1eu-production`. Without the billing project you hit a misleading `SERVICE_DISABLED` error (the read-only SA's quota home project doesn't have the Logging API enabled).

## Investigation

Work top to bottom; stop once you have a confident verdict.

### 1. Read the firing alert

Open the Slack message in `#feed-gcp-alerts` and the Cloud Monitoring incident page it links. Note the **firing window** (convert the Slack timestamp to UTC) and which monitored-resource surface tripped (the condition `display_name` names it, e.g. `audited_resource`).

### 2. Pull the audit entries for the window

Set a window ~10 min either side of firing, then list who did what:

```bash
START=2026-08-17T16:30:00Z
END=2026-08-17T16:50:00Z

gcloud logging read \
  "logName=\"projects/spv1eu-production/logs/cloudaudit.googleapis.com%2Factivity\" AND
   timestamp>=\"$START\" AND timestamp<=\"$END\"" \
  --project=spv1eu-production --billing-project=spv1eu-production \
  --order=asc --limit=1000 --format=json > /tmp/config-changes.json
jq 'length' /tmp/config-changes.json
```

Roll up the acting principals and the methods they called:

```bash
jq -r '.[].protoPayload.authenticationInfo.principalEmail' /tmp/config-changes.json | sort | uniq -c | sort -rn
jq -r '.[].protoPayload.methodName' /tmp/config-changes.json | sort | uniq -c | sort -rn
```

What you want out of this: the **acting principal(s)**, the **methods** (`SetIamPolicy`, `*.insert`/`.update`/`.delete`, etc.), and the **resources** touched.

### 3. Attribute the actor

- **The Terraform / GitLab CI service account** running a normal `apply` (correlate with a pipeline / MR that landed in the window) → benign. A large apply legitimately produces a burst; if it recurs, raise `config_change_alert_threshold`.
- **A known human developer** doing expected console/`gcloud` work → benign, confirm it was intended.
- **An unexpected principal**, an unfamiliar external account, `roles/owner` grants, audit-config changes, or firewall/route/IAM changes nobody planned → **escalate**.

### 4. Cross-check what changed

For IAM changes, inspect the policy delta:

```bash
jq '.[] | select(.protoPayload.methodName|test("SetIamPolicy"))
        | {who:.protoPayload.authenticationInfo.principalEmail,
           resource:.protoPayload.resourceName,
           delta:.protoPayload.serviceData.policyDelta}' /tmp/config-changes.json
```

Watch especially for new `roles/owner` bindings, service-account key creation, audit-config downgrades, and public (`allUsers`/`allAuthenticatedUsers`) grants.

## Deciding benign vs malicious

**Benign** — the burst attributes to a Terraform apply / deploy / known human doing expected work, and the changes match a pipeline or planned task.

**Malicious / suspicious** — an unexpected principal, privilege escalation (`roles/owner`, key creation), audit-logging weakened, public exposure, or firewall/route/network changes nobody planned.

## Remediation

- **Benign, recurring apply trips it** — raise `config_change_alert_threshold` in [`monitoring.tf`](../../terraform/modules/env/monitoring.tf)/[`variables.tf`](../../terraform/modules/env/variables.tf) and open an MR. Do **not** `terraform apply`; that stays with whoever owns the deploy.
- **Malicious** — do **not** contain it from a read-only session. Preserve evidence (keep `/tmp/config-changes.json`), escalate to a `role_operations@whalesync.com` admin for containment (revoke the offending IAM binding / rotate credentials / disable the account), and scaffold an incident report with the `create-incident-report` skill.

## Related

- Alert + audit-config definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf), [`terraform/modules/env/audit.tf`](../../terraform/modules/env/audit.tf)
- Sibling security runbook: [`runbook-gcp-vpc-flow-log-alerts.md`](runbook-gcp-vpc-flow-log-alerts.md)
- Incident reports: [`docs/ops/incidents/`](incidents/)
