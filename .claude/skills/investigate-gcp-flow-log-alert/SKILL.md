---
name: investigate-gcp-flow-log-alert
description: Investigate a Scratch GCP VPC Flow Logs security alert (unexpected-country geo, suspicious egress port, or egress volume spike) from #feed-gcp-alerts. Pulls the triggering flow records, attributes the peer IPs (ASN/geo/reverse-DNS), identifies the internal actor and direction, correlates with connector/app activity, and reaches a benign/malicious verdict with a remediation recommendation. Use when one of these alerts fires, when the user pastes one, or asks to triage unexpected-country / egress-port / egress-volume VPC flow-log traffic in spv1eu-production.
user-invocable: true
allowed-tools:
  - Bash(gcloud logging read:*)
  - Bash(gcloud config get-value:*)
  - Bash(gcloud config list:*)
  - Bash(dig:*)
  - Bash(host:*)
  - Bash(whois:*)
  - Bash(curl:*)
  - Bash(jq:*)
  - Bash(terraform/tools/connect_to_gcp_db_readonly.sh:*)
  - Bash(terraform/tools/connect_to_git_service_ssh.sh:*)
  - Read
  - Grep
  - Glob
  - WebFetch
  - WebSearch
  - AskUserQuestion
  - mcp__claude_ai_Slack__slack_read_channel
  - mcp__claude_ai_Slack__slack_search_public_and_private
  - mcp__claude_ai_Slack__slack_read_thread
---

## What this skill does

Triage one of the three **VPC Flow Logs security alerts** that post to Slack `#feed-gcp-alerts` from Google Cloud Monitoring for the EU-production project `spv1eu-production`:

- **Unexpected geo-location** — traffic to/from a country outside the allowlist (`flow-log-unexpected-country`). *Most common; usually benign.*
- **Suspicious egress port** — outbound to the internet on a sensitive port (SSH/Telnet/SMB/MySQL/Redis/RDP/MongoDB) (`flow-log-suspicious-egress-ports`).
- **Egress volume spike** — a single egress flow ≥ 1 GiB (`flow-log-external-egress-bytes`).

All three share the same runbook: **pull the flow records → attribute the peer → identify our actor → correlate with app activity → verdict → remediate.** Only the Step 1 filter and the benign/malicious heuristic differ (see "Adapting to the sibling alerts").

The human-readable version of this runbook is [`docs/ops/runbook-gcp-vpc-flow-log-alerts.md`](../../../docs/ops/runbook-gcp-vpc-flow-log-alerts.md). Keep the two in sync when either changes.

## Guardrails (read this first)

- **Strictly read-only.** This investigation never mutates anything. Use only: `gcloud logging read`, `dig`/`host`/`curl` (IP attribution), the `terraform/tools/connect_*_readonly.sh` helpers, and Slack reads.
- **Never** `terraform apply`, edit the allowlist and apply, restart/patch a VM, or run any mutating `gcloud` verb. Prepare changes as an MR and hand them to the user.
- If the verdict is **malicious**, do **not** contain it yourself — containment (egress block, credential rotation, VM isolation) is break-glass and requires a `role_operations@whalesync.com` admin. Preserve evidence and escalate.
- The old Notion "Firefighting/On-Call (GCP)" playbook is **deprecated** — do not rely on it.

## Key facts

| Item | Value |
| --- | --- |
| Project | `spv1eu-production` (region `europe-west1` / Ireland) |
| Flow-log name | `projects/spv1eu-production/logs/compute.googleapis.com%2Fvpc_flows` (`resource.type="gce_subnetwork"`) |
| Alert defs | `terraform/modules/env/monitoring.tf` — allowlist at `local.flow_log_allowed_countries` (~line 66); metrics + alert policies ~lines 930–1165 |
| Country allowlist | ISO 3166-1 **alpha-3 lowercase**: `usa can gbr irl deu bel fra` (+ any since added) |
| Geo caveat | Country fields populate **only for public IPs**; internal (RFC-1918) traffic is excluded by construction |
| Slack channel | `#feed-gcp-alerts` (id `C0B045P6NRX`) |
| Our compute | Cloud Run `api`/`worker` (subnet-1 `192.168.0.0/20`, **no `vm_name`**); GCE VMs `scratch-git` + `cloudsql-proxy` (**have `vm_name`**) |
| CLAUDE.md rule | Every `gcloud` call needs **both** `--project=spv1eu-production` **and** `--billing-project=spv1eu-production` (or you get a misleading `SERVICE_DISABLED`) |

## Step 0 — Read the firing alert

Get the specifics from Slack (and the Cloud Monitoring incident page linked in the message):

```
slack_read_channel channel_id=C0B045P6NRX   # or slack_search_public_and_private: "unexpected country in:#feed-gcp-alerts"
```

