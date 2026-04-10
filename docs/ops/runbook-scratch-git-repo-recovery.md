# Runbook: Recover an Individual Repo from a Scratch-Git Snapshot

Spin up a temporary VM from a snapshot, tunnel into it, and copy a specific repo's data back to the production scratch-git instance.

## When to Use

- A single repo is corrupted but the rest of the disk is fine
- A repo was accidentally deleted and needs to be restored
- You need to inspect a repo's historical state without affecting production

## Prerequisites

- `gcloud` CLI authenticated with a user in `role_operations@whalesync.com`
- Terraform >= 1.13.4 with access to the `spv1eu-production-tfstate` GCS backend
- Access to the `spv1eu-production` GCP project
- The repo ID you want to recover (see below for format)

## Procedure

### 1. Find the repo ID

The repo ID is a composite of three IDs separated by slashes:

```
<org_id>/<workbook_id>/<connectoraccount_id>
```

For example: `org_TGz7bDxFNQ/wkb_AMg9vYzYIs/coa_arj2boBfoM`

When used in API URLs, the slashes must be percent-encoded (`%2F`):

```
org_TGz7bDxFNQ%2Fwkb_AMg9vYzYIs%2Fcoa_arj2boBfoM
```

You can find these IDs in the database:

```sql
SELECT o.id AS org_id, w.id AS workbook_id, ca.id AS connectoraccount_id
FROM workbooks w
JOIN organizations o ON o.id = w.organization_id
JOIN connector_accounts ca ON ca.workbook_id = w.id
WHERE w.name = 'My Workbook';
```

On disk, the slashes become directory separators, so repos are stored at:

```
/mnt/disks/data/repos/<org_id>/<workbook_id>/<connectoraccount_id>.git
```

### 2. Identify the target snapshot

```bash
gcloud compute snapshots list \
  --project=spv1eu-production \
  --filter="sourceDisk~scratch-git-data" \
  --sort-by=~creationTimestamp \
  --limit=10 \
  --format="table(name,creationTimestamp,diskSizeGb,status)"
```

Pick a snapshot from before the repo was corrupted or deleted.

### 3. Deploy the temporary test VM via Terraform

Edit `terraform/envs/eu-production/eu-production.tf` and add the snapshot test resources. Replace `SNAPSHOT_NAME` with the actual snapshot name:

```hcl
## ---------------------------------------------------------------------------------------------------------------------
## Scratch Git Snapshot Recovery (temporary — remove after recovery)
## ---------------------------------------------------------------------------------------------------------------------

locals {
  snapshot_test_project = "spv1eu-production"
  snapshot_test_zone    = "europe-west1-b"
  snapshot_test_region  = "europe-west1"
  snapshot_test_name    = "scratch-git-snapshot-test"
  snapshot_name         = "SNAPSHOT_NAME"
  snapshot_test_labels = {
    "terraform" = "true"
    "env"       = "test"
    "purpose"   = "snapshot-restore-test"
  }
}

provider "google" {
  project = local.snapshot_test_project
}

data "google_compute_network" "production_vpc" {
  name    = "eu-production-vpc"
  project = local.snapshot_test_project
}

data "google_compute_subnetwork" "production_subnet" {
  name    = "eu-production-vpc-europe-west1-subnet-1"
  region  = local.snapshot_test_region
  project = local.snapshot_test_project
}

resource "google_compute_disk" "snapshot_test_data" {
  name     = "${local.snapshot_test_name}-data"
  type     = "pd-ssd"
  zone     = local.snapshot_test_zone
  size     = 50
  snapshot = "projects/${local.snapshot_test_project}/global/snapshots/${local.snapshot_name}"
  project  = local.snapshot_test_project
  labels   = local.snapshot_test_labels
}

resource "google_compute_instance" "snapshot_test" {
  name         = local.snapshot_test_name
  machine_type = "e2-medium"
  zone         = local.snapshot_test_zone
  project      = local.snapshot_test_project

  deletion_protection = false
  tags                = ["scratch-git"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
    }
  }

  attached_disk {
    source      = google_compute_disk.snapshot_test_data.self_link
    device_name = "data-disk"
    mode        = "READ_WRITE"
  }

  network_interface {
    network    = data.google_compute_network.production_vpc.self_link
    subnetwork = data.google_compute_subnetwork.production_subnet.self_link
  }

  service_account {
    email  = "scratch-git-service-account@${local.snapshot_test_project}.iam.gserviceaccount.com"
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true

  metadata = {
    block-project-ssh-keys = "true"
    enable-oslogin         = "TRUE"
  }

  metadata_startup_script = <<-EOT
    #!/bin/bash
    set -e

    DEVICE="/dev/disk/by-id/google-data-disk"
    MOUNT_POINT="/mnt/disks/data"

    for i in $(seq 1 30); do
      [ -e "$DEVICE" ] && break
      echo "Waiting for $DEVICE ... ($i)"
      sleep 2
    done

    mkdir -p "$MOUNT_POINT"
    mountpoint -q "$MOUNT_POINT" || mount "$DEVICE" "$MOUNT_POINT"

    if ! command -v docker &>/dev/null; then
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io
      systemctl enable --now docker
    fi

    gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet

    docker stop scratch-git 2>/dev/null || true
    docker rm scratch-git 2>/dev/null || true
    docker system prune -af

    docker pull europe-west1-docker.pkg.dev/spv1eu-production/eu-production-registry/spinner-scratch-git:latest

    docker run -d \
      --name scratch-git \
      --restart unless-stopped \
      --log-driver=gcplogs \
      --log-opt labels=service,env \
      --label service=scratch-git \
      --label env=spv1eu-production \
      -p 3100:3100 \
      -p 3101:3101 \
      -v /mnt/disks/data:/data \
      europe-west1-docker.pkg.dev/spv1eu-production/eu-production-registry/spinner-scratch-git:latest
  EOT

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
}
```

