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

The `scratch_git_gce` module has an optional `disk_source_snapshot` variable. When set, Terraform adds a `snapshot` argument to the `google_compute_disk` resource. This is a ForceNew field, so Terraform will:

1. Destroy the existing VM (because its attached disk is changing)
2. Destroy the existing data disk
3. Create a new data disk from the snapshot
4. Create a new VM with the restored disk attached

This is a clean approach — no manual state surgery required. The downside is that the disk and VM are fully replaced, so there is downtime while Terraform recreates them.

## Procedure

### 1. Identify the target snapshot

List recent snapshots of the scratch-git data disk:

```bash
gcloud compute snapshots list \
  --project=spv1eu-production \
  --filter="sourceDisk~scratch-git-data" \
  --sort-by=~creationTimestamp \
  --limit=10 \
  --format="table(name,creationTimestamp,diskSizeGb,status)"
```

Snapshots are taken hourly (configured via `scratch_git_snapshot_hours_in_cycle = 1` in `terraform/envs/eu-production/eu-production.tf`). Pick the most recent `READY` snapshot that predates the corruption.

Record the snapshot name, e.g. `scratch-git-data-europe-west1-b-20260318174907-jtlq87v8`.

### 2. Set the snapshot variable

Edit `terraform/envs/eu-production/eu-production.tf` and add the snapshot variable to the module block:

```hcl
module "eu_production" {
  source = "../../modules/env"

  # ... existing config ...

  # Scratch Git
  enable_scratch_git                  = true
  scratch_git_boot_disk_size_gb       = 20
  scratch_git_snapshot_hours_in_cycle = 1
  scratch_git_disk_size_gb            = 50
  scratch_git_disk_source_snapshot    = "projects/spv1eu-production/global/snapshots/SNAPSHOT_NAME"  # <-- add this

  # ...
}
```

Replace `SNAPSHOT_NAME` with the name from step 1.

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

Verify the plan only affects scratch-git resources and nothing else.

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

### 6. Remove the snapshot variable

Remove the `scratch_git_disk_source_snapshot` line from `eu-production.tf`:

```diff
- scratch_git_disk_source_snapshot    = "projects/spv1eu-production/global/snapshots/SNAPSHOT_NAME"
```

Then plan and apply to confirm no changes:

```bash
terraform plan
```

The plan should show **no changes** — removing a `null`-defaulted snapshot from an already-created disk produces no diff.

If the plan DOES show a change, commit the change to the scratch_git_disk_source_snapshot instead - that way later terraform plans won't try to undo the change by recreating the same resources again.

## Data Loss Window

Snapshots are taken hourly. The maximum data loss is up to 1 hour of writes. Any repos that were written to between the snapshot and the corruption will need to be re-synced from their external sources (Airtable, Webflow, etc.) via a pull operation.

## Rollback

If the restored disk also has issues, repeat the procedure with an older snapshot. Snapshots are retained for 14 days.
