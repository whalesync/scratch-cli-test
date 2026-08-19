#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# No-op sentinel threaded from the hourly schedule's bootstrap: when nothing
# desktop-relevant changed since the last test release, every downstream job
# early-exits. RELEASE_SKIP is only ever set for the test variant.
if [ "${RELEASE_SKIP:-}" = "true" ]; then
  echo "RELEASE_SKIP=true — no changes since last test release. Skipping upload."
  exit 0
fi

# Usage: ./scripts/upload_assets.sh
#
# For each file in dist-release/*.{dmg,zip,AppImage,deb,exe,yml,blockmap},
# upload it to the GitHub release identified by $RELEASE_ID. The .yml and
# .blockmap files are electron-updater's channel manifest + delta-download
# integrity layer — without them auto-update can't find or apply releases.
# If an asset with the same name already exists, delete it first — makes the
# job idempotent so CI retries succeed cleanly. Platform upload jobs (macOS,
# Linux, Windows) run in parallel on the same GitHub release; the asset list is
# fetched once at startup, so another job may delete an asset before we do — a
# DELETE that returns 404 is treated as success (already absent).
#
# If the draft release referenced by $RELEASE_ID is missing (Cleanup may have
# deleted it between a failed run and the retry — DEV-10257), the sourced
# ensure_draft_release helper looks up or recreates a draft with the same tag
# and updates $RELEASE_ID / $RELEASE_UPLOAD_URL in place. Sibling platform
# uploads racing on the recreate are resolved via the same helper (422 →
# refetch).
#
# Required env (normally propagated via bootstrap's release.env dotenv):
#   RELEASE_ID, RELEASE_UPLOAD_URL, NEW_VERSION, IS_PRERELEASE
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

# shellcheck source=scripts/ensure_draft_release.sh
. "$(dirname "$0")/ensure_draft_release.sh"
ensure_draft_release

# Channel's release repo (DEV-11320); test CI jobs pass whalesync/scratch-desktop-test.
GITHUB_REPO="${GITHUB_REPO:-whalesync/scratch-desktop}"
DIST_DIR="./dist-release"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: $DIST_DIR not found. The packaging job must have produced this directory."
  exit 1
fi

# Strip the {?name,label} template suffix from upload_url.
UPLOAD_URL_BASE="${RELEASE_UPLOAD_URL%%\{*}"

ASSETS_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?per_page=100"

fetch_assets() {
  local out_var=$1
  local attempt=1
  local max_attempts=5
  local body
  local http_code
  while [ $attempt -le $max_attempts ]; do
    http_code=$(curl -sS -o /tmp/list_assets_body -w "%{http_code}" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "$ASSETS_URL") || http_code="000"
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      body=$(cat /tmp/list_assets_body)
      printf -v "$out_var" '%s' "$body"
      return 0
    fi
    if [ "$http_code" = "429" ] || [ "$http_code" -ge 500 ] || [ "$http_code" = "000" ]; then
      echo "  List assets attempt $attempt failed with HTTP $http_code; retrying..."
      sleep $((attempt * 3))
      attempt=$((attempt + 1))
      continue
    fi
    echo "ERROR: Failed to list release assets (HTTP $http_code). Response body:"
    cat /tmp/list_assets_body
    return 1
  done
  echo "ERROR: Failed to list release assets after $max_attempts attempts."
  cat /tmp/list_assets_body
  return 1
}

# List current assets once so we can match by name without a GET per file.
# Refreshed on-demand in upload_with_retry when a parallel job re-creates an
# asset after this snapshot.
fetch_assets EXISTING_ASSETS_JSON

