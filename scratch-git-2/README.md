# Scratch Git 2 Microservice

A high-performance Rust rewrite of the Scratch Git microservice. It provides the same persistent Git storage layer for Scratch, decoupling file storage from the main API so the application remains stateless while this service manages repository data on a persistent filesystem.

## Architecture

The service consists of two HTTP servers running within a single Rust binary:

### 1. REST API Server (Port 3100)

- **Purpose**: Handles programmatic file operations from the main Scratch application.
- **Features**:
  - **Repository Management**: Initialize, delete, reset, and garbage-collect bare repositories.
  - **File Read**: List directories, read files, compute diffs, and export ZIP archives — all directly from bare repos.
  - **Atomic Writes**: Commit, delete, rename, and publish files atomically with write-lock protection per repo+branch.
  - **Branching**: Dual-branch workflow (`main` for published state, `dirty` for working changes) with rebase and merge support.
  - **Checkpoints**: Create, list, and revert named snapshots of repository state.
- **Technology**: Rust, Axum, `gix` (pure-Rust Git library).

### 2. Git HTTP Backend Server (Port 3101)

- **Purpose**: Serves standard Git traffic (Clone, Pull, Push) for users' local git clients.
- **Features**:
  - Proxies requests to the standard `git http-backend` binary.
  - Fully compatible with the standard `git` CLI.

## CLI Binary (`scratchmd`)

This crate also builds the `scratchmd` CLI — the end-user tool for interacting with Scratch from the command line. See [PARITY.md](PARITY.md) for a full feature listing.

### Build locally

```bash
cd scratch-git-2
cargo build --release --bin scratchmd
./target/release/scratchmd --help
```

By default the CLI points at `http://localhost:3010`. To build against the production or test server:

```bash
SCRATCH_DEFAULT_URL=https://api.scratch.md cargo build --release --bin scratchmd
SCRATCH_DEFAULT_URL=https://test-api.scratch.md cargo build --release --bin scratchmd
```

The compiled URL is baked in at build time. You can always override it at runtime with `--scratch-url <url>` or via `scratchmd.config.yaml`.

---

## Setup

### Prerequisites

- Rust 1.70+ (install via [rustup](https://rustup.rs/))
- Git installed and in PATH

### Environment Variables

Configure via environment variables (no `.env` file required):

```env
PORT=3100                 # Port for REST API
GIT_BACKEND_PORT=3101     # Port for Git HTTP Backend
GIT_REPOS_DIR=repos       # Absolute or relative path to repository storage
GIT_REPOS_V2_DIR=repos-v2 # Path to v2 repositories (future)
BUILD_VERSION=0.0.0-local # Build version label
RUST_LOG=info             # Log level (debug, trace, etc.)
```

### Running Locally

**Build and run in development mode:**

```bash
cd scratch-git-2
cargo run
```

**Build an optimized release binary:**

```bash
cd scratch-git-2
cargo build --release
./target/release/scratch-git-2
```

Both the API server (port 3100) and Git HTTP Backend (port 3101) start together.

## Docker

### Build the image

Run from the **repository root**:

```bash
docker build -t spinner-scratch-git -f scratch-git-2/Dockerfile .
```

### Run the container

```bash
docker run -p 3100:3100 -p 3101:3101 spinner-scratch-git
```

Override environment variables and mount a persistent volume for repository storage:

```bash
docker run -p 3100:3100 -p 3101:3101 \
  -e GIT_REPOS_DIR=/data/repos \
  -v /host/path/repos:/data/repos \
  spinner-scratch-git
```

## Git Client Usage

To clone a repository hosted on this service:

```bash
git clone http://localhost:3101/my-project.git
```

## Deployment

Docker images are built automatically by the GitLab CI/CD pipeline and pushed to Artifact Registry as `spinner-scratch-git:latest`.

The scratch-git service runs on a GCE instance (Debian 12) managed by Terraform in `terraform/modules/scratch_git_gce/`. It is deployed to **Test** (`spv1eu-test`) and **Production** (`spv1eu-production`) in the EU region.

### Deploy via gcloud

To update the running container without a full Terraform apply, SSH into the instance and re-run the startup script. This pulls the latest image and restarts the container.

**Test:**

```bash
gcloud compute ssh scratch-git \
  --project spv1eu-test \
  --zone europe-west1-b \
  --tunnel-through-iap \
  -- 'sudo google_metadata_script_runner startup'
```

**Production:**

```bash
gcloud compute ssh scratch-git \
  --project spv1eu-production \
  --zone europe-west1-b \
  --tunnel-through-iap \
  -- 'sudo google_metadata_script_runner startup'
```

Alternatively, SSH in and interact with the instance directly:

```bash
gcloud compute ssh scratch-git \
  --project spv1eu-test \
  --zone europe-west1-b \
  --tunnel-through-iap
```

#### Docker commands

When you SSH in via `gcloud` it will login as your service account which is unable to use `docker` commands directly,
so you need to sudo any docker command.

# View running containers

```bash
sudo docker ps
```

# View logs

```bash
sudo docker logs scratch-git
```

# Follow logs in real-time

```bash
sudo docker logs -f scratch-git
```

# Open a shell inside the container

```bash
sudo docker exec -it scratch-git /bin/sh
```

# Restart the container

```bash
sudo docker restart scratch-git
```

# Check container resource usage

```bash
sudo docker stats scratch-git
```

### Accessing the service locally

Use the tunnel script to forward port 3100 to your machine:

```bash
./terraform/tools/connect_to_git_service.sh test
# or
./terraform/tools/connect_to_git_service.sh production
```

The service will be available at `http://127.0.0.1:3100`.

### Viewing logs

Container logs are sent to GCP Cloud Logging. Filter by label in the Logs Explorer:

```
labels.service="scratch-git"
```

## DevOps Playbook

### Resizing the ScratchGit Persistent Data Disk

The persistent disk can be expanded online without data loss or downtime. GCP only supports **increasing** disk size, never decreasing.

**1. Update the Terraform variable**

Pass `disk_size_gb` to the `scratch_git_gce` module in `terraform/modules/env/main.tf`, or update the default in `terraform/modules/scratch_git_gce/variables.tf`. For example, to increase from 50 GB to 100 GB:

```hcl
module "scratch_git_gce" {
  # ...existing config...
  disk_size_gb = 100
}
```

**2. Plan and apply**

```bash
terraform plan   # Verify it shows "update in-place", NOT "must be replaced"
terraform apply
```

**3. Expand the filesystem on the VM**

GCP resizes the block device automatically, but the ext4 filesystem still sees the old size. SSH into the instance and run:

```bash
# SSH into the instance
gcloud compute ssh scratch-git \
  --project <PROJECT_ID> \
  --zone europe-west1-b \
  --tunnel-through-iap

# Verify the OS sees the new disk size
sudo lsblk

# Resize the ext4 filesystem (online, no unmount needed)
sudo resize2fs /dev/disk/by-id/google-data-disk

# Verify the filesystem reflects the new size
sudo df -h /mnt/disks/data
```

The `resize2fs` command is non-destructive and runs online — no need to stop the container or unmount the disk.
