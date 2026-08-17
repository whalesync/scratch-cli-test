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

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "WARN: GITHUB_TOKEN is not set — falling back to the unauthenticated GitHub API." >&2
  echo "      Drafts will be invisible and private repos will 404. Rate limit is 60 req/hr per IP." >&2
fi

GITHUB_REPO="whalesync/scratch-desktop"

# VERSION_SELECT_PATTERN is what we scan to pick the version to bump FROM. For
# the test variant it is broader than TAG_PATTERN: it also matches the prod
# bare-semver tags so the test version is floored at the prod line and can never
# regress below the latest prod release. Mirrors bootstrap_release.sh (DEV-10749).
if [ "$VARIANT" = "prod" ]; then
  TAG_SUFFIX=""
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
  VERSION_SELECT_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
  FALLBACK_TAG="v0.1.0"
else
  TAG_SUFFIX="-test"
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+-test$'
  VERSION_SELECT_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-test)?$'
  FALLBACK_TAG="v0.0.0-test"
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

# Same as bootstrap_release.sh, but scans GitHub's first 5 pages (bootstrap uses 3).
# Highest base semver matching VERSION_SELECT_PATTERN (regex), version-sorted
# descending with any `-test` suffix stripped so the prod and test lines compare
# on the same axis; drafts included.
# Fetch pages ONCE and fail closed if the API is unreachable or returns non-array
# JSON, instead of letting an empty/error result silently fall back to
# FALLBACK_TAG and print a misleading next version. Mirrors bootstrap_release.sh
# (which cut a real v0.1.1 this way, DEV-10749). We do NOT `set -o pipefail` — the
# `sort -V | head -n1` pipeline relies on head closing the pipe early.
ALL_RELEASES_JSON=""
for page in 1 2 3 4 5; do
  if ! PAGE_JSON=$(curl_releases_page "$page"); then
    echo "ERROR: failed to fetch releases page $page from GitHub (${GITHUB_REPO})." >&2
    echo "       (An unauthenticated call is rate-limited to 60/hr — set GITHUB_TOKEN.)" >&2
    exit 1
  fi
  if ! printf '%s' "$PAGE_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "ERROR: GitHub releases page $page was not a JSON array. Response:" >&2
    printf '%s\n' "$PAGE_JSON" >&2
    exit 1
  fi
  ALL_RELEASES_JSON+="${PAGE_JSON}"$'\n'
done

TOTAL_RELEASE_COUNT=$(printf '%s' "$ALL_RELEASES_JSON" | jq -s 'add | length')

HIGHEST_EXISTING_BASE_SEMVER=$(printf '%s' "$ALL_RELEASES_JSON" \
  | jq -s 'add | .[] | select(.tag_name | test($pat)) | .tag_name' --arg pat "$VERSION_SELECT_PATTERN" -r \
  | sed 's/-test$//' \
  | sort -V -r \
  | head -n1)
if [ -z "$HIGHEST_EXISTING_BASE_SEMVER" ]; then
  if [ "${TOTAL_RELEASE_COUNT:-0}" -gt 0 ]; then
    echo "ERROR: ${TOTAL_RELEASE_COUNT} releases exist but none match ${VERSION_SELECT_PATTERN} — refusing to fall back to ${FALLBACK_TAG}." >&2
    exit 1
  fi
  HIGHEST_EXISTING_BASE_SEMVER=$(echo "$FALLBACK_TAG" | sed 's/-test$//')
fi
LATEST_TAG="$HIGHEST_EXISTING_BASE_SEMVER"

VERSION=$(echo "$HIGHEST_EXISTING_BASE_SEMVER" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

case "$RELEASE_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

SEMVER="$MAJOR.$MINOR.$PATCH"
NEW_VERSION="v${SEMVER}${TAG_SUFFIX}"

# Safety floor (mirrors bootstrap_release.sh): the computed version must be
# strictly greater than the highest existing release observed, so a preview can
# never confidently print a version that would sit at/below "latest".
GREATEST_SEMVER=$(printf '%s\n%s\n' "$SEMVER" "$HIGHEST_EXISTING_BASE_SEMVER" | sort -V | tail -n1)
if [ "$SEMVER" = "$HIGHEST_EXISTING_BASE_SEMVER" ] || [ "$SEMVER" != "$GREATEST_SEMVER" ]; then
  echo "ERROR: computed version $SEMVER is not greater than the highest existing release $HIGHEST_EXISTING_BASE_SEMVER." >&2
  exit 1
fi

echo "Variant: ${VARIANT} (${RELEASE_TYPE} bump)"
echo "Latest tag (including drafts): ${LATEST_TAG}"
echo "Base semver (from tag): ${VERSION}"
echo "Next semver: ${SEMVER}"
echo "Next release tag: ${NEW_VERSION}"
