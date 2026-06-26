#!/bin/bash
set -euo pipefail

STATE_FILE="/mnt/disks/data/.active-slot"
DEPLOY_DIR="/mnt/disks/data/.deploy"
IMAGE="$1"

# Source environment variables written by startup.sh
# shellcheck source=/dev/null
source "$DEPLOY_DIR/env.sh"

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

# ---------- clean up old images to free boot disk space ----------
docker system prune -af

# ---------- pull new image ----------
docker pull "$IMAGE"

# ---------- fetch runtime secrets from Secret Manager ----------
SLACK_NOTIFICATION_WEBHOOK_URL=$(gcloud secrets versions access latest \
  --secret=SLACK_NOTIFICATION_WEBHOOK_URL \
  --project="$GCP_PROJECT_ID")

# SCRATCH_GIT_AUTH_TOKEN (DEV-10600) — shared bearer token presented by the NestJS server.
# Tolerate a not-yet-created/empty secret so a deploy can't hard-fail on rollout ordering;
# an empty value leaves the service unauthenticated (legacy behavior).
SCRATCH_GIT_AUTH_TOKEN=$(gcloud secrets versions access latest \
  --secret=SCRATCH_GIT_AUTH_TOKEN \
  --project="$GCP_PROJECT_ID" 2>/dev/null || echo "")

# ---------- start new version on the target slot ----------
docker rm -f "scratch-git-$TARGET" 2>/dev/null || true

docker run -d \
  --name "scratch-git-$TARGET" \
  --restart unless-stopped \
  --network host \
  --log-driver=gcplogs \
  --log-opt labels=service,env,slot \
  --label service=scratch-git \
  --label env="$GCP_PROJECT_ID" \
  --label slot="$TARGET" \
  -e PORT=$TARGET_API \
  -e GIT_BACKEND_PORT=$TARGET_GIT \
  -e SLACK_NOTIFICATION_WEBHOOK_URL="$SLACK_NOTIFICATION_WEBHOOK_URL" \
  -e SCRATCH_GIT_AUTH_TOKEN="$SCRATCH_GIT_AUTH_TOKEN" \
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

# ---------- stop container in old slot (60s graceful shutdown) ----------
echo "Stopping old slot: $ACTIVE (60s graceful shutdown)"
if ! docker stop --timeout 60 "scratch-git-$ACTIVE" 2>/dev/null; then
  echo "WARNING: scratch-git-$ACTIVE did not stop gracefully — container may have been force-killed after 60s timeout"
fi
docker rm -f "scratch-git-$ACTIVE" 2>/dev/null || true

echo "Deploy complete. Active slot: $TARGET"
