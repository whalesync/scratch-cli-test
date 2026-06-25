# shellcheck shell=bash disable=SC1091
# Main startup logic for scratch-git GCE instances.
# This file is inlined into the metadata_startup_script by Terraform.
# The following variables are set by the Terraform wrapper before this runs:
#   DEVICE, MOUNT_POINT, DEPLOY_DIR, STATE_FILE, IMAGE, REGISTRY_HOST,
#   INITIALIZE_FILESYSTEM, GCP_PROJECT_ID, DEPLOY_SCRIPT

# Wait for the persistent disk device to appear (up to 60s)
for i in $(seq 1 30); do
  [ -e "$DEVICE" ] && break
  echo "Waiting for $DEVICE ... ($i)"
  sleep 2
done

# Format the disk if it has no filesystem (only when explicitly enabled)
if [ "$INITIALIZE_FILESYSTEM" = "true" ]; then
  if ! blkid "$DEVICE"; then
    mkfs.ext4 -F "$DEVICE"
  fi
fi

# Mount the persistent data disk (skip if already mounted)
mkdir -p "$MOUNT_POINT"
mountpoint -q "$MOUNT_POINT" || mount "$DEVICE" "$MOUNT_POINT"

# Install Docker if not already present
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

# Install the Ops Agent for memory/disk monitoring metrics
if ! systemctl is-active --quiet google-cloud-ops-agent; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi

# Authenticate Docker with Artifact Registry
gcloud auth configure-docker "$REGISTRY_HOST" --quiet

# ---------- fetch runtime secrets from Secret Manager ----------
SLACK_NOTIFICATION_WEBHOOK_URL=$(gcloud secrets versions access latest \
  --secret=SLACK_NOTIFICATION_WEBHOOK_URL \
  --project="$GCP_PROJECT_ID")

# ---------- write env file for deploy.sh ----------
mkdir -p "$DEPLOY_DIR"
cat > "$DEPLOY_DIR/env.sh" << EOF
GCP_PROJECT_ID="$GCP_PROJECT_ID"
EOF

# ---------- nginx config ----------

cat > "$DEPLOY_DIR/nginx.conf" << 'NGINX_CONF'
worker_processes 1;
events { worker_connections 1024; }
http {
    client_max_body_size 50m;
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

# ---------- write deploy script ----------
printf '%s\n' "$DEPLOY_SCRIPT" > "$DEPLOY_DIR/deploy.sh"
chmod +x "$DEPLOY_DIR/deploy.sh"

# ---------- clean up and start containers ----------
docker system prune -af
journalctl --vacuum-size=100M 2>/dev/null || true
docker pull "$IMAGE"

# Stop existing app containers (not proxy)
docker rm -f scratch-git-blue 2>/dev/null || true
docker rm -f scratch-git-green 2>/dev/null || true
# Also remove the old single-container setup if it exists
docker rm -f scratch-git 2>/dev/null || true

# Start both blue and green
docker run -d \
  --name scratch-git-blue \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service,env,slot \
  --label service=scratch-git --label env="$GCP_PROJECT_ID" --label slot=blue \
  -e PORT=3200 -e GIT_BACKEND_PORT=3201 \
  -e SLACK_NOTIFICATION_WEBHOOK_URL="$SLACK_NOTIFICATION_WEBHOOK_URL" \
  -v /mnt/disks/data:/data \
  "$IMAGE"

docker run -d \
  --name scratch-git-green \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service,env,slot \
  --label service=scratch-git --label env="$GCP_PROJECT_ID" --label slot=green \
  -e PORT=3300 -e GIT_BACKEND_PORT=3301 \
  -e SLACK_NOTIFICATION_WEBHOOK_URL="$SLACK_NOTIFICATION_WEBHOOK_URL" \
  -v /mnt/disks/data:/data \
  "$IMAGE"

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

# ---------- restricted read-only ops tooling (DEV-10366) ----------
# Installs four root-owned wrapper scripts and a tightly-scoped sudoers drop-in so a
# NON-admin OS Login user (the per-dev "gcp-ro" read-only SAs in role_readonly_sa@,
# granted only instance-scoped roles/compute.osLogin) can inspect the VM — docker
# state/logs, disk usage, and read-only git on a repo — without any ability to mutate.
# The sudoers rule grants to ALL precisely because the OS Login username of a service
# account is not known ahead of time; the real gate is IAM (who gets osLogin + IAP at
# all). Raw docker/sudo stays break-glass (role_operations@). This block is idempotent
# and self-contained: safe to re-run. On an EXISTING VM the metadata copy of this script
# is frozen by the instance's lifecycle.ignore_changes, so activate by running THIS block
# directly as root (pipe it over SSH to `sudo bash`, or paste it); a freshly-built VM
# bakes it in at boot.
#
# Wrappers live in /usr/local/sbin, which is already on sudo's secure_path, so a bare
# `sudo gitops-ps` resolves to the allowed path and matches the NOPASSWD rule. (A dedicated
# dir like /opt/gitops/bin is NOT on secure_path — bare names there fall through to a
# password prompt — so we install to /usr/local/sbin and clean up that earlier location.)
rm -f /opt/gitops/bin/gitops-* 2>/dev/null || true
rmdir /opt/gitops/bin 2>/dev/null || true

# gitops-ps — docker state (no user args)
cat > /usr/local/sbin/gitops-ps <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
echo "=== docker ps -a ==="; /usr/bin/docker ps -a
echo; echo "=== docker stats (snapshot) ==="; /usr/bin/docker stats --no-stream
WRAP

# gitops-logs <scratch-git-blue|green|proxy> [lines]
cat > /usr/local/sbin/gitops-logs <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
container="${1:-}"; lines="${2:-200}"
case "$container" in
  scratch-git-blue|scratch-git-green|scratch-git-proxy) ;;
  *) echo "error: container must be scratch-git-{blue,green,proxy}" >&2; exit 2 ;;
