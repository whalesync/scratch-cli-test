# Runbook: GCP VPC Flow Logs Security Alerts

Guide for investigating the **VPC Flow Logs** security alerts that Google Cloud Monitoring posts to Slack **`#feed-gcp-alerts`** for the EU-production project `spv1eu-production`. These fire on network traffic to/from an unexpected country, outbound to sensitive ports, or a large egress spike. The overwhelming majority are **benign** — legitimate connector traffic to a cloud-hosted or customer-hosted service in a region we haven't allowlisted — but each one needs a look, because the same signal is what would surface real exfiltration or a compromised host.

This runbook is paired with the **`/investigate-gcp-flow-log-alert` Claude skill** (`.claude/skills/investigate-gcp-flow-log-alert/SKILL.md`), which automates the steps below. Keep the two in sync when either changes.

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` (region `europe-west1` / Ireland) |
| Flow-log name | `projects/spv1eu-production/logs/compute.googleapis.com%2Fvpc_flows` (`resource.type="gce_subnetwork"`) |
| Alert definitions | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — country allowlist at `local.flow_log_allowed_countries` (~line 66); metrics + alert policies ~lines 930–1165 |
| Country allowlist | ISO 3166-1 **alpha-3 lowercase**: `usa can gbr irl deu bel fra` (plus any added since) |
| Geo caveat | Country fields populate **only for public IPs** — internal (RFC-1918) traffic is excluded by construction |
| Slack channel | `#feed-gcp-alerts` (id `C0B045P6NRX`) |
| Notification | Cloud Monitoring → Slack + email. Severity **WARNING** (no PagerDuty). Auto-closes after 7 days; renotifies every 6 h |
| Our compute | **Cloud Run** `api`/`worker` (subnet-1 `192.168.0.0/20`, **no** `vm_name` in flow logs); GCE VMs **`scratch-git`** + **`cloudsql-proxy`** (**have** a `vm_name`) |
| Egress path | All outbound leaves through a single Cloud NAT static IP (`nat-egress-ip`) |

> The old Notion "Firefighting / On-Call (GCP)" playbook that these alerts used to link is **deprecated** — do not use it. This runbook and the skill replace it.

## The three alerts