Extract: **which alert**, the **country** + which label (`src_country` vs `dest_country`), the **value** (flow count), and the **firing window** (the Slack timestamp is your window; convert PDT→UTC). A geo alert often fires **twice** for one episode — once for each direction (`dest_country=X` egress, `src_country=X` return) — that is normal.

## Step 1 — Pull the triggering flow records

Set the variables from Step 0, then dump to a temp file (keeps large output out of context):

```bash
COUNTRY=swe                       # the alpha-3 code from the alert
START=2026-07-10T12:50:00Z        # ~10 min before the firing window
END=2026-07-10T13:40:00Z          # ~end of the aggregation window (flow logs aggregate on 10-min intervals + lag; widen if empty)

gcloud logging read \
  "resource.type=\"gce_subnetwork\" AND
   logName=\"projects/spv1eu-production/logs/compute.googleapis.com%2Fvpc_flows\" AND
   (jsonPayload.src_location.country=\"$COUNTRY\" OR jsonPayload.dest_location.country=\"$COUNTRY\") AND
   timestamp>=\"$START\" AND timestamp<=\"$END\"" \
  --project=spv1eu-production --billing-project=spv1eu-production \
  --order=asc --limit=1000 --format=json > /tmp/flows.json
jq 'length' /tmp/flows.json
```

Then shape it — direction split, the peer/port rollup, distinct public IPs, and bytes:

```bash
# direction split
jq -r '.[].jsonPayload | if .dest_location.country=="'"$COUNTRY"'" then "EGRESS→ (reporter=\(.reporter))" else "INGRESS← (reporter=\(.reporter))" end' /tmp/flows.json | sort | uniq -c

# EGRESS rollup: count | our_src_ip | src_vm | peer_dest_ip | dest_port | proto(6=TCP,17=UDP)
jq -r '.[].jsonPayload | select(.dest_location.country=="'"$COUNTRY"'") | "\(.connection.src_ip)\t\(.src_instance.vm_name // "-")\t\(.connection.dest_ip)\t\(.connection.dest_port)\t\(.connection.protocol)"' /tmp/flows.json | sort | uniq -c | sort -rn | head

# INGRESS rollup: count | peer_src_ip | our_dest_ip | dest_vm | dest_port
jq -r '.[].jsonPayload | select(.src_location.country=="'"$COUNTRY"'") | "\(.connection.src_ip)\t\(.connection.dest_ip)\t\(.dest_instance.vm_name // "-")\t\(.connection.dest_port)"' /tmp/flows.json | sort | uniq -c | sort -rn | head

# distinct public peer IPs
jq -r '.[].jsonPayload | if .dest_location.country=="'"$COUNTRY"'" then .connection.dest_ip else .connection.src_ip end' /tmp/flows.json | sort | uniq -c | sort -rn

# bytes moved (bytes_sent is from the reported src→dst)
jq -r '[.[].jsonPayload | select(.dest_location.country=="'"$COUNTRY"'") | (.bytes_sent|tonumber?//0)] | "EGRESS bytes: \(add)"' /tmp/flows.json
jq -r '[.[].jsonPayload | select(.src_location.country=="'"$COUNTRY"'") | (.bytes_sent|tonumber?//0)] | "INGRESS bytes: \(add)"' /tmp/flows.json
```

Record: the **distinct peer IP(s)**, the **port(s)**, the **direction/reporter**, the **bytes**, and **which internal endpoint** (`192.168.0.x` with no `vm_name` = Cloud Run; a `vm_name` = `scratch-git` or `cloudsql-proxy`).

## Step 2 — Attribute the peer IP(s)

For each distinct public peer IP:

```bash
dig +short -x <IP>                                   # reverse DNS: AWS/GCP PTRs reveal region, e.g. ...eu-north-1.compute.amazonaws.com
curl -s "https://ipinfo.io/<IP>/json" | jq '{ip,org,region,country,hostname}'   # ASN + org + city
```

Then decide what it is:
- **A cloud provider (AWS/GCP/Azure) region** hosting a SaaS or a customer's DB/app → almost certainly a legitimate connector target. *(AWS `eu-north-1` = Stockholm/Sweden, `sa-east-1` = Brazil, `ap-south-1` = India, etc. — a connector talking to a customer's project there is normal.)*
- **A CDN edge** (Cloudflare/Fastly/Akamai) → benign SaaS traffic.
- **A customer-hosted service** — WordPress / Shopify / Moco / Wix / Framer / generic-api all accept **user-supplied domains**; confirm against a configured connection (Step 4).
- **Confirm the service by matching DNS:** if you suspect a specific SaaS, resolve its host and check it contains the peer IP, e.g. `dig +short aws-1-eu-north-1.pooler.supabase.com` (Supabase pooler) — an exact match is conclusive.
- **Unattributable / hosting-VPS / anonymizer**, especially inbound or on an odd port → lean malicious, go to the malicious path.

