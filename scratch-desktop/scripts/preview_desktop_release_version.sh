#!/bin/bash
set -e
# Prints the latest desktop release tag from GitHub (drafts + published, like
# bootstrap_release.sh) and the next version. Fetches the first 5 API pages
# (500 releases max) so the max tag is less likely to be missed than with a
# single page. No API writes, no package.json or release.env.
#
# Usage: ./scripts/preview_desktop_release_version.sh <prod|test> <patch|minor|major>
#
# Optional: GITHUB_TOKEN — same as bootstrap_release.sh; if unset, calls the
# public API (stricter rate limits; private repos will fail).

VARIANT=${1:-}
RELEASE_TYPE=${2:-}

if [[ "$VARIANT" != "prod" && "$VARIANT" != "test" ]]; then
  echo "Usage: $0 <prod|test> <patch|minor|major>" >&2
  exit 1
fi
if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 <prod|test> <patch|minor|major>" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed." >&2
  exit 1
fi

GITHUB_REPO="whalesync/scratch-cli"

if [ "$VARIANT" = "prod" ]; then
  TAG_SUFFIX="-desktop"
  FALLBACK_TAG="v0.1.0-desktop"
else
  TAG_SUFFIX="-desktop-test"
  FALLBACK_TAG="v0.0.0-desktop-test"
fi

curl_releases_page() {
  local page="${1:?page number required}"
  local -a auth_args=()
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    auth_args=(-H "Authorization: token ${GITHUB_TOKEN}")
  fi
  curl -sS --fail-with-body "${auth_args[@]}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}"
}

# Same as bootstrap_release.sh, but scans GitHub's first 5 pages (bootstrap uses 1).
# Latest tag_name ending in TAG_SUFFIX, version-sorted descending; drafts included.
LATEST_TAG=$(
  {
    for page in 1 2 3 4 5; do
      curl_releases_page "$page"
      printf '\n'
    done
  } | jq -s 'add | .[] | select(.tag_name | endswith($suf)) | .tag_name' --arg suf "$TAG_SUFFIX" -r \
  | sort -V -r \
  | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="$FALLBACK_TAG"
fi

VERSION=$(echo "$LATEST_TAG" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

case "$RELEASE_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

SEMVER="$MAJOR.$MINOR.$PATCH"
NEW_VERSION="v${SEMVER}${TAG_SUFFIX}"

echo "Variant: ${VARIANT} (${RELEASE_TYPE} bump)"
echo "Latest tag (including drafts): ${LATEST_TAG}"
echo "Base semver (from tag): ${VERSION}"
echo "Next semver: ${SEMVER}"
echo "Next release tag: ${NEW_VERSION}"
