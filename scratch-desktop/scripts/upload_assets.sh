#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/upload_assets.sh
#
# For each file in dist-release/*.{dmg,zip,AppImage,deb,exe,yml,blockmap},
# upload it to the GitHub release identified by $RELEASE_ID. The .yml and
# .blockmap files are electron-updater's channel manifest + delta-download
# integrity layer — without them auto-update can't find or apply releases.
# If an asset with the same name already exists, delete it first — makes the
# job idempotent so retries (the only realistic source of duplicate-name
# contention) succeed cleanly.
#
# Required env (normally propagated via bootstrap's release.env dotenv):
#   RELEASE_ID, RELEASE_UPLOAD_URL, NEW_VERSION
# Required secret:
#   GITHUB_TOKEN

if [ -z "$RELEASE_ID" ] || [ -z "$RELEASE_UPLOAD_URL" ] || [ -z "$NEW_VERSION" ]; then
  echo "ERROR: RELEASE_ID, RELEASE_UPLOAD_URL and NEW_VERSION must be set (see bootstrap release.env)."
  exit 1
fi
if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN is required."
  exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed."
  exit 1
fi

GITHUB_REPO="whalesync/scratch-cli"
DIST_DIR="./dist-release"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: $DIST_DIR not found. The packaging job must have produced this directory."
  exit 1
fi

# Strip the {?name,label} template suffix from upload_url.
UPLOAD_URL_BASE="${RELEASE_UPLOAD_URL%%\{*}"

# List current assets once so we can match by name without a GET per file.
EXISTING_ASSETS_JSON=$(curl -sS --fail-with-body -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?per_page=100")

delete_asset_if_exists() {
  local fname=$1
  local asset_id
  asset_id=$(echo "$EXISTING_ASSETS_JSON" | jq -r --arg n "$fname" '.[] | select(.name == $n) | .id // empty')
  if [ -n "$asset_id" ]; then
    echo "  Deleting pre-existing asset $fname (id=$asset_id)..."
    curl -sS --fail-with-body -X DELETE -H "Authorization: token $GITHUB_TOKEN" \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset_id}"
  fi
}

upload_with_retry() {
  local file=$1
  local fname=$2
  local attempt=1
  local max_attempts=3
  local http_code

  while [ $attempt -le $max_attempts ]; do
    http_code=$(curl -sS -o /tmp/upload_body -w "%{http_code}" -X POST \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/octet-stream" \
      "${UPLOAD_URL_BASE}?name=${fname}" \
      --data-binary "@$file") || http_code="000"

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      return 0
    fi

    # Retry on 5xx and transport failure (000); bail on 4xx.
    if [ "$http_code" -lt 500 ] && [ "$http_code" != "000" ]; then
      echo "  Upload failed with HTTP $http_code (non-retryable). Response body:"
      cat /tmp/upload_body
      return 1
    fi

    echo "  Upload attempt $attempt failed with HTTP $http_code; retrying..."
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done

  echo "  Upload failed after $max_attempts attempts. Last response body:"
  cat /tmp/upload_body
  return 1
}

echo "Uploading artifacts to release $NEW_VERSION (id=$RELEASE_ID)..."
UPLOADED=0
for FILE in "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip "$DIST_DIR"/*.AppImage "$DIST_DIR"/*.deb "$DIST_DIR"/*.exe "$DIST_DIR"/*.yml "$DIST_DIR"/*.blockmap; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  echo "Uploading $FNAME..."
  delete_asset_if_exists "$FNAME"
  upload_with_retry "$FILE" "$FNAME"
  UPLOADED=$((UPLOADED + 1))
done

if [ "$UPLOADED" -eq 0 ]; then
  echo "ERROR: No artifacts found in $DIST_DIR to upload."
  exit 1
fi
echo "Uploaded $UPLOADED asset(s) to $NEW_VERSION"
