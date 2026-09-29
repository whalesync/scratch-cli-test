# Runbook: Full Scratch-Git Disk Restore from Snapshot

Restore the production scratch-git persistent disk from a recent automated snapshot when the disk is corrupted or otherwise unusable.

## When to Use

- The scratch-git data disk is corrupted and the service cannot start
- Filesystem errors are preventing repos from being read/written
- You need to roll back to a known-good state

## Prerequisites

- `gcloud` CLI authenticated with a user in `role_operations@whalesync.com`
- Terraform >= 1.13.4 with access to the `spv1eu-production-tfstate` GCS backend
- Access to the `spv1eu-production` GCP project

## How It Works

The env variable `scratch_git_disk_source_snapshot` (module variable `disk_source_snapshot`) sets the `snapshot` argument of `google_compute_disk.data`. Both envs already set it permanently, to the snapshot the disk was last restored from (DEV-11823). `snapshot` is a ForceNew field, so pointing it at a different snapshot makes Terraform:

1. Destroy the existing VM (`replace_triggered_by` the disk)
2. Destroy the existing data disk
3. Create a new data disk from the snapshot
4. Create a new VM with the restored disk attached

This is a clean approach — no manual state surgery required. The downside is that the disk and VM are fully replaced, so there is downtime while Terraform recreates them.

> ⚠️ **Never set `scratch_git_disk_source_snapshot` back to `null` (or delete the line).** That is also a ForceNew change: Terraform recreates the disk with no source, i.e. **EMPTY**, and the VM with it.

## Procedure

### 1. Identify the target snapshot

List recent snapshots of the **current** scratch-git data disk:

```bash
DISK_ID=$(gcloud compute disks describe scratch-git-data \
  --zone=europe-west1-b --project=spv1eu-production --format='value(id)')

gcloud compute snapshots list \
  --project=spv1eu-production \
  --filter="sourceDiskId=$DISK_ID" \
  --sort-by=~creationTimestamp \
  --limit=10 \
  --format="table(name,creationTimestamp,diskSizeGb,status)"
```

Filter by disk **ID**, not name. Earlier disks named `scratch-git-data` (e.g. the pre-DEV-11823 2000 GB disk) left snapshots that match the name. A snapshot can only be restored onto a disk at least as large as its `diskSizeGb`. If you use one of those older snapshots, raise `scratch_git_disk_size_gb` to match.

Snapshots are taken every `scratch_git_snapshot_hours_in_cycle` hours (prod: 4, test: 12; see `terraform/envs/<env>/<env>.tf`). Pick the most recent `READY` snapshot that predates the corruption.

Record the snapshot name, e.g. `scratch-git-data-europe-west1-b-20260318174907-jtlq87v8`.

### 2. Set the snapshot variable

Edit `terraform/envs/eu-production/eu-production.tf` and **replace the value** of the existing `scratch_git_disk_source_snapshot` line in the module block:

```hcl
module "eu_production" {
  source = "../../modules/env"

  # ... existing config ...

  # Scratch Git
  scratch_git_disk_size_gb          = 200
  scratch_git_disk_type             = "pd-balanced"
  scratch_git_disk_source_snapshot  = "projects/spv1eu-production/global/snapshots/SNAPSHOT_NAME" # <-- change this value
  scratch_git_initialize_filesystem = false

  # ...
}
```

Replace `SNAPSHOT_NAME` with the name from step 1. Keep `scratch_git_initialize_filesystem = false`: you are restoring a populated disk, not formatting a blank one.

### 3. Review the plan

```bash
cd terraform/envs/eu-production
terraform plan
```

You should see Terraform planning to:

- **Destroy** `google_compute_instance.scratch_git` (the VM)
- **Destroy** `google_compute_disk.data` (the data disk)
- **Create** a new `google_compute_disk.data` from the snapshot
- **Create** a new `google_compute_instance.scratch_git`

Verify that the new disk shows `snapshot = ".../snapshots/SNAPSHOT_NAME"`. If the new disk has no `snapshot`, it would be created **EMPTY**, so do not apply. Also verify the plan only affects scratch-git resources and nothing else.

### 4. Apply

```bash
terraform apply
```

This will take a few minutes. The VM startup script will mount the restored disk, install Docker, pull the scratch-git image, and start the container.

### 5. Verify the service is healthy

```bash
# Open a tunnel
gcloud compute ssh scratch-git \
  --project=spv1eu-production \
  --zone=europe-west1-b \
  --tunnel-through-iap \
  -- -N -L 3100:127.0.0.1:3100 &

# Check health (in another terminal)
curl http://127.0.0.1:3100/health
```

The health endpoint returns the server status, build version, and repos directory.

### 6. Keep the snapshot line, and re-apply the dropped bindings

**Do not remove the `scratch_git_disk_source_snapshot` line.** Commit the new value. `snapshot` is ForceNew and stays in Terraform state, so removing the line (or setting it to `null`) makes Terraform destroy and recreate the disk **EMPTY**. Never delete the snapshot it references either: a later recreate from it (e.g. a disk type change) would fail.

Recreating the disk and VM drops bindings that Terraform only notices on the **next** plan. Run it again:

```bash
terraform plan
```

Expect **no** disk or VM replacement, only these re-creates. Apply them:

- `google_compute_disk_resource_policy_attachment.snapshot_attachment`: the snapshot schedule. **Until it is re-applied, the new disk gets no automated snapshots.**
- `google_iap_tunnel_instance_iam_member.readonly_sa_scratch_git_tunnel` and `google_compute_instance_iam_member.readonly_sa_scratch_git_oslogin`: read-only SA access to the VM.

```bash
terraform apply
```

Confirm the schedule is attached again (the output must not be empty):

```bash
gcloud compute disks describe scratch-git-data \
  --zone=europe-west1-b --project=spv1eu-production --format='value(resourcePolicies)'
```

## Data Loss Window

Snapshots are taken every `scratch_git_snapshot_hours_in_cycle` hours. In prod that's every 4 hours, so up to 4 hours of writes can be lost. Any repos that were written to between the snapshot and the corruption will need to be re-synced from their external sources (Airtable, Webflow, etc.) via a pull operation. Unpublished edits on the `dirty` branch made after the snapshot cannot be recovered this way.

## Rollback

If the restored disk also has issues, repeat the procedure with an older snapshot. Automated snapshots of the live disk are kept for `scratch_git_snapshot_retention_days` (prod: 7 days).

The schedule uses `on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"`. Once a disk is deleted, including the one this procedure replaces, its automated snapshots are kept **permanently** and never age out. They remain available as older restore points (step 1 describes the size caveat). Once they're no longer needed, delete them manually, but never the snapshot `scratch_git_disk_source_snapshot` references.