| Alert (metric) | Fires when | Usual verdict |
| --- | --- | --- |
| **Unexpected geo-location** (`flow-log-unexpected-country`) | src **or** dest public IP resolves to a country outside the allowlist | Benign (region we haven't allowlisted) |
| **Suspicious egress port** (`flow-log-suspicious-egress-ports`) | outbound to the internet on 21/22/23/445/3306/3389/6379/27017 | Needs care — could be compromise/exfil |
| **Egress volume spike** (`flow-log-external-egress-bytes`) | a single egress flow ≥ 1 GiB | Needs care — could be exfil |

All three follow the **same investigation**: pull the flow records → attribute the peer → identify our actor and direction → correlate with app activity → verdict → remediate. Only the initial filter and the benign/malicious judgement differ.

## Quick start — use the skill

In Claude Code, run:

```
/investigate-gcp-flow-log-alert
```

Paste (or let it read) the alert from `#feed-gcp-alerts`. The skill will pull the triggering flow records, attribute the peer IPs (ASN / geo / reverse-DNS), identify the internal actor and direction, optionally correlate with the connector/DB, cross-check the sibling alerts, and return a **benign/malicious verdict with a remediation recommendation**. It is strictly read-only and prepares (never applies) any fix. If you'd rather work by hand, follow the steps below — they are exactly what the skill runs.

## Prerequisites

- `gcloud` CLI authenticated. The per-dev read-only service account is sufficient for `gcloud logging read` and the read-only helpers.
- **Every `gcloud` command must pass both** `--project=spv1eu-production` **and** `--billing-project=spv1eu-production`. Without the billing project you hit a misleading `SERVICE_DISABLED` error (the read-only SA's quota home project doesn't have the Logging API enabled).
- Read-only helpers: [`terraform/tools/connect_to_gcp_db_readonly.sh`](../../terraform/tools/connect_to_gcp_db_readonly.sh) (prod DB) and [`terraform/tools/connect_to_git_service_ssh.sh`](../../terraform/tools/connect_to_git_service_ssh.sh) (`scratch-git` VM, `gitops-*` wrappers).

## Investigation

Work top to bottom; stop once you have a confident verdict.

### 1. Read the firing alert

Open the Slack message in `#feed-gcp-alerts` and the Cloud Monitoring incident page it links. Note **which alert**, the **country** and which label (`src_country` = inbound/return, `dest_country` = egress), the **flow count**, and the **firing window** (convert the Slack PDT timestamp to UTC). A geo alert commonly fires **twice** for one episode — once per direction. That is expected, not two separate events.

### 2. Pull the triggering flow records

Set the country and a window ~10 min either side of firing (flow logs aggregate on 10-minute intervals and lag a little; widen if the query is empty), then dump to a file:

```bash
COUNTRY=swe
START=2026-07-10T12:50:00Z
END=2026-07-10T13:40:00Z

gcloud logging read \
  "resource.type=\"gce_subnetwork\" AND
   logName=\"projects/spv1eu-production/logs/compute.googleapis.com%2Fvpc_flows\" AND
   (jsonPayload.src_location.country=\"$COUNTRY\" OR jsonPayload.dest_location.country=\"$COUNTRY\") AND
   timestamp>=\"$START\" AND timestamp<=\"$END\"" \
  --project=spv1eu-production --billing-project=spv1eu-production \
  --order=asc --limit=1000 --format=json > /tmp/flows.json
jq 'length' /tmp/flows.json
```

Then summarise direction, the peer/port rollup, the distinct public IPs, and bytes (see the skill for the full `jq` one-liners). What you want out of this: the **distinct peer IP(s)**, the **port(s)**, the **direction**, the **bytes**, and **which internal endpoint** originated or received it (a `192.168.0.x` with no `vm_name` = Cloud Run; a populated `vm_name` = `scratch-git` or `cloudsql-proxy`).

### 3. Attribute the peer IP(s)

```bash
dig +short -x <IP>                                              # reverse DNS — cloud PTRs reveal the region
curl -s "https://ipinfo.io/<IP>/json" | jq '{org,region,country,hostname}'   # ASN + org + city
```

- A **cloud region** (AWS/GCP/Azure) hosting a SaaS or a customer's DB/app → almost certainly a legitimate connector target. AWS `eu-north-1` = Stockholm (Sweden), `sa-east-1` = Brazil, `ap-south-1` = India, and so on.
- A **CDN edge** (Cloudflare/Fastly/Akamai) → benign SaaS traffic.
- A **customer-hosted service** (WordPress / Shopify / Moco / Wix / Framer / generic-api accept user-supplied domains) → benign, confirm against a configured connection.
- To **prove** a specific SaaS, resolve its host and check the peer IP is in the answer (e.g. `dig +short aws-1-eu-north-1.pooler.supabase.com`).
- **Unattributable / hosting-VPS / anonymizer**, especially inbound or on an odd port → treat as suspicious.

### 4. Direction + internal actor

- **Egress** (`dest_country`, `reporter=SRC`): Cloud Run `api`/`worker` on a service port = a connector call (benign hypothesis); `scratch-git` = a git operation.
- **Inbound** (`src_country`, `reporter=DEST`): if `dest_port` is a **high ephemeral port** and the peer is the host we egressed to, it's just the **return traffic** of our own connections (the usual reason the alert also fires on `src_country`). If `dest_port` is a **listening service** (22 on the `cloudsql-proxy` bastion, 443 on a load balancer), it's a real inbound connection — port 22 is almost always internet SSH scanning noise (there is a `0.0.0.0/0 → tcp:22` firewall rule), benign for the alert but a genuine exposure to flag separately.

### 5. Correlate with app activity (optional — to name the customer)

Read the Cloud Run logs for the window, or query the prod DB read-only for a connection whose configured host matches the peer:

```bash
terraform/tools/connect_to_gcp_db_readonly.sh production "SELECT id, \"workbookId\", type FROM \"ConnectorAccount\" LIMIT 20;"
```

### 6. Cross-check the sibling alerts

Did **suspicious-egress-ports** or **egress-volume-spike** also fire in the same window? Country-only + a normal service port + modest egress ⇒ benign. Country + an odd/sensitive port, or a genuine ≥1 GiB egress flow ⇒ escalate.

## Deciding benign vs malicious

**Benign** — the peer attributes to a known cloud region / CDN / customer host, on a legitimate service port, our actor is Cloud Run running a connector, and volume matches a sync. Bidirectional geo alerts that are simply one connector session.

**Malicious / suspicious** — unattributable peer, sensitive/odd-port egress, a real ≥1 GiB egress spike, an actor that should never reach the internet, or egress driven by a user-supplied connector URL pointing somewhere unexpected (possible SSRF).

## Remediation

- **Benign geo false positive** — add the country code to `flow_log_allowed_countries` in [`monitoring.tf`](../../terraform/modules/env/monitoring.tf) and open an MR. **Check first whether the previous "add to allowlist" decisions actually landed** — the list has silently drifted before. Do **not** `terraform apply`; that stays with whoever owns the deploy. If this keeps recurring across regions, prefer the durable fix (see below) over growing the allowlist indefinitely.
- **Inbound SSH scan noise** — benign for the alert, but raise the `0.0.0.0/0 → tcp:22` exposure as a separate hardening MR (an IAP-only SSH rule already exists, so the world-open one is likely removable).
- **Malicious** — do **not** contain it from a read-only session. Preserve evidence (keep the `/tmp/flows.json` export), escalate to a `role_operations@whalesync.com` admin for containment (egress block / credential rotation / VM isolation), scaffold an incident report with the `create-incident-report` skill, and if it's SSRF via a user-supplied connector URL, identify and disable the offending connection/workbook.

## Worked example — 2026-07-10, Sweden / Supabase

Two geo alerts fired at 13:13 UTC: `dest_country=swe` (186 flows) and `src_country=swe` (157 flows), both auto-clearing within a minute.

- Flow records: 358 flows, all between our Cloud Run instances (`192.168.0.16/.26/.32`) and two peers `51.21.189.77` / `51.21.18.29`; every egress flow to **TCP 6543**.
- Attribution: both peers reverse-resolve to `ec2-51-21-*.eu-north-1.compute.amazonaws.com` (AWS `AS16509`, Stockholm), and `aws-1-eu-north-1.pooler.supabase.com` resolves to **exactly those two IPs**. Port 6543 is the **Supabase Supavisor pooler**, which our Supabase connector requires.
- Direction/volume: the `src_country=swe` leg was return traffic to our ephemeral ports (not inbound scanning); ~1.2 MB out, ~2.19 GB read back from the Supabase DB.

**Verdict: benign** — a Supabase connector sync to a customer project hosted in AWS Stockholm. It alerted only because Sweden isn't in the allowlist. Interim remediation: add `swe` (and restore the never-landed `nld`) to the allowlist; durable fix tracked separately.

## Related

- Skill: [`/investigate-gcp-flow-log-alert`](../../.claude/skills/investigate-gcp-flow-log-alert/SKILL.md)
- Alert definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf)
- Connectors (to judge a legitimate egress target): [`server/src/remote-service/connectors/library/`](../../server/src/remote-service/connectors/library/)
- Incident reports: [`docs/ops/incidents/`](incidents/)
