#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/finalize_release.sh
#
# Runs after all platform upload jobs succeed:
#   1. Computes an aggregated checksums.txt across all uploaded assets and
#      uploads it to the release (still draft at this point).
#   2. Flips the release's `draft` flag to false (makes it visible).
#   3. Writes annotations.json so GitLab's job UI links to the release.
#
# Required env (normally from bootstrap dotenv):
#   RELEASE_ID, NEW_VERSION, RELEASE_UPLOAD_URL
# Required secret:
#   GITHUB_TOKEN

if [ -z "$RELEASE_ID" ] || [ -z "$NEW_VERSION" ] || [ -z "$RELEASE_UPLOAD_URL" ]; then
  echo "ERROR: RELEASE_ID, NEW_VERSION and RELEASE_UPLOAD_URL must be set (see bootstrap release.env)."
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
UPLOAD_URL_BASE="${RELEASE_UPLOAD_URL%%\{*}"

echo "Fetching assets on draft release $NEW_VERSION..."
ASSETS_JSON=$(curl -sS --fail-with-body -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?per_page=100")

# Build checksums.txt by downloading each non-checksums asset and computing sha256.
# Assets on a draft release require auth + Accept: application/octet-stream.
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

CHECKSUMS_FILE="$WORK_DIR/checksums.txt"
: > "$CHECKSUMS_FILE"

echo "$ASSETS_JSON" | jq -c '.[] | {id, name}' | while IFS= read -r asset; do
  ASSET_NAME=$(echo "$asset" | jq -r '.name')
  ASSET_ID=$(echo "$asset" | jq -r '.id')

  if [ "$ASSET_NAME" = "checksums.txt" ]; then
    echo "  Deleting pre-existing checksums.txt (id=$ASSET_ID)..."
    curl -sS --fail-with-body -X DELETE -H "Authorization: token $GITHUB_TOKEN" \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${ASSET_ID}"
    continue
  fi

  echo "  Hashing $ASSET_NAME..."
  curl -sSL --fail-with-body -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/octet-stream" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${ASSET_ID}" \
    -o "$WORK_DIR/$ASSET_NAME"
  shasum -a 256 "$WORK_DIR/$ASSET_NAME" | awk -v n="$ASSET_NAME" '{print $1 "  " n}' >> "$CHECKSUMS_FILE"
done

echo "Aggregated checksums:"
cat "$CHECKSUMS_FILE"

echo "Uploading checksums.txt to release..."
curl -sS --fail-with-body -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: text/plain" \
  "${UPLOAD_URL_BASE}?name=checksums.txt" \
  --data-binary "@$CHECKSUMS_FILE"

# Flip draft:false. This is the only moment the release becomes visible.
echo "Publishing release (draft -> false)..."
PUBLISH_HTTP=$(curl -sS -o /tmp/publish_body -w "%{http_code}" -X PATCH \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}" \
  -d '{"draft": false}')
if [ "$PUBLISH_HTTP" -lt 200 ] || [ "$PUBLISH_HTTP" -ge 300 ]; then
  echo "ERROR: Failed to publish release (HTTP $PUBLISH_HTTP). Response body:"
  cat /tmp/publish_body
  echo
  exit 1
fi

RELEASE_URL="https://github.com/${GITHUB_REPO}/releases/tag/${NEW_VERSION}"
echo ""
echo "✓ Release $NEW_VERSION published"
echo "  $RELEASE_URL"

cat > annotations.json <<JSON
{
  "Release URLs": [
    {
      "external_link": {
        "label": "GitHub Release: $NEW_VERSION",
        "url": "$RELEASE_URL"
      }
    }
  ]
}
JSON
echo "Wrote annotations.json"
