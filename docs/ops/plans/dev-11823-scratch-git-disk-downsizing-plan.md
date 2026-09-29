# Scratch-git disk downsizing — cost-reduction plan (test + production)

- **Created:** 2026-09-18
- **Author:** Chris Hoefgen (with Claude)
- **Linear:** [DEV-11823](https://linear.app/whalesync/issue/DEV-11823) (parent [DEV-11785](https://linear.app/whalesync/issue/DEV-11785) · project *Reduce GCP Costs*)
- **Status:** In progress — **MR1 done & applied** ([!3351](https://gitlab.com/whalesync/spinner/-/merge_requests/3351)); **MR2 test leg done & verified** (2026-09-18, [!3356](https://gitlab.com/whalesync/spinner/-/merge_requests/3356) — test disk now 20 GB `pd-balanced`, baseline SHA matched source/copy/after); **MR2 prod leg pending** (scheduled maintenance window).
- **GCP projects:** `spv1eu-production`, `spv1eu-test` (region `europe-west1`, zone `europe-west1-b`)

> When fully implemented, move this doc to `docs/ops/plans/resolved/` (per `docs/ops/CLAUDE.md`).

## Problem statement

The production `scratch-git` GCE VM's data disk is a **2000 GB `pd-ssd`** that is only **~1.4% full (25.8 GiB used)** — the single biggest scratch-git cost item (~$340/mo run-rate). The 2 TB was a **panic stopgap** (commit `45d678a`, 2026-08-14) for a staging-directory leak (**DEV-11253**) that has since been fixed by the staging-dir reaper (**DEV-11317**, deployed) — so the disk is now safe to right-size. Downsizing the VM host itself was investigated and **rejected** (**DEV-11822**: prod is genuinely memory/CPU-bound at `e2-highmem-4`), leaving the disk as the primary lever. Test runs a 50 GB `pd-ssd` (~0.5 GiB used).

This plan reduces scratch-git disk cost in both environments, per levers #2 / #3 / #9 of the hosting cost review (`docs/ops/dev-11808-scratch-hosting-cost-review.md`).

## Summary of change

Two isolated terraform steps, rolled out **test-first**:

| Step | Change | Downtime | Est. saving | Status |
|---|---|---|---|---|
| **MR1** | Snapshot cadence hourly → 4h + retention 14 → 7d; plumb `disk_type` & `snapshot_retention_days` per-env | **None** | ~$30/mo | **Done** ([!3351](https://gitlab.com/whalesync/spinner/-/merge_requests/3351)), applied test + prod |
| **MR2** | Migrate prod data disk **2000 GB `pd-ssd` → 200 GB `pd-balanced`** (test → 20 GB) — combined type-change + shrink | **Maintenance window (prod)** | ~$320/mo | **Test done** ([!3356](https://gitlab.com/whalesync/spinner/-/merge_requests/3356)); prod pending |
| (deferred) | Early-warning disk alert on the loose-object / staging-orphan gauges | None | — | Deferred (needs `terraform plan` validation) |

Estimated total once MR2 lands: **~$350/mo** off the ~$340/mo current disk + snapshot spend.

## Current state (verified terraform)

Module `terraform/modules/scratch_git_gce/`:
- `google_compute_disk.data` (zonal): `type = var.disk_type`, `size = var.disk_size_gb`, `snapshot = var.disk_source_snapshot`; attached inline as `device_name = "data-disk"` → `/dev/disk/by-id/google-data-disk`, mounted at **`/mnt/disks/data`** (repos under `/mnt/disks/data/repos/{org}/{wkb}/{coa}.git`, staging under `/mnt/disks/data/staging/{jobId}`).
- Snapshot schedule = `google_compute_resource_policy.snapshot_schedule` (+ `..._disk_resource_policy_attachment`), `on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"`.
- No `lifecycle`/`prevent_destroy` on the disk; the VM has `replace_triggered_by = [google_compute_disk.data.id]` and `ignore_changes = [metadata_startup_script]`.
- `scripts/startup.sh` formats **only** when `initialize_filesystem = true` and the device is unformatted; there is **no `resize2fs`/`growpart`** anywhere.

| Env | env file | disk size | cadence | disk_type | retention |
|---|---|---|---|---|---|
| prod | `terraform/envs/eu-production/eu-production.tf` | 2000 GB | 4h (was 1h) | pd-ssd | 7d (was 14d) |
| test | `terraform/envs/eu-test/eu-test.tf` | 50 GB | 12h | pd-ssd | 7d (was 14d) |

Existing safety net: `scratch_git_disk_usage_too_high` alert at **80%** (`terraform/modules/env/monitoring.tf`, runbook `runbook-scratch-git-disk-usage.md`).

## Downtime evaluation (DEV-11823 explicitly asks for this)

- **MR1:** **zero downtime** — only the snapshot `google_compute_resource_policy` (+ attachment) is recreated; the data disk and VM keep serving. Already applied live to both envs with no interruption.
- **MR2 · test:** run **anytime**; test tolerates downtime and needs no maintenance mode.
- **MR2 · prod:** **requires a scheduled maintenance window**. The disk `type` is a ForceNew field and `replace_triggered_by` recreates the VM with it, so scratch-git is unavailable during the recreate. Put the app into **maintenance mode** for the window using `terraform/tools/maintenance_mode.sh` (Cloud Armor 503 + Cloud Run scale-to-zero — now merged (`runbook-maintenance-mode.md`); **not yet exercised on prod — dry-check with `maintenance_mode.sh production status` before the window**). We use a **stop-first single copy** — quiesce by stopping the scratch-git containers, then one copy (`tar` — the VM image has no `rsync`; no live pre-copy) — so there is no git-gc-vs-writer race. The whole ~26 GiB copy runs **inside** the window, but it is a fast local disk-to-disk transfer; the window covers stop + copy + snapshot + terraform recreate + health check — **estimate ~20–40 min**.

## Hard constraints that shape MR2

1. **Type change is destructive as coded.** Changing `disk.type` destroys+recreates the disk and (via `replace_triggered_by`) the VM. Data survives only via a snapshot restore (`disk_source_snapshot`).
2. **You cannot shrink `disk_size_gb` in place** — GCP rejects a size decrease and `terraform apply` errors. A real shrink means provisioning a new, smaller disk and migrating the data.
3. **A snapshot restore cannot target a disk smaller than its source (2000 GB).** So the shrink must copy data onto a small disk first, then snapshot *that* small disk, then restore from it.
4. **Disk data is precious.** `main` is re-pullable, but the `dirty` branch holds approved-but-unpublished edits + git history that are **not** re-hydratable from the external services. Preserve the data; never wipe-and-repull.
5. **Break-glass required.** The per-dev read-only SA lands in the restricted `gitops-*` tier; the mount/copy steps need a `role_operations@whalesync.com` root SSH. `terraform apply` on `envs/*` needs a deploy owner (the read-only SA gets 403 on plan).

## MR1 — snapshot cost right-size + variable plumbing (DONE)

Shipped in [!3351](https://gitlab.com/whalesync/spinner/-/merge_requests/3351), applied to test + prod with no downtime:
- Added `scratch_git_disk_type` (default `pd-ssd`) and `scratch_git_snapshot_retention_days` (default `14`) to `terraform/modules/env` and passed both through to the `scratch_git_gce` module. `disk_type` stays at `pd-ssd` (a no-op) and prepares MR2's flip to `pd-balanced`.
- Prod: `scratch_git_snapshot_hours_in_cycle` `1 → 4`, `scratch_git_snapshot_retention_days = 7`. Test: retention `→ 7` (cadence unchanged at 12h).

Plan gate used: the plan showed only `google_compute_resource_policy.snapshot_schedule` (+ attachment) changing — never `google_compute_disk.data` or the VM.

## MR2 — migrate to a right-sized `pd-balanced` disk (PENDING)

Combines the type change (#2) and the shrink (#9) in one operation, since both need the same disruptive recreate. Method (both envs): **stop the scratch-git containers → single copy (`tar`) onto a temp disk → snapshot the temp disk → recreate the managed disk from that snapshot** via the existing `runbook-scratch-git-full-disk-restore.md`. The temp disk stays out of terraform state.

### Target size

- **Prod → 200 GB `pd-balanced`**: ~8× headroom over 25.8 GiB; covers concurrent transient staging + git GC full-repack scratch (~2× a repo) + organic growth; ~1200 baseline pd-balanced IOPS. Marginal cost vs 100 GB is only ~$10/mo — cheap insurance (the disk once hit the 80% alert at 250 GB *during the leak*). Finalize against a fresh `sudo gitops-disk` and disk read/write-ops metrics before executing.
- **Test → 20 GB `pd-balanced`** (rehearsal of the exact procedure).

### Prerequisites

1. MR1 merged (done).
2. Reaper healthy in prod (staging-orphan bytes ~0); fresh `sudo gitops-disk` read to confirm true usage and finalize the target size.
3. Verify prod disk IO peaks (read/write ops + throughput) in Cloud Monitoring support `pd-balanced` at 200 GB.
4. **Maintenance mode available** (`terraform/tools/maintenance_mode.sh`) and a scheduled window agreed.
5. Break-glass `role_operations@whalesync.com` root SSH access lined up.

### Prod preflight (read-only — run before the window)

Operationalizes the prerequisites above. All read-only; run as the operator (repo policy: don't run `gcloud` from an agent session).

1. **Finalize target size + disk health** — `terraform/tools/connect_to_git_service_ssh.sh production`, then on the VM:
   - `sudo gitops-disk` — confirm true usage (~26 GiB) + `ext4`; 200 GB keeps ≥8× headroom. Reaper healthy = staging-orphan bytes ~0.
   - `sudo gitops-ps` — containers up, no restart loop.
   - (The read-only SA lands in the restricted tier, which may run these `gitops-*` wrappers.)
2. **IO headroom** — Cloud Monitoring → Metrics Explorer (`spv1eu-production`): peak `compute.googleapis.com/instance/disk/{read,write}_ops_count` and `{read,write}_bytes_count` for the `scratch-git-data` disk vs pd-balanced@200 GB (~1200 baseline IOPS, ~140 MB/s). If using `gcloud monitoring`, pass `--billing-project=spv1eu-production`.
3. **Maintenance-mode dry check** — `terraform/tools/maintenance_mode.sh production status` (read-only: current Cloud Armor rule + Cloud Run scaling). Confirms the tool authenticates for prod. **Do not** run `on` outside the window (it has not been exercised on prod).
4. **Break-glass** — confirm `role_operations@whalesync.com` root SSH is available (the `mkfs`/`tar`/`docker stop` steps need root; the read-only SA cannot).
5. **Window + comms** — confirm the maintenance-window time and draft the Slack notice (`maintenance_mode.sh` posts via the env webhook unless `--no-notify`).

### Runbook (run on TEST first, verify + soak, then PROD)

Values below are for prod; substitute `spv1eu-test` / 20 GB for test.

```bash
# 0. (prod only) Enable maintenance mode for the window
terraform/tools/maintenance_mode.sh production on      # usage: <env> <command>; dry-check `... production status` first

# 1. Safety snapshot of the current disk (independent of the schedule)
gcloud compute snapshots create scratch-git-data-premigrate-$(date +%Y%m%d%H%M) \
  --source-disk=scratch-git-data --source-disk-zone=europe-west1-b \
  --project=spv1eu-production

# 2. Provision + attach a temp pd-balanced disk (out-of-band; NOT in terraform state)
gcloud compute disks create scratch-git-data-migrate \
  --type=pd-balanced --size=200 --zone=europe-west1-b --project=spv1eu-production
gcloud compute instances attach-disk scratch-git \
  --disk=scratch-git-data-migrate --device-name=migrate-disk \
  --zone=europe-west1-b --project=spv1eu-production

# 3. Copy the data — runs ON THE VM (break-glass root SSH). First push the baseline recorder, then SSH in:
gcloud compute scp --tunnel-through-iap terraform/tools/scratch_git_migration_baseline.sh \
  scratch-git:/tmp/ --zone=europe-west1-b --project=spv1eu-production
gcloud compute ssh scratch-git --project=spv1eu-production --zone=europe-west1-b --tunnel-through-iap
```

Then, on the VM (stop-first, single copy — as a `role_operations@` identity you land sudo-capable):

```bash
sudo -i
sudo -l                                          # confirm (ALL) NOPASSWD = root tier

# format + mount the temp disk (must NOT collide with google-data-disk / /mnt/disks/data)
mkfs.ext4 -F /dev/disk/by-id/google-migrate-disk
mkdir -p /mnt/disks/data-new
mount /dev/disk/by-id/google-migrate-disk /mnt/disks/data-new

# QUIESCE: stop the app containers (leave the proxy) -- halts writers AND after-job git gc
docker ps --format '{{.Names}}'                  # confirm names, then:
docker stop scratch-git-blue scratch-git-green

# COPY -- the minimal VM image has NO rsync; use tar (or: cp -a /mnt/disks/data/. /mnt/disks/data-new/)
tar -C /mnt/disks/data -cf - --numeric-owner --xattrs --acls . \
  | tar -C /mnt/disks/data-new -xf - --numeric-owner --xattrs --acls

# VERIFY: sizes match, ref fingerprints match, fsck clean
du -xsh /mnt/disks/data /mnt/disks/data-new
bash /tmp/scratch_git_migration_baseline.sh /mnt/disks/data      source
bash /tmp/scratch_git_migration_baseline.sh /mnt/disks/data-new  copy
#   -> the two MANIFEST SHA256 must MATCH, fsck failures: 0.  WRITE DOWN that SHA256.

sync && umount /mnt/disks/data-new
exit                                             # leave root, then exit SSH
```

Back on your laptop:

```bash
# 4. Snapshot the temp (now 200 GB-source, unmounted) disk
gcloud compute snapshots create scratch-git-data-shrunk-$(date +%Y%m%d%H%M) \
  --source-disk=scratch-git-data-migrate --source-disk-zone=europe-west1-b \
  --project=spv1eu-production

# 5. Detach the temp disk (KEEP it as a rollback path — delete in step 9 after verify).
#    Detaching BEFORE terraform keeps the live VM matching the module's single inline
#    attached_disk, so the step-6 plan stays clean.
gcloud compute instances detach-disk scratch-git --disk=scratch-git-data-migrate \
  --zone=europe-west1-b --project=spv1eu-production

# 5b. Download the baseline reports off the VM BEFORE terraform — step 6 recreates the VM and wipes /tmp,
#     losing the pre-migration source/copy manifests you compare the post-restore run against.
#     (If scp is permission-denied, `sudo chmod -R a+r /tmp/scratch-git-baseline` on the VM first.)
gcloud compute scp --tunnel-through-iap --recurse scratch-git:/tmp/scratch-git-baseline \
  ./dev-11823-baseline/ --zone=europe-west1-b --project=spv1eu-production
```

6. **Terraform (deploy owner, isolated MR)** — in `eu-production.tf` set:
   ```hcl
   scratch_git_disk_size_gb         = 200
   scratch_git_disk_type            = "pd-balanced"
   scratch_git_disk_source_snapshot = "projects/spv1eu-production/global/snapshots/scratch-git-data-shrunk-<ts>"
   scratch_git_initialize_filesystem = false
   ```
   `terraform plan` must show **only** destroy+recreate of `google_compute_disk.data` (from the snapshot, at 200 GB `pd-balanced`) + the VM recreate — nothing else. `terraform apply` (never `-auto-approve`).
7. **Verify** (see below). **Keep the `scratch_git_disk_source_snapshot` line committed — do NOT remove it.** `snapshot` is a ForceNew field, so clearing it makes Terraform destroy+recreate the disk **empty** (and the VM via `replace_triggered_by`). The committed config permanently references the shrunk snapshot, and that snapshot must be **retained** (see cleanup). A re-plan should show no disk/VM replacement. *(To fully decouple later: `terraform state rm` the disk then `terraform import` it — re-reads it with `snapshot` unset. State surgery; do it deliberately.)*
8. **(prod)** `terraform/tools/maintenance_mode.sh production off`.
9. **Cleanup:** after a soak, delete the temp disk (`scratch-git-data-migrate`) and the **premigrate** snapshot; **keep the shrunk snapshot** (the disk's committed `snapshot` reference points at it — deleting it would break a future recreate). The old disk's auto-snapshots do **not** age out: `on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"` keeps them permanently once the recreate deletes that disk. List them with `--filter='sourceDiskId=<old disk id> AND autoCreated=true'` and delete them deliberately, or keep them.

### Diagram

```
BEFORE                                          AFTER
scratch-git VM (e2-highmem-4, unchanged)        scratch-git VM (e2-highmem-4, recreated)
  └─ google_compute_disk.data                     └─ google_compute_disk.data
       2000 GB pd-ssd  (25.8 GiB used, 1.4%)           200 GB pd-balanced (~26 GiB used)

Migration path (data-preserving, prod = maintenance window):
  data (2000 pd-ssd) --tar copy--> temp disk (200 pd-balanced) --snapshot--> small snapshot
                                                                              │
                     terraform disk_source_snapshot restore  <───────────────┘
                     → new google_compute_disk.data = 200 GB pd-balanced
```

## Verification

- **Cost:** validate in the GCP Pricing Calculator (europe-west1); confirm the drop on the next billing cycle (test first).
- **Plan gates:** MR1 → only the snapshot policy; MR2 → only `google_compute_disk.data` + VM. Abort on any unexpected resource.
- **Health:** `terraform/tools/connect_to_git_service.sh <env>` → `curl http://127.0.0.1:3100/health`; `connect_to_git_service_ssh.sh <env>` → `sudo gitops-disk` (new size + correct usage + ext4) and `sudo gitops-ps` (containers up, no restart loop).
- **Data integrity:** run `terraform/tools/scratch_git_migration_baseline.sh` (as root) on the quiesced source, again on the copied temp disk, and once more after the restore — the printed `MANIFEST SHA256` must match all three (it fingerprints every repo's `main`/`dirty`/other refs). Also spot-check repos (`sudo gitops-git <org/wkb/coa> log`), confirm `dirty`-branch edits survived; optionally re-verify a workbook in the app.
- **Monitoring:** confirm the 80% disk alert still evaluates against the smaller disk (its absolute headroom is now smaller — a plus for sensitivity).

## Rollback (MR2)

Re-point `scratch_git_disk_source_snapshot` to the pre-migration 2 TB snapshot (step 1) and `terraform apply` — restores the prior 2 TB `pd-ssd` state. Any retained auto-snapshot works too. The pre-migration snapshot and the temp-disk snapshot both exist until explicit cleanup.

## Key decisions

- **Combined type-change + shrink** in one window (not staged) — both require the same recreate, so one maintenance window captures the full ~$320/mo.
- **200 GB** prod target (not 100 GB) — the ~$10/mo delta buys IOPS + headroom insurance.
- **Data-preserving migration** (`tar` copy → small snapshot → restore), never wipe-and-repull, because the `dirty` branch holds non-re-hydratable edits. The copy is **stop-first, single `tar` copy** (quiesce by stopping the containers; full outage during the copy) — chosen over live pre-copy + delta to remove the git-gc-vs-writer race entirely; the copy is a fast local disk-to-disk transfer.
- **Early-warning alert deferred**, not dropped — the repo currently has **zero** PromQL/GMP alerts (all `monitoring.tf` policies are `condition_threshold`), so the loose-object / staging-orphan gauges (`scratch_git_repo_loose_objects`, `scratch_git_staging_orphan_bytes`) are emitted but unalerted. Adding one is greenfield and must be validated with a real `terraform plan` before it can be trusted; it should land before MR2's prod shrink since a smaller disk has less absolute headroom.

## Follow-ups

- Execute MR2 (test → prod) in a maintenance window once the maintenance-mode tooling is confirmed available.
- Land the growth-signal alert MR (validated).
- After implementation: refresh `runbook-scratch-git-disk-usage.md` / `runbook-scratch-git-full-disk-restore.md` for the new size/type, and move this doc to `docs/ops/plans/resolved/`.