delete_asset_by_id() {
  local fname=$1
  local asset_id=$2
  local attempt=1
  local max_attempts=5
  local http_code
  echo "  Deleting pre-existing asset $fname (id=$asset_id)..."
  while [ $attempt -le $max_attempts ]; do
    http_code=$(curl -sS -o /tmp/delete_asset_body -w "%{http_code}" -X DELETE \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset_id}") || http_code="000"

    # 204 = deleted; 404 = already gone (e.g. parallel upload job deleted same name, or stale id from snapshot).
    if [ "$http_code" = "204" ] || [ "$http_code" = "200" ] || [ "$http_code" = "404" ]; then
      return 0
    fi

    if [ "$http_code" = "429" ] || [ "$http_code" -ge 500 ] || [ "$http_code" = "000" ]; then
      echo "  Delete attempt $attempt failed with HTTP $http_code; retrying..."
      sleep $((attempt * 3))
      attempt=$((attempt + 1))
      continue
    fi

    echo "  Delete failed with HTTP $http_code (non-retryable). Response body:"
    cat /tmp/delete_asset_body
    return 1
  done

  echo "  Delete failed after $max_attempts attempts. Last response body:"
  cat /tmp/delete_asset_body
  return 1
}

delete_asset_if_exists() {
  local fname=$1
  local asset_id
  asset_id=$(echo "$EXISTING_ASSETS_JSON" | jq -r --arg n "$fname" '.[] | select(.name == $n) | .id // empty' | head -n 1)
  if [ -z "$asset_id" ]; then
    return 0
  fi
  delete_asset_by_id "$fname" "$asset_id"
}

# Resolve a 422 already_exists race by re-querying live assets, finding any
# asset still holding $fname, and deleting it. Returns 0 if the name is now
# free (either nothing matched or delete succeeded), 1 otherwise.
resolve_name_conflict() {
  local fname=$1
  local fresh_assets
  local asset_id
  if ! fetch_assets fresh_assets; then
    return 1
  fi
  asset_id=$(echo "$fresh_assets" | jq -r --arg n "$fname" '.[] | select(.name == $n) | .id // empty' | head -n 1)
  if [ -z "$asset_id" ]; then
    # Name is free now — another job may have deleted it between our upload
    # attempt and this re-list. Caller should just retry the upload.
    return 0
  fi
  echo "  Found conflicting asset $fname (id=$asset_id) created after our snapshot — deleting before retry."
  delete_asset_by_id "$fname" "$asset_id"
}

upload_with_retry() {
  local file=$1
  local fname=$2
  local attempt=1
  local max_attempts=3
  local conflict_attempts=0
  local max_conflict_attempts=3
  local http_code
  local encoded_fname
  # Test builds use product name "Scratch (Test)", so artifact filenames contain
  # a space and parens that must be percent-encoded for the upload URL.
  encoded_fname=$(jq -rn --arg n "$fname" '$n|@uri')

  while [ $attempt -le $max_attempts ]; do
    http_code=$(curl -sS -o /tmp/upload_body -w "%{http_code}" -X POST \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/octet-stream" \
      "${UPLOAD_URL_BASE}?name=${encoded_fname}" \
      --data-binary "@$file") || http_code="000"

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      return 0
    fi

    # 422 already_exists: a parallel platform job created an asset with this
    # name after our initial snapshot, so our pre-upload delete missed it.
    # Re-query live state, delete the current owner, and retry — without
    # consuming an upload retry slot, since this is a different failure mode
    # from transient API errors.
    if [ "$http_code" = "422" ] \
      && jq -e '.errors[]? | select(.code == "already_exists" and .field == "name")' /tmp/upload_body >/dev/null 2>&1 \
      && [ "$conflict_attempts" -lt "$max_conflict_attempts" ]; then
      conflict_attempts=$((conflict_attempts + 1))
      echo "  Upload of $fname returned 422 already_exists (conflict $conflict_attempts/$max_conflict_attempts); resolving race with a parallel job."
      if ! resolve_name_conflict "$fname"; then
        echo "  Could not resolve already_exists conflict for $fname. Last upload response body:"
        cat /tmp/upload_body
        return 1
      fi
      continue
    fi

    # Retry on 5xx, rate limit (429), and transport failure (000); bail on other 4xx.
    if [ "$http_code" != "429" ]; then
      if [ "$http_code" -lt 500 ] && [ "$http_code" != "000" ]; then
        echo "  Upload failed with HTTP $http_code (non-retryable). Response body:"
        cat /tmp/upload_body
        return 1
      fi
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