Apply with targeting to avoid affecting other resources:

```bash
cd terraform/envs/eu-production

terraform plan \
  -target=google_compute_disk.snapshot_test_data \
  -target=google_compute_instance.snapshot_test

# Review the plan, then apply
terraform apply \
  -target=google_compute_disk.snapshot_test_data \
  -target=google_compute_instance.snapshot_test
```

### 4. Wait for the VM to be ready

The startup script installs Docker and pulls the scratch-git image. This takes 2-5 minutes on first boot. Check progress via serial port output:

```bash
gcloud compute instances get-serial-port-output scratch-git-snapshot-test \
  --project=spv1eu-production \
  --zone=europe-west1-b 2>&1 | tail -30
```

### 5. Open tunnels to both instances

Open two SSH tunnels — one to the snapshot test VM and one to production. Use different local ports to avoid conflicts:

```bash
# Terminal 1: tunnel to snapshot test VM on local port 3200
gcloud compute ssh scratch-git-snapshot-test \
  --project=spv1eu-production \
  --zone=europe-west1-b \
  --tunnel-through-iap \
  -- -N -L 3200:127.0.0.1:3100

# Terminal 2: tunnel to production VM on local port 3100
# (or use the existing connect_to_git_service.sh script)
./terraform/tools/connect_to_git_service.sh production
```

### 6. Verify the repo exists on the snapshot VM

In all API examples below, `ENCODED_REPO_ID` is the percent-encoded repo ID.
For example, if the repo is `org_TGz7bDxFNQ/wkb_AMg9vYzYIs/coa_arj2boBfoM`, use:

```bash
REPO_ID="org_TGz7bDxFNQ/wkb_AMg9vYzYIs/coa_arj2boBfoM"
ENCODED_REPO_ID=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$REPO_ID', safe=''))")
# Result: org_TGz7bDxFNQ%2Fwkb_AMg9vYzYIs%2Fcoa_arj2boBfoM
```

```bash
# Check the snapshot VM is healthy
curl http://127.0.0.1:3200/health

# Verify the repo exists
curl "http://127.0.0.1:3200/api/repo/manage/${ENCODED_REPO_ID}/exists"
```

### 7. Inspect the repo (optional)

Before recovering, you can inspect the repo's contents on the snapshot:

```bash
# List root directory
curl "http://127.0.0.1:3200/api/repo/read/${ENCODED_REPO_ID}/list?branch=main&folder=/"

# Read a specific file
curl "http://127.0.0.1:3200/api/repo/read/${ENCODED_REPO_ID}/file?path=/some-folder/some-file.json&branch=main"

# Check dirty branch status
curl "http://127.0.0.1:3200/api/repo/diff/${ENCODED_REPO_ID}/status"

# Get commit graph
curl "http://127.0.0.1:3200/api/repo/debug/${ENCODED_REPO_ID}/graph"
```

