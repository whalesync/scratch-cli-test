# Runbook: GCP Cloud Run Service Error Alerts

Guide for triaging the Google Cloud Monitoring alerts on Scratch's **Cloud Run** services —
`client`, `api`, `cron`, and `worker` — that post to Slack **`#feed-gcp-alerts`** for
`spv1eu-production`. The first three fire on a spike of **HTTP 5xx** responses; the worker fires on a
spike of **ERROR-level logs**. The most common cause is a **bad deploy**; the next is a **failing
dependency** (Cloud SQL, Redis, or scratch-git).

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (prod) / `spv1eu-test` (test), region `europe-west1` |
| Services | Cloud Run `client_service`, `api_service`, `cron_service`, `worker_service` |
| Health endpoint | [`https://api.scratch.md/service-check`](https://api.scratch.md/service-check) — reports `redis`, `scratch_git`, `scratch_git_http` status |
| Slack channel | `#feed-gcp-alerts` |
| Alert definitions | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — Client / API / Cron / Worker sections |
| Notification | Cloud Monitoring → Slack + email. No PagerDuty |

## The alerts

| Alert | Fires when | Severity |
| --- | --- | --- |
| `client_high_5xx_error_count` | client service 5xx mean > 50 over 10 min | ERROR |
| `api_frontend_high_5xx_error_count` | api service 5xx sum > 50 over 5 min | ERROR |
| `cron_high_5xx_error_count` | cron service 5xx sum > 50 over 5 min | ERROR |
| `worker_high_error_log_count` | worker ERROR-log count > 10,000 over 5 min | WARNING |

## Investigation

### 1. Identify the service and window

Note which service alerted and the firing window from the Slack message / Cloud Monitoring incident.

### 2. Read the errors in Logs Explorer

GCP Console → **Logging** → **Logs Explorer**, project `spv1eu-production`, scoped to the service and
window:

```
resource.type="cloud_run_revision"
resource.labels.service_name="<client|api|cron|worker>-service"
severity>=ERROR
```

Group by the dominant error (message / stack trace / status). A single repeated exception points at
a code bug; a spread of timeouts / connection errors points at a dependency.

### 3. Check recent deploys first (most common cause)

Correlate the firing time with the latest Cloud Run revision — GCP Console → **Cloud Run** → the
service → **Revisions**. A regression in the newest revision is the single most common cause of a 5xx
spike.

### 4. Check dependencies

Fetch [`https://api.scratch.md/service-check`](https://api.scratch.md/service-check) and confirm
`redis`, `scratch_git`, and `scratch_git_http` are `ok`. If a dependency is unhealthy, the errors are
a symptom — follow that dependency's runbook:

- Cloud SQL / Redis pressure → [GCP Managed Datastore Alerts](runbook-gcp-datastore-alerts.md)
- scratch-git unresponsive → [Unresponsive scratch-git Server](runbook-scratch-git-unresponsive-production.md)

### 5. Check load

Compare request volume to the error rate — a genuine traffic surge vs a fixed-rate failure changes
the response (scale vs fix).

## Remediation

- **Bad deploy** — roll back to the previous healthy Cloud Run revision (shift traffic back), then fix
  forward via MR. Rolling back traffic is a **deploy / `role_operations` action**, not something to do
  from a read-only session — hand off to the deploy owner.
- **Dependency failure** — follow the linked datastore / scratch-git runbook; the service recovers
  when the dependency does.
- **Load** — if it is real sustained traffic, raise Cloud Run min/max instances (`modules/env`) via MR.
- **Transient** (a brief spike that already cleared) — note it; investigate only if it recurs.

## Related

- Alert definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf)
- [Runbook: GCP Managed Datastore Alerts](runbook-gcp-datastore-alerts.md)
- [Runbook: Unresponsive scratch-git Server](runbook-scratch-git-unresponsive-production.md)
