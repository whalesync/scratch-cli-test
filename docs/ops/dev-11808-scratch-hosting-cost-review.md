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

August 2026 Scratch spend was **$1,781/mo** (`spv1eu-production` $1,130 + `spv1eu-test` $651). Right-sizing to actual scale removes an estimated **~$560–$760/mo (≈31–43%)** near-term, more once the 2 TB production disk is right-sized — now the *primary* scratch-git lever after #6 was rejected (see [Appendix A](#appendix-a-scratch-git-host-right-sizing-verification-dev-11822)). (Note: the parent project's "$5k off $13k/mo" target spans the Whalesync `wsv1-*` projects too — Scratch is a smaller slice, so this is Scratch's realistic contribution, not the whole $5k.)

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
| 6 | ~~**Prod scratch-git VM `e2-highmem-4` → `e2-highmem-2`**~~ — **REJECTED after verification; keep `e2-highmem-4`** (see [Appendix A](#appendix-a-scratch-git-host-right-sizing-verification-dev-11822)). Prod is memory-bound: used-memory recurrently peaks **~25 GiB** and CPU **~4 vCPU**, so 16 GB OOMs (reviving the 2026-04-17 outage) and 32 GiB needs 4 vCPU on E2. Saving redirects to the disk (#2/#3/#9). | `eu-production.tf:71` | Verified via Cloud Monitoring (DEV-11822) | ~~$90~~ → **$0** |
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
| Tier 2 (right-size, verify) | ~$300 (was ~$390; **#6 rejected** — see [Appendix A](#appendix-a-scratch-git-host-right-sizing-verification-dev-11822)) |
| Tier 3 DB (recommended) | ~$155 |
| **Near-term total** | **~$560–$760/mo (≈31–43% of $1,781)** |
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

---

## Appendix A: scratch-git host right-sizing verification (DEV-11822)

*Added 2026-09-17 (Chris Hoefgen, with Claude) — resolves recommendation #6.*

**Determination: keep `e2-highmem-4`; do not downsize.** Recommendation #6 proposed prod `scratch-git`
`e2-highmem-4` (4 vCPU / 32 GiB) → `e2-highmem-2` (2 vCPU / 16 GiB), gated on verifying CPU/RAM. The
measurement below **fails that gate**: prod is genuinely memory- and CPU-bound at peak, so 16 GiB would
OOM and 2 vCPU would saturate. **No terraform change was made.**
([DEV-11822](https://linear.app/whalesync/issue/DEV-11822).)

**Method.** Read-only Cloud Monitoring REST (`projects/<proj>/timeSeries`), both `spv1eu-*` envs,
20–40-day windows at daily alignment. Memory & disk from the Ops Agent installed by
`modules/scratch_git_gce/scripts/startup.sh` (`agent.googleapis.com/*`, filter
`metadata.system_labels."name"="scratch-git"`); CPU from the hypervisor
(`compute.googleapis.com/instance/cpu/utilization`). `state="used"` = non-cache, non-reclaimable memory.

| Signal | **Prod** (`e2-highmem-4`, 4 vCPU / 32 GiB) | **Test** (`e2-medium`, 2 vCPU / 4 GiB) |
|---|---|---|
| Used memory — idle | ~2.5 GiB | ~0.8 GiB |
| Used memory — **peak** | **25.23 GiB** — recurs 20–25 GiB every 1–3 days, ongoing (Sep 1 = 24.2, 3 = 24.6, 9 = 20.9, 14 = 23.5, 15 = 23.1, 17 = 21.3) | **3.06 GiB** (77% of 4 GiB) |
| Used memory — avg *daily peak* | ~16 GiB (`percent_used` daily-max: mean 50.35%, max 77.69%) | ~1.1 GiB |
| Agent-gap check | 480 / 480 hourly points → peaks **real, not** OOM-truncated | — |
| CPU util — steady / peak | ~0.13 (~0.5 vCPU) / **0.995** (~4 vCPU); recent daily peaks 0.4–0.87 | ~0.045 / rare 1.05 spikes |
| Data disk | `/dev/sda`: **25.8 GiB used / 1888 GiB = 1.4% full** (2000 GB `pd-ssd`) | `/dev/sdb`: 0.5 / 46 GiB = 1.1% |

**Interpretation.** `e2-highmem-2` = 16 GiB / 2 vCPU. Prod's recurring **25 GiB working set > 16 GiB → OOM**
(reviving the [2026-04-17 large-pull outage](/docs/ops/incidents/2026-04-17-scratch-git-unresponsive-prod-outage.md)
the VM was upsized to fix), and ~3.5–4 vCPU peaks saturate 2 vCPU. Even the *average* daily peak (~16 GiB)
sits on the ceiling, and it is `state="used"` (no reclaimable slack). On E2, 32 GiB **requires** 4 vCPU
(no 2 vCPU / 32 GiB shape) and E2 is already the cheapest family, so `e2-highmem-4` is the smallest
same-capacity option — **right-sized, not oversized**. **Test** is at its floor (`e2-small` = 2 GiB would
OOM). → no machine-type change in either env.

**Redirect.** The genuine over-provisioning on this host is the **2 TB `pd-ssd` data disk at 1.4% full**
(25.8 GiB used) — pursue #2 (`pd-ssd`→`pd-balanced`), #3 (snapshot cadence), and #9 (shrink 2 TB, gated on
DEV-11253) instead; far larger than #6's ~$90/mo and independent of the memory/CPU the workload needs.
Optionally a 1-year Committed-Use Discount on `e2-highmem-4` (~$55/mo, no size change), or bound
scratch-git peak memory (git GC/pack tuning, pull batching) and re-measure before revisiting #6.

**Reproduction** (read-only; needs an authenticated `gcloud`):

```bash
TOKEN=$(gcloud auth print-access-token)
# P in { spv1eu-production, spv1eu-test }; alignmentPeriod 86400s; ALIGN_MAX (peaks) / ALIGN_MEAN (steady)
# MEM  filter: metric.type="agent.googleapis.com/memory/bytes_used"
#              AND metadata.system_labels."name"="scratch-git" AND metric.label.state="used"
# CPU  filter: metric.type="compute.googleapis.com/instance/cpu/utilization"
#              AND resource.type="gce_instance" AND metric.label.instance_name="scratch-git"
# DISK filter: metric.type="agent.googleapis.com/disk/bytes_used"
#              AND metadata.system_labels."name"="scratch-git"
curl -s -G "https://monitoring.googleapis.com/v3/projects/$P/timeSeries" \
  -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $P" \
  --data-urlencode "filter=<one of the above>" \
  --data-urlencode "interval.startTime=$(date -u -v-20d +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "aggregation.alignmentPeriod=86400s" \
  --data-urlencode "aggregation.perSeriesAligner=ALIGN_MAX"
```

Expect prod used-memory peaks 20–25 GiB, CPU peaks ~0.4–1.0 util, `/dev/sda` ~1–2% full.

---

## Appendix B: production database downsize (DEV-11820)

*Added 2026-09-18 (Chris Hoefgen, with Claude) — carries out recommendation #8a. Terraform MR: [!3350](https://gitlab.com/whalesync/spinner/-/merge_requests/3350) (draft — not yet applied).*

**Determination: downsize is safe — halve the machine tier, keep HA.** Recommendation #8a proposed the `spv1eu-production` primary DB `db-custom-2-8192` (2 vCPU / 8 GB) → `db-custom-1-4096` (1 vCPU / 4 GB); the DB is only ~12 GB and idles at ~15% CPU / ~40% memory. ([DEV-11820](https://linear.app/whalesync/issue/DEV-11820).) The sibling test downsize (DEV-11819) already shipped in commit `fde3f54e3` (`eu-test` → `db-custom-1-4096`, Zonal). Note DEV-11820's issue description says `spv1eu-test`, but that's a copy-paste from DEV-11819 — this work targets **production**.

**General plan:**

- Set `db_tier` from the inherited default `db-custom-2-8192` to **`db-custom-1-4096`** — a one-line override in `terraform/envs/eu-production/eu-production.tf`.
- **Keep HA on** (`db_high_availability = true`, unchanged). This is deliberate: on an HA instance a machine-type change is applied by **failing over to the standby (~60 s)** rather than a multi-minute full restart, so the outage stays well inside the 15-minute target and automatic failover is preserved. HA→Zonal (#8b) is **not** bundled in here.
- **Target tier is gated on a live memory check.** Prod runs at ~40% of 8 GB (~3.2 GB working set) ≈ 80% of a 4 GB instance. Before apply, confirm the real working set, peak CPU, and peak connections in Cloud Monitoring (same read-only `timeSeries` method as Appendix A, filtering the Cloud SQL instance); if 4 GB is tight, fall back to **`db-custom-1-6144`** (1 vCPU / 6 GB). Leave `db_disk_size` unset — Cloud SQL cannot shrink a disk.
- Apply manually in a low-traffic window after an on-demand backup (`cd terraform/envs/eu-production && terraform plan/apply`); the plan must show a single in-place `tier` change — no destroy/replace, no disk resize. Rollback is symmetric: revert the line and re-apply (another ~60 s failover).
- The maintenance-mode tooling now on master (`terraform/tools/maintenance_mode.sh` — LB lockdown + backend quiesce) is available but **not needed** here: it scales the backends to zero, which would last longer than the ~60 s HA-failover blip. A low-traffic window is sufficient.

**Scoped apply — only the Cloud SQL instance.** The maintenance-mode terraform (`6f0bde526`) and the scratch-git snapshot right-size (`06230ff1f`) are merged to master but **not yet applied to prod**, so a plain `terraform apply` in `envs/eu-production` would apply all three pending changes at once. Restrict the apply to the DB instance with `-target`, and apply a saved plan file so you ship exactly what you reviewed:

```bash
cd terraform/envs/eu-production
terraform init

# Plan ONLY the Cloud SQL instance (target = its full module-nested address)
terraform plan \
  -target='module.eu_production.module.db_primary.google_sql_database_instance.primary' \
  -out=db-tier.tfplan

# Review: exactly ONE in-place update to google_sql_database_instance.primary changing
# `tier` (db-custom-2-8192 -> db-custom-1-4096) — no destroy/replace, no disk resize, and
# nothing about Cloud Armor / backend / scratch-git snapshots.

terraform apply db-tier.tfplan   # never -auto-approve
```

`-target` pulls in the target plus its *upstream* dependencies (the VPC/private-IP wiring and the random name suffix — none of which change), not its dependents, so the module's `google_sql_user` / `google_sql_database` resources are left alone. Terraform prints a *"Resource targeting is in effect … not for routine use"* warning — expected for this one-change-at-a-time apply. The maintenance-mode and DEV-11823 snapshot changes stay pending in prod and must be applied separately; the next untargeted `terraform plan` will surface them.

**Savings:**

| Target tier | vCPU / RAM | Est. saving vs `db-custom-2-8192` |
|---|---|---:|
| `db-custom-1-4096` (primary target) | 1 / 4 GB | **~$52/mo** |
| `db-custom-1-6144` (memory fallback) | 1 / 6 GB | ~$26/mo |

The instance is Regional/HA, so the tier is billed for both the primary and the standby — halving the vCPU saves on both. Confirm the exact `europe-west1` figure on the GCP Pricing Calculator before apply.