esac
[[ "$lines" =~ ^[0-9]{1,5}$ ]] || { echo "error: lines must be numeric" >&2; exit 2; }
exec /usr/bin/docker logs --tail "$lines" -- "$container"
WRAP

# gitops-disk — read-only disk report (fixed paths)
cat > /usr/local/sbin/gitops-disk <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
echo "=== df -h ==="; df -h
echo; echo "=== docker system df ==="; /usr/bin/docker system df
echo; echo "=== du /mnt/disks/data (top 40) ==="
du -xh --max-depth=2 /mnt/disks/data 2>/dev/null | sort -h | tail -40
WRAP

# gitops-git <org_../wkb_../coa_..> <read-only-subcommand> [args...]
cat > /usr/local/sbin/gitops-git <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
export GIT_PAGER=cat PAGER=cat
REPO_ROOT=/mnt/disks/data/repos
repo_id="${1:-}"; sub="${2:-}"; shift 2 2>/dev/null || { echo "usage: gitops-git <repo_id> <subcommand> [args]" >&2; exit 2; }
[[ "$repo_id" =~ ^org_[A-Za-z0-9]+/wkb_[A-Za-z0-9]+/coa_[A-Za-z0-9]+$ ]] \
  || { echo "error: repo id must be org_.../wkb_.../coa_..." >&2; exit 2; }
real="$(readlink -f -- "$REPO_ROOT/$repo_id.git" 2>/dev/null || true)"
case "$real" in "$REPO_ROOT"/*.git) ;; *) echo "error: path escapes $REPO_ROOT" >&2; exit 2 ;; esac
[ -d "$real" ] || { echo "error: repo not found: $repo_id" >&2; exit 2; }
case "$sub" in
  log|show|diff|status|ls-files|ls-tree|cat-file|rev-parse|rev-list|for-each-ref|show-ref|count-objects|fsck|shortlog|describe) ;;
  *) echo "error: subcommand '$sub' not allowed (read-only only)" >&2; exit 2 ;;
esac
for a in "$@"; do case "$a" in
  -o|--output|--output=*|--output-directory=*|--ext-diff|--upload-pack=*|--exec=*|--exec-path=*)
    echo "error: flag '$a' not allowed" >&2; exit 2 ;;
esac; done
exec /usr/bin/git --no-pager -C "$real" "$sub" "$@"
WRAP

chmod 0755 /usr/local/sbin/gitops-ps /usr/local/sbin/gitops-logs /usr/local/sbin/gitops-disk /usr/local/sbin/gitops-git

# sudoers: only the four wrappers, NOPASSWD. Granting to ALL is safe — the
# command surface is four read-only wrappers; the real gate is IAM (who gets
# osLogin + IAP at all). Admins keep their separate google-sudoers root grant.
cat > /tmp/gitops.sudoers <<'SUDO'
Cmnd_Alias GITOPS_RO = /usr/local/sbin/gitops-ps, /usr/local/sbin/gitops-logs, \
                       /usr/local/sbin/gitops-disk, /usr/local/sbin/gitops-git
Defaults!GITOPS_RO env_reset, !requiretty, secure_path="/usr/sbin:/usr/bin:/sbin:/bin"
ALL ALL=(root) NOPASSWD: GITOPS_RO
SUDO
visudo -cf /tmp/gitops.sudoers && install -o root -g root -m 0440 /tmp/gitops.sudoers /etc/sudoers.d/gitops
rm -f /tmp/gitops.sudoers
# ---------- end restricted read-only ops tooling ----------
