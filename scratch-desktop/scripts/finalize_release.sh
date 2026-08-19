#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# No-op sentinel threaded from the hourly schedule's bootstrap: when nothing
# desktop-relevant changed since the last test release, every downstream job
# early-exits. RELEASE_SKIP is only ever set for the test variant.
if [ "${RELEASE_SKIP:-}" = "true" ]; then
  echo "RELEASE_SKIP=true — no changes since last test release. Skipping finalize."
  exit 0
fi

# Usage: ./scripts/finalize_release.sh
#
# Runs after all platform upload jobs succeed:
#   1. Computes an aggregated checksums.txt across all uploaded assets and
#      uploads it to the release (still draft at this point).
#   2. Asserts every expected platform has an installer on the release, and
#      refuses to publish (fails the job, leaving the draft) if one is missing —
#      the backstop against shipping a partial release like the macOS-only
#      v1.0.49. Tune via REQUIRED_PLATFORM_INSTALLER_PATTERNS.
#   3. Flips the release's `draft` flag to false (makes it visible).
#   4. Writes annotations.json so GitLab's job UI links to the release.
#
# If the draft referenced by $RELEASE_ID is missing (Cleanup may have deleted
# it between a failed run and the retry — DEV-10257), the sourced
# ensure_draft_release helper looks up or recreates a draft with the same tag
# and updates $RELEASE_ID / $RELEASE_UPLOAD_URL in place.
#
# Required env (normally from bootstrap dotenv):
#   RELEASE_ID, NEW_VERSION, RELEASE_UPLOAD_URL, IS_PRERELEASE
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

# shellcheck source=scripts/ensure_draft_release.sh
. "$(dirname "$0")/ensure_draft_release.sh"
ensure_draft_release

# Channel's release repo (DEV-11320); test CI jobs pass whalesync/scratch-desktop-test. The public
# RELEASE_URL emitted below derives from it, so the Slack/annotations links point at the right repo.
GITHUB_REPO="${GITHUB_REPO:-whalesync/scratch-desktop}"
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

  # electron-updater's manifest (*.yml) and delta blockmaps (*.blockmap) carry
  # their own sha512 entries; skip them so checksums.txt only covers user-
  # downloadable installers/archives.
  case "$ASSET_NAME" in
    *.yml | *.blockmap)
      echo "  Skipping update metadata: $ASSET_NAME"
      continue
      ;;
  esac

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

# Backstop against publishing an incomplete release. Even with Cleanup hardened
# not to delete drafts that hold installers, a partial retry — only some platform
# package/upload jobs re-running against a recreated draft — could otherwise make
# a release visible that is missing a platform. That is the v1.0.49 incident:
# macOS-only got published while Windows + Linux were absent. Before flipping the
# release visible, assert every expected platform has at least one installer asset
# on it. Override REQUIRED_PLATFORM_INSTALLER_PATTERNS (newline-separated
# "Label=<extended regex over asset names>") to change the build matrix without
# editing this script; set it to empty to skip the check entirely.
DEFAULT_REQUIRED_PLATFORM_INSTALLER_PATTERNS=$'macOS=\\.dmg$\nWindows=\\.exe$\nLinux=\\.(AppImage|deb)$'
REQUIRED_PLATFORM_INSTALLER_PATTERNS="${REQUIRED_PLATFORM_INSTALLER_PATTERNS-$DEFAULT_REQUIRED_PLATFORM_INSTALLER_PATTERNS}"

assert_all_required_platform_installers_present() {
  if [ -z "$REQUIRED_PLATFORM_INSTALLER_PATTERNS" ]; then
    echo "REQUIRED_PLATFORM_INSTALLER_PATTERNS is empty — skipping platform-coverage check."
    return 0
  fi

  # Re-fetch live asset names rather than trust the snapshot taken before the
  # checksums pass, so the gate reflects the release's true final state.
  local asset_names_on_release
  asset_names_on_release=$(curl -sS --fail-with-body -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?per_page=100" \
    | jq -r '.[].name')

  local missing_platform_labels=()
  local platform_pattern_line
  while IFS= read -r platform_pattern_line; do
    [ -n "$platform_pattern_line" ] || continue
    local platform_label="${platform_pattern_line%%=*}"
    local installer_name_pattern="${platform_pattern_line#*=}"
    if ! echo "$asset_names_on_release" | grep -qiE "$installer_name_pattern"; then
      missing_platform_labels+=("$platform_label")
    fi
  done <<< "$REQUIRED_PLATFORM_INSTALLER_PATTERNS"

  if [ "${#missing_platform_labels[@]}" -gt 0 ]; then
    echo "ERROR: Refusing to publish $NEW_VERSION — no installer found for: ${missing_platform_labels[*]}."
    echo "Assets currently on the release:"
    echo "$asset_names_on_release" | sed 's/^/  /'
    echo "A platform's package/upload job likely did not run, or its assets were lost to a"
    echo "draft deletion. Re-run the missing platform's Package + Upload jobs against this"
    echo "draft, then re-run Finalize. The release stays an unpublished draft until then."
    return 1
  fi
  echo "Platform-coverage check passed — installers present for all required platforms."
}

assert_all_required_platform_installers_present

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
