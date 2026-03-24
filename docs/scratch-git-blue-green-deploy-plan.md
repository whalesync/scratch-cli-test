# Scratch Git: Blue-Green Zero-Downtime Deploy Plan

## Problem

The current scratch-git deploy process has a window of downtime. The CI job SSHs into the GCE instance and re-runs the startup script, which stops the running container, pulls the new image, and starts a fresh container. During that window (typically 10-30s), scratch-git is unreachable and any in-flight requests from Cloud Run services fail.

## Approach

Add an nginx reverse proxy sidecar on the same VM. Nginx owns the canonical ports (3100, 3101) and proxies to whichever scratch-git container (blue or green) is currently active. Deploys update the inactive container, health-check it, then swap nginx's upstream — zero dropped connections.

This is adapted from [technicallyshane.com's blue-green Docker Compose approach](https://technicallyshane.com/2025/08/30/blue-green-deployment-of-a-docker-compose-setup.html), simplified for our single-binary, single-VM setup (no Docker Compose needed).

## Architecture

```
LB VIP :3100/:3101
        │
        v
┌───────────────────────────────────────────────┐
│  GCE Instance                                 │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  nginx container (scratch-git-proxy)    │  │
│  │  -p 3100:3100  -p 3101:3101            │  │
│  │                                         │  │
│  │  upstream api  → 127.0.0.1:XXXX        │  │
│  │  upstream git  → 127.0.0.1:YYYY        │  │
│  └──────────┬──────────────┬───────────────┘  │
│             │              │                  │
│      ┌──────┴──────┐ ┌────┴────────┐         │
│      │ scratch-git │ │ scratch-git │         │
│      │    BLUE     │ │   GREEN     │         │
│      │ :3200/:3201 │ │ :3300/:3301 │         │
│      │             │ │             │         │
│      └──────┬──────┘ └─────┬───────┘         │
│             │              │                  │
│             └──────┬───────┘                  │
│                    v                          │
│              /mnt/disks/data                  │
│              (persistent disk, shared)        │
└───────────────────────────────────────────────┘
```

**Port assignments:**

| Container            | API Port | Git Backend Port |
|----------------------|----------|------------------|
| nginx (external)     | 3100     | 3101             |
| scratch-git-blue     | 3200     | 3201             |
| scratch-git-green    | 3300     | 3301             |

## State File

A file at `/mnt/disks/data/.active-slot` stores which container is currently receiving traffic. It contains either `blue` or `green`.

- Written after every successful traffic swap.
- Read at startup and deploy time to determine which slot is active and which is idle.
- Lives on the persistent disk so it survives VM reboots and container restarts.
- Defaults to `blue` if the file doesn't exist (first boot).

## Nginx Configuration

### Main config: `/mnt/disks/data/.deploy/nginx.conf`

```nginx
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    # Included file sets $active_api_port and $active_git_port
    include /etc/nginx/upstream.conf;

    server {
        listen 3100;

        location / {
            proxy_pass http://127.0.0.1:$active_api_port;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_connect_timeout 5s;
            proxy_read_timeout 300s;  # git operations can be slow
        }
    }

    server {
        listen 3101;

        location / {
            proxy_pass http://127.0.0.1:$active_git_port;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_connect_timeout 5s;
            proxy_read_timeout 300s;
        }
    }
}
```

### Upstream config: `/mnt/disks/data/.deploy/upstream.conf`

This is the file that gets swapped on deploy. For blue active:

```nginx
# Active slot: blue
map "" $active_api_port { default 3200; }
map "" $active_git_port { default 3201; }
```

For green active:

```nginx
# Active slot: green
map "" $active_api_port { default 3300; }
map "" $active_git_port { default 3301; }
```

Traffic switching = overwrite this file + `docker exec scratch-git-proxy nginx -s reload`.

## Implementation

### 1. Terraform Startup Script Changes

Replace the current startup script in `terraform/modules/scratch_git_gce/main.tf`. The new script handles first boot (starting all three containers) and subsequent boots (restoring state from the state file).

```bash
#!/bin/bash
set -e

DEVICE="/dev/disk/by-id/google-data-disk"
MOUNT_POINT="/mnt/disks/data"
DEPLOY_DIR="$MOUNT_POINT/.deploy"
STATE_FILE="$MOUNT_POINT/.active-slot"
IMAGE="${var.docker_image}"
REGISTRY_HOST="${split("/", var.docker_image)[0]}"

# ---------- disk setup (unchanged) ----------
for i in $(seq 1 30); do
  [ -e "$DEVICE" ] && break
  echo "Waiting for $DEVICE ... ($i)"
  sleep 2
done

if [ "${var.initialize_filesystem}" = "true" ]; then
  if ! blkid "$DEVICE"; then
    mkfs.ext4 -F "$DEVICE"
  fi
fi

mkdir -p "$MOUNT_POINT"
mountpoint -q "$MOUNT_POINT" || mount "$DEVICE" "$MOUNT_POINT"

# ---------- install docker (unchanged) ----------
if ! command -v docker &>/dev/null; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io
  systemctl enable --now docker
fi

# ---------- install ops agent (unchanged) ----------
if ! systemctl is-active --quiet google-cloud-ops-agent; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi

# ---------- docker auth ----------
gcloud auth configure-docker $REGISTRY_HOST --quiet

# ---------- nginx config ----------
mkdir -p "$DEPLOY_DIR"

cat > "$DEPLOY_DIR/nginx.conf" << 'NGINX_CONF'
worker_processes 1;
events { worker_connections 1024; }
http {
    include /etc/nginx/upstream.conf;

    server {
        listen 3100;
        location / {
            proxy_pass http://127.0.0.1:$active_api_port;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_connect_timeout 5s;
            proxy_read_timeout 300s;
        }
    }

    server {
        listen 3101;
        location / {
            proxy_pass http://127.0.0.1:$active_git_port;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_connect_timeout 5s;
            proxy_read_timeout 300s;
        }
    }
}
NGINX_CONF

# ---------- read or initialize active slot ----------
ACTIVE=$(cat "$STATE_FILE" 2>/dev/null || echo "blue")

if [ "$ACTIVE" = "blue" ]; then
  ACTIVE_API=3200; ACTIVE_GIT=3201
else
  ACTIVE_API=3300; ACTIVE_GIT=3301
fi

# Write upstream config pointing to the active slot
cat > "$DEPLOY_DIR/upstream.conf" << EOF
map "" \$active_api_port { default $ACTIVE_API; }
map "" \$active_git_port { default $ACTIVE_GIT; }
EOF

# ---------- clean up and start containers ----------
docker system prune -af
journalctl --vacuum-size=100M 2>/dev/null || true
docker pull $IMAGE

# Stop existing app containers (not proxy)
docker rm -f scratch-git-blue 2>/dev/null || true
docker rm -f scratch-git-green 2>/dev/null || true

# Start both blue and green
docker run -d \
  --name scratch-git-blue \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service,env,slot \
  --label service=scratch-git --label env=${var.gcp_project_id} --label slot=blue \
  -e PORT=3200 -e GIT_BACKEND_PORT=3201 \
  -v /mnt/disks/data:/data \
  $IMAGE

docker run -d \
  --name scratch-git-green \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service,env,slot \
  --label service=scratch-git --label env=${var.gcp_project_id} --label slot=green \
  -e PORT=3300 -e GIT_BACKEND_PORT=3301 \
  -v /mnt/disks/data:/data \
  $IMAGE

# Write state file
echo "$ACTIVE" > "$STATE_FILE"

# Start or restart nginx proxy
docker rm -f scratch-git-proxy 2>/dev/null || true

docker run -d \
  --name scratch-git-proxy \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service \
  --label service=scratch-git-proxy \
  -v "$DEPLOY_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$DEPLOY_DIR/upstream.conf:/etc/nginx/upstream.conf:ro" \
  nginx:alpine
```

**Key differences from the current script:**
- `mkfs.ext4` is guarded behind a `var.initialize_filesystem` Terraform variable (default `false`) — only set to `true` when provisioning a brand-new instance to avoid accidentally formatting an existing disk
- Uses `--network host` instead of `-p` port mapping (all containers share the host network namespace, so nginx can reach blue/green on localhost)
- Runs two scratch-git containers with different `PORT` and `GIT_BACKEND_PORT` env vars
- Adds an nginx container that owns ports 3100/3101
- Reads/writes the state file on the persistent disk

### 2. Deploy Script (new file on the VM)

Create `/mnt/disks/data/.deploy/deploy.sh` — this is what the CI job will invoke instead of re-running the startup script.

```bash
#!/bin/bash
set -euo pipefail

STATE_FILE="/mnt/disks/data/.active-slot"
DEPLOY_DIR="/mnt/disks/data/.deploy"
IMAGE="$1"  # passed by CI job

if [ -z "$IMAGE" ]; then
  echo "Usage: deploy.sh <image-uri>"
  exit 1
fi

# ---------- determine slots ----------
ACTIVE=$(cat "$STATE_FILE" 2>/dev/null || echo "blue")

if [ "$ACTIVE" = "blue" ]; then
  TARGET="green"
  TARGET_API=3300
  TARGET_GIT=3301
else
  TARGET="blue"
  TARGET_API=3200
  TARGET_GIT=3201
fi

echo "Active: $ACTIVE, deploying to: $TARGET"

# ---------- pull new image ----------
docker pull "$IMAGE"

# ---------- start new version on the target slot ----------
docker rm -f "scratch-git-$TARGET" 2>/dev/null || true

docker run -d \
  --name "scratch-git-$TARGET" \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service,env,slot \
  --label service=scratch-git \
  --label slot="$TARGET" \
  -e PORT=$TARGET_API \
  -e GIT_BACKEND_PORT=$TARGET_GIT \
  -v /mnt/disks/data:/data \
  "$IMAGE"

# ---------- health check the target ----------
echo "Waiting for scratch-git-$TARGET to become healthy..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$TARGET_API/health" > /dev/null 2>&1; then
    echo "scratch-git-$TARGET is healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: scratch-git-$TARGET did not become healthy in 60s"
    docker logs "scratch-git-$TARGET" --tail 50
    exit 1
  fi
  sleep 2
done

# ---------- swap nginx upstream ----------
cat > "$DEPLOY_DIR/upstream.conf" << EOF
map "" \$active_api_port { default $TARGET_API; }
map "" \$active_git_port { default $TARGET_GIT; }
EOF

docker exec scratch-git-proxy nginx -s reload
echo "Nginx reloaded — traffic now routed to $TARGET"

# ---------- update state file ----------
echo "$TARGET" > "$STATE_FILE"

# ---------- stop old slot ----------
echo "Stopping old slot: $ACTIVE (60s graceful shutdown)"
docker stop --time 60 "scratch-git-$ACTIVE" 2>/dev/null || true
docker rm "scratch-git-$ACTIVE" 2>/dev/null || true

echo "Deploy complete. Active slot: $TARGET"
```

**Why stop the old container after swap?** Both containers mount `/data` read/write. While git's lock-file mechanism prevents corruption from concurrent writes, running two instances simultaneously increases disk I/O and memory usage unnecessarily. Stopping the old slot after the swap keeps things clean. The old container can be left running for a brief overlap period if you want extra safety for in-flight requests.

### 3. GitLab CI Deploy Job Changes

Update `gitlab-ci/stages/05-deploy.yml` to call the deploy script instead of re-running the startup script.

**Current (test):**
```yaml
deploy scratch-git to test environment:
  stage: deploy
  extends:
    - .gcp_eu_test_env
  script:
    - gcloud compute ssh scratch-git
      --project spv1eu-test
      --zone europe-west1-b
      --tunnel-through-iap
      -- 'sudo google_metadata_script_runner startup'
    - # ... health check ...
```

**New (test):**
```yaml
deploy scratch-git to test environment:
  stage: deploy
  extends:
    - .gcp_eu_test_env
  script:
    - IMAGE_URL=${GCP_REGISTRY_URL}/spinner-scratch-git:${CI_COMMIT_SHORT_SHA}
    - |
      gcloud compute ssh scratch-git \
        --project spv1eu-test \
        --zone europe-west1-b \
        --tunnel-through-iap \
        -- "sudo bash /mnt/disks/data/.deploy/deploy.sh $IMAGE_URL"
    # Verify the deployed version is running
    - |
      HEALTH=$(gcloud compute ssh scratch-git \
        --project spv1eu-test \
        --zone europe-west1-b \
        --tunnel-through-iap \
        -- "curl -sf http://localhost:3100/health")
      echo "$HEALTH"
      if [ -z "$HEALTH" ]; then echo "ERROR: scratch-git health check failed"; exit 1; fi
      echo "$HEALTH" | grep -q "$CI_COMMIT_SHORT_SHA" \
        || (echo "ERROR: Expected build containing $CI_COMMIT_SHORT_SHA but got: $HEALTH" && exit 1)
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - gitlab-ci/stages/05-deploy.yml
      when: manual
      allow_failure: true
    - !reference [.rules, on_merge_to_master]
```

Same pattern for the production job, substituting `spv1eu-production` and the prod rules.

### 4. Terraform Health Check — No Changes Needed

The existing TCP health check on port 3100 continues to work because nginx now owns port 3100. The health check verifies nginx is up and proxying — if the backend scratch-git container is down, nginx returns a 502 and the health check fails appropriately.

### 5. Firewall Rules — No Changes Needed

Ports 3100 and 3101 remain the only externally-visible ports. Blue (3200/3201) and green (3300/3301) are only reachable on localhost via `--network host`.

## Rollback

If the new version is broken after deploy, rollback is:

```bash
# SSH into the instance
# Read current state, swap back
ACTIVE=$(cat /mnt/disks/data/.active-slot)
if [ "$ACTIVE" = "blue" ]; then TARGET="green"; else TARGET="blue"; fi

# Assuming the old container was stopped but not removed, restart it:
docker start "scratch-git-$TARGET"
# Wait for health, then swap nginx (same as deploy script)
```

For a CI-driven rollback, re-deploy the previous image tag — the deploy script handles it like any other deploy.

## Migration Path

The first deploy after this change must run the **new startup script** (via `terraform apply` to update the instance metadata, then reboot or re-run `google_metadata_script_runner startup`). This will:

1. Start both blue and green containers (both running the current image)
2. Start the nginx proxy
3. Write the initial state file

After that initial setup, all subsequent deploys use the deploy script and are zero-downtime.

**Sequence:**
1. Merge the Terraform changes
2. `terraform apply` in test — updates the startup script metadata
3. SSH into the test instance and run `sudo google_metadata_script_runner startup` (this is a one-time restart with downtime to bootstrap the new setup)
4. Verify: `curl http://<LB_VIP>:3100/health` returns successfully through nginx
5. Run a CI deploy to verify the blue-green swap works end-to-end
6. Repeat for production

## Open Questions

- **Boot disk size**: Running three containers (nginx + blue + green) instead of one uses more disk for images. The current 30 GB boot disk should be fine since `docker system prune -af` runs on startup, but worth monitoring.
- **Memory**: Two scratch-git containers running simultaneously during deploys. The e2-medium (4 GB RAM) should handle this since scratch-git is lightweight, but monitor after rollout.
- **Graceful drain**: ~~The current plan stops the old container immediately after nginx reload.~~ Resolved: the deploy script now uses `docker stop --time 60` to give in-flight git operations up to 60s to complete before SIGKILL.