## Step 3 — Direction + internal actor

- **Egress leg** (`dest_country=X`, `reporter=SRC`): which internal IP/VM originated it? Cloud Run `api`/`worker` on a service port = a connector call (the benign hypothesis). `scratch-git` = a git clone/fetch.
- **Inbound leg** (`src_country=X`, `reporter=DEST`): what did the peer connect *to*?
  - If `dest_port` is a **high ephemeral port** (30000–65535) and the peer is the same host we egressed to, it's just the **return traffic** of our own outbound connections — not an inbound connection. (This is the usual reason a geo alert also fires on `src_country`.)
  - If `dest_port` is a **listening service** (22 on the `cloudsql-proxy` bastion, 443 on a load balancer), it's a genuine inbound connection — 22 is almost always internet SSH scanning noise (see the `0.0.0.0/0 → tcp:22` rule, `terraform/modules/vpc/main.tf`), benign for the alert but a real exposure to flag.

## Step 4 — Correlate with application activity (optional, for naming the customer)

Only needed if the peer is a customer-hosted/SaaS target and you want to name the workbook/connection:

```bash
# server logs around the window (read-only)
gcloud logging read \
  'resource.type="cloud_run_revision" AND timestamp>="'"$START"'" AND timestamp<="'"$END"'"' \
  --project=spv1eu-production --billing-project=spv1eu-production --limit=100 --format=json

# read-only prod DB: find a connection/workbook whose configured host matches the peer
terraform/tools/connect_to_gcp_db_readonly.sh production "SELECT id, \"workbookId\", type FROM \"ConnectorAccount\" WHERE ... ;"
```

If `scratch-git` is the actor: `terraform/tools/connect_to_git_service_ssh.sh production`, then `sudo gitops-ps` / `sudo gitops-logs <blue|green|proxy>`. Read-only wrappers only.

## Step 5 — Cross-check the sibling alerts

Did **suspicious-egress-ports** or **egress-volume-spike** fire in the same window (check `#feed-gcp-alerts`)? Country-only + a normal service port (443, or a known DB port like 6543) + modest egress bytes ⇒ **benign**. Country + an odd/sensitive port, or country + a ≥1 GiB egress flow ⇒ **escalate**.

## Decide: benign vs malicious

**Benign** (the common case): the peer attributes to a known cloud region / CDN / customer host, the port is a legitimate service port, our actor is Cloud Run running a connector, and volume is consistent with a sync. Bidirectional geo alerts that are just one connector session.

**Malicious / suspicious**: unattributable peer, sensitive/odd port egress, a real ≥1 GiB egress spike, an actor that shouldn't be talking to the internet, or egress driven by a user-supplied connector URL pointing somewhere unexpected (possible SSRF).

## Remediate

- **Benign geo false positive →** add the country to `flow_log_allowed_countries` (`terraform/modules/env/monitoring.tf`) and open an MR. **Check whether prior "add to allowlist" decisions actually landed** — the list has drifted before. Do **not** `terraform apply` — that's the user's call. If this recurs across regions, point at the durable-fix Linear issue rather than growing the allowlist forever.
- **Inbound SSH scan noise →** benign for the alert, but flag the `0.0.0.0/0 → tcp:22` exposure as a separate hardening MR (an IAP-only rule already exists).
- **Malicious →** preserve evidence (keep the `/tmp/flows.json` export), escalate to a `role_operations@` admin for containment, scaffold an incident report with the `create-incident-report` skill, and if SSRF via a user-supplied connector URL, identify + disable the offending connection/workbook.

## Report

Summarize: **verdict**, the evidence chain (peer → ASN/geo → service → our actor → volume/direction), why it alerted, and the recommended remediation. Offer to reply in the `#feed-gcp-alerts` thread with the verdict so the triage is auditable.

## Adapting to the sibling alerts

Same flow; change only Step 1's filter and the heuristic:
- **Suspicious egress port** — filter `flow-log-suspicious-egress-ports` (or `local.flow_log_external_egress AND jsonPayload.connection.dest_port=(21 OR 22 OR 23 OR 445 OR 3306 OR 3389 OR 6379 OR 27017)`). Benign only if it's a known service (e.g. a Redis/MySQL connector to a managed DB); otherwise treat as likely compromise/exfil.
- **Egress volume spike** — filter `flow-log-external-egress-bytes` and inspect `jsonPayload.bytes_sent`. Attribute the destination; a large **outbound** transfer to an unattributable host is the exfil case.
