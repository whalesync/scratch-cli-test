# Runbook: GCP Cloud NAT Port Exhaustion

Guide for the two Cloud NAT alerts Google Cloud Monitoring posts for the Scratch projects (`spv1eu-test`, `spv1eu-production`):

- **Cloud NAT - Port pressure to a single destination** (WARNING): an instance is close to, or out of, NAT ports for one destination `ip:port`.
- **Cloud NAT - Port allocation failed** (CRITICAL): the NAT could not reserve ports for an instance at all, so that instance has no internet egress.

Added in DEV-12034 after a Live Export publish into a customer Postgres host ran the worker out of NAT ports and every other job on that worker going to the same host failed with `EHOSTUNREACH`.

## Context

| Item | Value |
| --- | --- |
| Gateway | `my-router-nat` on router `nat-router`, region `europe-west1` |
| NAT IP | One static IP (`MANUAL_ONLY`). Customers allowlist it, so we do **not** add IPs |
| Port budget | 64,512 TCP ports on that IP, shared by every endpoint |
| Per-endpoint ports | `min_ports_per_vm` (static allocation) — see [`terraform/modules/cloudnat/main.tf`](../../terraform/modules/cloudnat/main.tf) |
| TIME_WAIT | `tcp_time_wait_timeout_sec`, plus up to 30s more before Google reuses a port |
| Alert definitions | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `cloud_nat_port_pressure`, `cloud_nat_allocation_failed` |
| Endpoints | Every Cloud Run instance (Direct VPC egress, `ALL_TRAFFIC`) plus VMs without an external IP (e.g. the SQL proxy, scratch-git) |

### How the limit works

Each endpoint gets `min_ports_per_vm` NAT source ports. One port can carry one connection to a given destination `ip:port` at a time, and after a connection closes, the port stays reserved for that destination for the TIME_WAIT timeout. So an instance can sustain roughly:

```
new connections/sec to one destination ≈ min_ports_per_vm / (tcp_time_wait_timeout_sec + up to 30s)
```

Code that opens a fresh connection per operation (e.g. the Postgres connector's `withPgClient`) against one host can hit this. When it does, the NAT drops the SYN and the app sees `EHOSTUNREACH` or a connect timeout. **Every** job on that instance going to the same destination fails, not only the one causing the load. Other destinations and other instances are unaffected.

## Investigation

### 1. Find the source and destination

NAT logs are `ERRORS_ONLY`, so every entry is a drop:

```bash
gcloud logging read 'resource.type="nat_gateway" AND jsonPayload.allocation_status="DROPPED"' \
  --project=spv1eu-production --billing-project=spv1eu-production --freshness=1h --limit=2000 \
  --format='value(timestamp,jsonPayload.connection.src_ip,jsonPayload.connection.dest_ip,jsonPayload.connection.dest_port)' \
  | awk '{print substr($1,1,16), $2, $3, $4}' | sort | uniq -c
```

`src_ip` is the instance's VPC address (Cloud NAT logs don't name the Cloud Run service for Direct VPC egress). The destination tells you which customer service is involved.

### 2. Find the job opening the connections

Search the worker logs around the first drop for the destination IP, `EHOSTUNREACH`, or a burst of `Batch failed` warnings. Before DEV-12034's code fixes, a publish run retrying one record at a time after connect errors was the typical cause.

### 3. Check the gateway metrics

Monitoring → Metrics Explorer, resource `nat_gateway`:

- `router.googleapis.com/nat/port_usage` — max connections from one endpoint to one destination. At `min_ports_per_vm`, it's exhausted.
- `router.googleapis.com/nat/dropped_sent_packets_count` with `reason=OUT_OF_RESOURCES` — the drops.
- `router.googleapis.com/nat/allocated_ports` — ports reserved across all endpoints. Divide by `min_ports_per_vm` for the endpoint count.
- `router.googleapis.com/nat/nat_allocation_failed` — true if some endpoint got no ports at all.

## Remediation

### Port pressure / drops

1. **Stop the load.** Cancel the offending run (e.g. the Live Export run). Drops clear within TIME_WAIT once connections stop.
2. **If it's legitimate sustained load,** raise `min_ports_per_vm` in `terraform/modules/cloudnat/main.tf` (Google: increasing it doesn't drop existing connections). First check the allocation budget below.
3. **Fix the caller** if it opens a connection per operation or retries connect failures in a tight loop — pooling/reusing a connection removes the pressure entirely.

### Allocation failed

The single NAT IP is fully reserved: `endpoints × min_ports_per_vm > 64,512`. New instances have no egress.

1. Check `allocated_ports` and the current Cloud Run instance counts (a deploy rollover briefly doubles them).
2. **Lower `min_ports_per_vm`** (next power of two down) so all endpoints fit, and apply. Do **not** add a second NAT IP without first telling customers who allowlist the current one — their connections from the new IP would be refused.

## Capacity math

With one IP, the endpoint ceiling is `64,512 / min_ports_per_vm`:

| `min_ports_per_vm` | Max endpoints | Sustained conns/sec to one destination per instance (TIME_WAIT 60s) |
| --- | --- | --- |
| 64 (GCP default) | 1,008 | ~0.7–1 |
| 1024 | 63 | ~11–17 |
| 2048 | 31 | ~23–34 |
| 4096 | 15 | ~45–68 |

Lowering TIME_WAIT raises these proportionally (Google recommends keeping it at 15s or more).

Keep the peak endpoint count (all Cloud Run services at max instances, doubled for a deploy rollover, plus VMs) comfortably under the ceiling.
