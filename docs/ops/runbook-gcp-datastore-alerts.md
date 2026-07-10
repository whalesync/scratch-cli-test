# Runbook: GCP Managed Datastore Alerts (Cloud SQL + Redis)

Guide for triaging the Google Cloud Monitoring alerts on Scratch's **managed data stores** — the
primary **Cloud SQL** Postgres instance, the **Cloud SQL Auth Proxy** VM that fronts it, and the
**Memorystore Redis** instance — that post to Slack **`#feed-gcp-alerts`** for `spv1eu-production`.
They fire on CPU / memory / disk / IO / connection pressure. Most are **transient** — a heavy
pull/publish/sync job or a migration briefly loads the DB and the alert clears on its own — but a
sustained or recurring one is a capacity problem or a leak that needs a durable fix.

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (prod) / `spv1eu-test` (test), region `europe-west1` |
| Cloud SQL instance | Postgres, `module.db_primary` (database `scratchpad`); alerts filter on `local.alert_database_id` |
| SQL Auth Proxy | GCE VM `cloudsql-proxy` — all app DB traffic flows through it |
| Redis | Memorystore, `local.redis_name` — BullMQ queues + caches |
| Slack channel | `#feed-gcp-alerts` |
| Alert definitions | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — Cloud SQL / SQL-proxy / Redis sections |
| Read-only DB access | [`terraform/tools/connect_to_gcp_db_readonly.sh`](../../terraform/tools/connect_to_gcp_db_readonly.sh) `<test\|production>` |
| Notification | Cloud Monitoring → Slack + email. No PagerDuty |

## The alerts

| Alert | Fires when | Severity |
| --- | --- | --- |
| `db_cpu_too_high` | Cloud SQL CPU > 95% | CRITICAL |
| `db_mem_usage_too_high` | Cloud SQL memory > 95% | CRITICAL |
| `db_out_of_disk_space` | Cloud SQL disk > 90% | WARNING |
| `db_disk_read_io_high` / `db_disk_write_io_high` | disk read/write ops over the configured limit for 5×5 min | CRITICAL |
| `db_connections_too_high` | Postgres backends > 95% of the connection limit for 5 min | ERROR |
| `sqlproxy_cpu_too_high` | `cloudsql-proxy` VM CPU > 80% for 3×15 min | WARNING |
| `redis_mem_usage_too_high` | Memorystore Redis memory usage ratio > 95% | ERROR |

## Investigation

Work top to bottom; stop once you have a confident cause.

### 1. Read the firing alert and scope the window

Note which alert, the value vs threshold, and the firing window. A single brief spike that already
auto-cleared is usually a heavy job; a sustained or repeating breach is a capacity/leak problem.

### 2. Look at the metric in context

Open the resource in the GCP Console (**SQL** → the instance → **Monitoring**, or **Metrics
Explorer** for the proxy VM / Redis) over the incident window plus the preceding hour. Decide: a
one-off spike, or a rising trend / plateau?

### 3. Correlate with app activity

The usual driver is load from Cloud Run. Check for:

- a large **pull / publish / sync** job or a **code migration** in the window (worker logs; see
  [Running a Code Migration Against Production](runbook-running-prod-code-migrations.md)),
- a recent **deploy** that changed query patterns or connection-pool sizing,
- request-volume spikes on the API / worker services.

### 4. Find the expensive queries with Cloud SQL Query Insights

For **`db_cpu_too_high`** and **`db_disk_read_io_high`** in particular, the fastest route to the culprit
is **Cloud SQL Query Insights** (GCP Console → **SQL** → the instance → **Query Insights**). Set the
time range to the firing window and sort the top queries to find:

- queries with the **highest execution / total time** — the biggest CPU consumers,
- queries with a **high call frequency** — a cheap query run often enough still saturates CPU,
- queries that **drive IO load** — high rows-scanned / shared-block reads, the usual cause of a read-IO spike.

Query Insights groups by normalized query shape; note the offending query text and map it back to the
connector / job / endpoint that issues it. A single dominant query usually explains the alert, and the
fix is an index, a query change, or throttling whatever runs it.

### 5. Inspect the database read-only (connections / disk / slow queries)

Use the guarded read-only helper (never a read-write tunnel against prod):

```bash
# Connection count by state (for db_connections_too_high):
terraform/tools/connect_to_gcp_db_readonly.sh production \
  "SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY 2 DESC;"

# Longest-running queries (CPU / IO pressure):
terraform/tools/connect_to_gcp_db_readonly.sh production \
  "SELECT pid, now() - query_start AS runtime, left(query, 80) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY runtime DESC LIMIT 20;"

# Largest relations (for db_out_of_disk_space):
terraform/tools/connect_to_gcp_db_readonly.sh production \
  "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20;"
```

For **connections**, look for one service holding many `idle in transaction` backends (a pool leak).
For the **SQL proxy**, high CPU almost always mirrors DB throughput — it is a GCE VM and, like
`scratch-git`, can be stopped/started if it is itself wedged (break-glass; see below).

## Remediation

- **Transient** (spike cleared with the job) — no action; note it if it recurs.
- **Sustained / recurring** — durable fix via Terraform + MR (not a direct prod apply):
  - CPU / memory: raise the Cloud SQL tier / machine type in `modules/env`.
  - Disk: raise disk size (Cloud SQL can also auto-grow) and/or reclaim bloat (`VACUUM`, drop dead
    data) — done as a code migration, not manual prod SQL.
  - Connections: fix the leaking pool or lower per-instance pool size, or raise `var.db_connection_limit`.
  - Redis memory: raise the Memorystore tier, shorten key TTLs, or trim queue backlogs.
- **Capacity changes and any VM restart are deploy / `role_operations` actions** — do not
  `terraform apply` from a read-only session; open the MR and hand off to the deploy owner.

## Related

- Alert definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf)
- Read-only DB access: [`terraform/tools/connect_to_gcp_db_readonly.sh`](../../terraform/tools/connect_to_gcp_db_readonly.sh)
- [Runbook: Running a Code Migration Against Production](runbook-running-prod-code-migrations.md)
- [Runbook: GCP Cloud Run Service Error Alerts](runbook-gcp-cloud-run-service-errors.md) — when DB pressure surfaces as service 5xx
