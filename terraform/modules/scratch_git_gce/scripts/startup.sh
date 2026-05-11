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
