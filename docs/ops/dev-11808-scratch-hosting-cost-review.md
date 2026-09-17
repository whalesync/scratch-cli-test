# Scratch Hosting Cost Review — over-provisioning & cost-reduction plan

- **Created:** 2026-09-17
- **Author:** Chris Hoefgen (with Claude)
- **Linear:** [DEV-11808](https://linear.app/whalesync/issue/DEV-11808) (parent [DEV-11785](https://linear.app/whalesync/issue/DEV-11785) · project *Reduce GCP Costs*)
- **Status:** Analysis / proposal — no infra changed. Implementation, if approved, lands as separate isolated terraform MRs.
- **GCP projects:** `spv1eu-production`, `spv1eu-test` (region `europe-west1`, Belgium)

## Problem statement

Scratch has **< 10 external (non-`@whalesync.com`) active users and no growth forecast**, but its infrastructure is provisioned like a production SaaS. Both GCP projects are built from the *same* `terraform/modules/env`, so nearly every production resource is **duplicated in a test environment that does not need to mirror production**. This document quantifies the August 2026 spend, identifies where the two projects are over-provisioned, and proposes a prioritized set of cuts — each with its risk and a recommendation — so future sessions can implement them piecemeal.

**Evidence base:** August 2026 billing export (attached to DEV-11808), a full read of `terraform/`, and one sanctioned read-only production DB query. All read-only.

## Headline

August 2026 Scratch spend was **$1,781/mo** (`spv1eu-production` $1,130 + `spv1eu-test` $651). Right-sizing to actual scale removes an estimated **~$650–$850/mo (≈40–48%)** near-term, more once the 2 TB production disk is right-sized. (Note: the parent project's "$5k off $13k/mo" target spans the Whalesync `wsv1-*` projects too — Scratch is a smaller slice, so this is Scratch's realistic contribution, not the whole $5k.)

## Where the money goes (Aug 2026)

| Service | prod | test | Primary driver |
|---|---:|---:|---|
| Compute Engine | $483.66 | $103.45 | **prod scratch-git 2 TB `pd-ssd` disk ($200; ~$340 run-rate) + `e2-highmem-4` ($189) + hourly snapshots ($48)**; `cloudsql-proxy` bastion (N2) ~$27/env |
| Cloud Run | $286.90 | $262.60 | api & worker **pinned min=max=2**; cron+worker **CPU-always-on** → 3 full always-on instances/env (the ~$157 "instance-based CPU" line) |
| Cloud SQL | $214.07 | $105.24 | both `db-custom-2-8192` (2 vCPU/8 GB); **prod Regional HA** vs test Zonal |
| Networking | $78.37 | $59.85 | 6 global LB forwarding rules + 1 regional internal LB per env (≈$46/env in rule minimums) + Cloud NAT |
| Artifact Registry | $7.37 | **$62.81** | **no cleanup policy; `cleanup_policy_dry_run = true`** → per-commit test images accumulate forever |
| Cloud Memorystore (Redis) | $39.17 | $39.17 | BASIC 1 GB (already the floor) |
| Monitoring / Secrets / Logging | ~$20 | ~$18 | alerts, uptime checks, custom metrics |

Supporting facts from terraform + live check:

- **Production DB is only 12 GB** (confirmed via `connect_to_gcp_db_readonly.sh production`) on a 2 vCPU / 8 GB **Regional-HA** instance.
- The **N2 line item is the `cloudsql-proxy` IAP bastion** (`terraform/modules/env/main.tf:346`, now coded `e2-standard-2`, was `n2-standard-2`). It is a pure SSH jump host to the private-IP Cloud SQL.
- **api / cron / worker are the same `spinner-server` image** differentiated only by a `SERVICE_TYPE` env var (`services.tf:189/482/740`, `:231/519/781`) → combinable.
- The scratch-git **data disk type is hardcoded `pd-ssd`** and **not plumbed per-env** (`terraform/modules/scratch_git_gce/variables.tf:75-79`); snapshot **retention is hardcoded 14 days** and also not plumbed (`…/variables.tf:105-109`).

## Recommendations

Tiered by risk. `file:line` are the exact knobs to change. Maps to the six asks in DEV-11808: **VM sizes**, **database size**, **combine Cloud Run**, **Cloud Run → MIG**, **reduce redundancy**, **minimize test footprint**.

### Tier 1 — Quick wins, no availability impact (do first)

| # | Change | file:line | Risk | Est. save/mo |
|---|---|---|---|---:|
| 1 | **Artifact Registry cleanup**: add `cleanup_policies` (delete untagged > 7–14 d + keep-most-recent-N) **and set `cleanup_policy_dry_run = false`** | `terraform/modules/env/main.tf:256-266` | None (keeps current + recent) | **~$55** (mostly test) |
| 2 | **Prod scratch-git disk `pd-ssd` → `pd-balanced`**: add a `disk_type` variable and plumb `env` → `scratch_git_gce` | `terraform/modules/scratch_git_gce/variables.tf:75-79`; size `eu-production.tf:69` | Low perf impact for the git workload; **type change requires recreating the disk (snapshot → restore, brief scratch-git downtime)** — schedule a window | **~$140** |
| 3 | **Prod snapshots**: hourly → every 4 h and retention 14 → 7 days (plumb `snapshot_retention_days`) | `eu-production.tf:68`; `terraform/modules/scratch_git_gce/variables.tf:105-109` | Coarser RPO (≤ 4 h) | **~$30** (compounds with #2/#9) |
| 4 | **`cloudsql-proxy` bastion → `e2-small`** (pure IAP SSH jump host) — confirm the `e2-standard-2` resize is live in both projects first | `terraform/modules/env/main.tf:346` | None | **~$30** (both envs) |

### Tier 2 — Right-sizing (verify utilization in Cloud Monitoring first)

| # | Change | file:line | Risk | Est. save/mo |
|---|---|---|---|---:|
| 5 | **Cloud Run instance counts + fold `cron` → `worker`** (same image): removes 1 always-on instance + its otel sidecar per env. Then prod api `2→1`, worker `2→1`; test api & client `min=0`, worker `min=1` | cron hardcoded `services.tf:468-469`; api `eu-production.tf:74-75`/`eu-test.tf:67-68`; worker `eu-production.tf:76-77`/`eu-test.tf:69-70` | prod min=1 → brief unavailability during deploy/crash; test → cold starts (fine at this scale) | **~$250** |
| 6 | **Prod scratch-git VM `e2-highmem-4` → `e2-highmem-2`** (32 GB → 16 GB) | `eu-production.tf:66` | Perf if memory-bound (Rust git service + Docker) — check RAM/CPU first | **~$90** |
| 7 | **Test Cloud SQL tier `db-custom-2-8192` → `db-custom-1-4096`** (add per-env `db_tier` override) | `eu-test.tf` (default `terraform/modules/env/variables.tf:61-65`) | Negligible for test | **~$50** |

### Tier 3 — Per-item availability decisions (recommendation given; final call per line item)

| # | Change | file:line | Risk / recommendation | Est. save/mo |
|---|---|---|---|---:|
| 8a | **Prod Cloud SQL tier `db-custom-2-8192` → `db-custom-1-4096`** (DB is only 12 GB) | default `terraform/modules/env/variables.tf:61-65` | Low at this scale. **Recommend: DO** | ~$52 |
| 8b | **Prod Cloud SQL Regional HA → Zonal** (`db_high_availability = false`) | `eu-production.tf` (default `variables.tf:106-110`; mapping `terraform/modules/cloudsql/main.tf:22`) | **Loses automatic failover** — a zonal outage means restore-from-backup (backups retained 14 d; PITR already off). **This is the one genuine availability reduction.** **Recommend: DO** given < 10 users + cost, but sign off explicitly | ~$103 |
| 9 | **Right-size the 2 TB prod disk** — the size is likely inflated by the scratch-git staging-dir growth bug (**DEV-11253**; reaper **DEV-11317**). After cleanup lands and true usage is known, recreate a smaller `pd-balanced` disk | `eu-production.tf:69` | Disruptive one-time migration; **gated on DEV-11253**. **Recommend: DO after DEV-11253** | +~$150 (beyond #2) |

### Considered and NOT recommended now

- **Replace Cloud Run with a Managed Instance Group** *(explicit ask)* — a single small GCE VM hosting the monolith could undercut Cloud Run's always-on premium, but adds real ops burden (deploys, health checks, TLS, autoscaling) and a migration. **Tier-2 min-instance right-sizing (#5) captures most of that saving at far lower risk.** Keep as a longer-term option only.
- **Merge api + client external LBs** into one host-routed LB (1 IP / 1 cert, dropping under the 5-forwarding-rule minimum) and drop test's static-assets LB / CDN / HTTP-redirect *(reduce redundancy / test footprint)* — real but modest (**~$40/mo**) and touches TLS/DNS. Do opportunistically, not first. (LBs: client `services.tf:139`, api `services.tf:439`, static `terraform/modules/env/main.tf:729`, scratch-git internal `terraform/modules/scratch_git_gce/main.tf:272`.)
- **Redis** — BASIC 1 GB is already the floor ($39/env). No saving. (Note: prod Redis has **no** HA — an availability gap, not a cost lever; adding HA would *increase* cost.)

## Estimated total

| Bucket | Near-term save/mo |
|---|---:|
| Tier 1 (quick, no-risk) | ~$255 |
| Tier 2 (right-size, verify) | ~$390 |
| Tier 3 DB (recommended) | ~$155 |
| **Near-term total** | **~$650–$850/mo (≈40–48% of $1,781)** |
| Later: 2 TB disk right-size (post-DEV-11253) | +~$150 |

## Key decisions / caveats

- **Report only** under DEV-11808; changes land later as **separate isolated terraform MRs** (terraform kept out of feature branches), rolled out **test-first**, watching a full billing cycle before prod.
- The read-only SA **cannot `terraform plan` `envs/*` (403)** — no plan-computed deltas. Validate each change with the **GCP Pricing Calculator** and **Cloud Monitoring utilization** (VM CPU/RAM/disk, DB CPU/RAM, Cloud Run instance time) *before* downsizing.
- The prod scratch-git **disk was mid-growth in August** ($200 billed vs ~$340 run-rate for 2 TB `pd-ssd`), so its share is **understated** — disk levers (#2/#3/#9) matter more than the August number suggests.
- Disk-type change (#2) and HA → Zonal (#8b) are **one-time disruptive** (recreate / failover) — schedule maintenance; snapshot first.
- Per `docs/ops/CLAUDE.md`: once implemented, move/annotate this doc under `docs/ops/plans/resolved/`.

## Validation of this report

Every figure traces to two sources of truth:
1. **Billing** — Aug CSV aggregation: prod $1,129.67 / test $651.50 / **$1,781.17** total, and the per-service SKU lines above.
2. **Terraform** — every `file:line` was read directly (env configs `terraform/envs/eu-{production,test}/*.tf`; modules `env`, `gce`, `scratch_git_gce`, `cloudsql`, `redis`, `cloudnat`, `cloudrun_lb`, `static_bucket_lb`).
3. **Live check** — production DB size confirmed **12 GB**.