### 8. Recover the repo to production

#### Option A: Full repo replacement via git clone/push

Delete the corrupted repo on production, then transfer via git:

```bash
# Delete the corrupted repo on production (skip if already deleted)
curl -X DELETE "http://127.0.0.1:3100/api/repo/manage/${ENCODED_REPO_ID}"

# Initialize a fresh repo on production
curl -X POST "http://127.0.0.1:3100/api/repo/manage/${ENCODED_REPO_ID}/init"
```

Open additional tunnels for the git HTTP backend (port 3101):

```bash
# Terminal 3: snapshot test VM git backend on local port 3201
gcloud compute ssh scratch-git-snapshot-test \
  --project=spv1eu-production \
  --zone=europe-west1-b \
  --tunnel-through-iap \
  -- -N -L 3201:127.0.0.1:3101

# Terminal 4: production git backend on local port 3101
gcloud compute ssh scratch-git \
  --project=spv1eu-production \
  --zone=europe-west1-b \
  --tunnel-through-iap \
  -- -N -L 3101:127.0.0.1:3101
```

Clone from the snapshot and push to production. The git HTTP backend uses the encoded repo ID with `.git` appended:

```bash
cd /tmp
git clone "http://127.0.0.1:3201/${ENCODED_REPO_ID}.git" scratch-git-recovery

cd scratch-git-recovery

# Push all branches to production
git remote add production "http://127.0.0.1:3101/${ENCODED_REPO_ID}.git"
git push production --all
```

#### Option B: Recover specific files via the API

If only certain files need to be restored, read them from the snapshot and write them to production:

```bash
# Read file from snapshot
curl -s "http://127.0.0.1:3200/api/repo/read/${ENCODED_REPO_ID}/file?path=/folder/file.json&branch=main" \
  | jq -r '.data.content' > /tmp/recovered-file.json

# Write file to production
curl -X POST "http://127.0.0.1:3100/api/repo/write/${ENCODED_REPO_ID}/files" \
  -H "Content-Type: application/json" \
  -d "{
    \"files\": [{
      \"path\": \"/folder/file.json\",
      \"content\": $(cat /tmp/recovered-file.json | jq -Rs .)
    }],
    \"message\": \"Recover file from snapshot\"
  }"
```

For bulk recovery you can script this with the paginated files endpoint:

```bash
# List all files in a folder from the snapshot
curl -s "http://127.0.0.1:3200/api/repo/read/${ENCODED_REPO_ID}/files-paginated?branch=main&folder=/&limit=200" \
  | jq '.data.files[] | .path'
```

### 9. Verify the recovery

```bash
# Check the repo exists on production
curl "http://127.0.0.1:3100/api/repo/manage/${ENCODED_REPO_ID}/exists"

# List files to confirm content is restored
curl "http://127.0.0.1:3100/api/repo/read/${ENCODED_REPO_ID}/list?branch=main&folder=/"

# Verify object count looks reasonable
curl "http://127.0.0.1:3100/api/repo/manage/${ENCODED_REPO_ID}/count-objects"
```

### 10. Tear down the temporary VM

Remove the snapshot test resources from `terraform/envs/eu-production/eu-production.tf` (delete the entire block added in step 3), then:

```bash
cd terraform/envs/eu-production

terraform plan \
  -target=google_compute_instance.snapshot_test \
  -target=google_compute_disk.snapshot_test_data

# Confirm the plan shows 2 resources to destroy, then apply
terraform apply \
  -target=google_compute_instance.snapshot_test \
  -target=google_compute_disk.snapshot_test_data
```

## Notes

- The snapshot test VM reuses the `scratch-git` network tag, so existing firewall rules allow VPC traffic on ports 3100 and 3101 automatically.
- The startup script does **not** format the disk (`mkfs.ext4`) — the snapshot already contains a valid filesystem.
- The VM takes 2-5 minutes after creation before the scratch-git container is running.
- Snapshots are retained for 14 days. For older data, you would need to restore from another backup source.
