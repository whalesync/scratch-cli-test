#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/bootstrap_release.sh <prod|test> <patch|minor|major>
#
# Computes the next desktop-release version, creates a DRAFT GitHub release on
# whalesync/scratch-desktop, updates scratch-desktop/package.json with the new
# semver, and writes scratch-desktop/release.env. The .env is consumed by
# downstream GitLab jobs via `artifacts.reports.dotenv`.

VARIANT=${1:-}
RELEASE_TYPE=${2:-}

if [[ "$VARIANT" != "prod" && "$VARIANT" != "test" ]]; then
  echo "Usage: $0 <prod|test> <patch|minor|major>"
  exit 1
fi
if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 <prod|test> <patch|minor|major>"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed."
  exit 1
fi

GITHUB_REPO="whalesync/scratch-desktop"

# Tags on the dedicated desktop repo are bare semver (prod) or semver-test (test).
# TAG_PATTERN is a regex passed to jq's test() so we can require an exact shape;
# `endswith` is too loose now that prod has no suffix at all.
if [ "$VARIANT" = "prod" ]; then
  TAG_SUFFIX=""
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
  IS_PRERELEASE=false
  FALLBACK_TAG="v0.1.0"
  RELEASE_BODY=""
else
  TAG_SUFFIX="-test"
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+-test$'
  IS_PRERELEASE=true
  FALLBACK_TAG="v0.0.0-test"
  # Stamp the monorepo commit into the body so the next hourly run can tell
  # whether anything changed since this release (see the no-op guard below).
  RELEASE_BODY="Test release pointing at test-api.scratch.md. Not for end users.
Source-Commit: ${CI_COMMIT_SHA:-unknown}"
fi
RELEASE_NAME_PREFIX="Scratch Desktop"

echo "Bootstrapping desktop ${VARIANT} release (${RELEASE_TYPE})..."

# Configure git (harmless if already set)
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"

curl_releases_page() {
  local page="${1:?page number required}"
  curl -sS --fail-with-body \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}"
}

# 1. Find the latest matching tag on GitHub, considering both published
#    releases AND drafts. `GET /releases` returns every release visible to
#    the token — drafts don't have git refs yet, but their reserved tag_name
#    still has to be avoided, or concurrent pipelines will both pick the
#    same version. Fetch the first 3 API pages (300 releases) so the max tag
#    is less likely to be missed than with a single page (same pattern as
#    preview_desktop_release_version.sh).
LATEST_TAG=$(
  {
    for page in 1 2 3; do
      curl_releases_page "$page"
      printf '\n'
    done
  } | jq -s 'add | .[] | select(.tag_name | test($pat)) | .tag_name' --arg pat "$TAG_PATTERN" -r \
  | sort -V -r \
  | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="$FALLBACK_TAG"
fi
echo "Latest tag (including drafts): $LATEST_TAG"

VERSION=$(echo "$LATEST_TAG" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
case "$RELEASE_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

SEMVER="$MAJOR.$MINOR.$PATCH"
NEW_VERSION="v${SEMVER}${TAG_SUFFIX}"
echo "Target version: $NEW_VERSION"

# 2b. Hourly-schedule no-op guard (test variant only). Bootstrap is the gate for
#     the whole desktop chain, so skipping here skips every downstream job. We
#     compare monorepo HEAD against the Source-Commit stamped on the last test
#     release; if nothing under the desktop app, the CLI it bundles, or
#     shared-types changed, write a RELEASE_SKIP sentinel into release.env and
#     exit 0 — BEFORE creating any draft, so a no-op leaves nothing to clean up.
#     Downstream jobs read RELEASE_SKIP from the dotenv and early-exit. Fails open
#     (builds) if the marker is missing/unreachable. FORCE_RELEASE=1 bypasses.
if [[ "$VARIANT" == "test" && "${CI_PIPELINE_SOURCE:-}" == "schedule" && "${FORCE_RELEASE:-}" != "1" ]]; then
  LAST_RELEASE_SHA=$(
    {
      for page in 1 2 3; do
        curl_releases_page "$page"
        printf '\n'
      done
    } | jq -s 'add | map(select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-test$")))
               | sort_by(.created_at) | reverse | .[0].body // ""' -r \
    | sed -n 's/^Source-Commit:[[:space:]]*//p' | tr -d '\r' | head -n1)
  if [ -n "$LAST_RELEASE_SHA" ] && [ "$LAST_RELEASE_SHA" != "unknown" ] \
     && git cat-file -e "${LAST_RELEASE_SHA}^{commit}" 2>/dev/null; then
    if git diff --quiet "$LAST_RELEASE_SHA" HEAD -- scratch-desktop/ scratch-git-2/ packages/shared-types/; then
      echo "No desktop-relevant changes since last test release ($LAST_RELEASE_SHA). Skipping."
      echo "RELEASE_SKIP=true" > release.env
      exit 0
    fi
    echo "Changes since $LAST_RELEASE_SHA — proceeding with test release."
  else
    echo "No usable prior Source-Commit marker — proceeding (cannot prove a no-op)."
  fi
fi

# 3. Fail if ANY release (draft or published) with this tag already exists.
#    GET /releases/tags only returns published releases, so we additionally
#    scan /releases for drafts with matching tag_name. Duplicate drafts cause
#    tag-collision 422s at finalize time — better to fail fast here.
#    A 404 from the tags endpoint means "no published release yet," which is
#    the happy path — so we don't use --fail-with-body.
TAG_LOOKUP_HTTP=$(curl -sS -o /tmp/tag_lookup_body -w "%{http_code}" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${NEW_VERSION}")
if [ "$TAG_LOOKUP_HTTP" = "200" ]; then
  echo "ERROR: Published release $NEW_VERSION already exists on GitHub."
  echo "       Bump the version or delete the release manually."
  exit 1
elif [ "$TAG_LOOKUP_HTTP" != "404" ]; then
  echo "ERROR: Unexpected HTTP $TAG_LOOKUP_HTTP from GET /releases/tags/${NEW_VERSION}. Response:"
  cat /tmp/tag_lookup_body
  exit 1
fi

DRAFT_DUP_ID=$(curl -sS --fail-with-body \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100" \
  | jq -r --arg tag "$NEW_VERSION" '.[] | select(.draft == true and .tag_name == $tag) | .id' \
  | head -n1)
if [ -n "$DRAFT_DUP_ID" ]; then
  echo "ERROR: Draft release with tag $NEW_VERSION already exists (id=$DRAFT_DUP_ID)."
  echo "       A prior pipeline likely failed mid-flight. Delete the draft on GitHub"
  echo "       (or wait for the cleanup job of the prior pipeline to run) and retry."
  exit 1
fi

# 4. Update version in package.json (will be picked up by downstream package.sh jobs)
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$SEMVER';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Updated package.json version to $SEMVER"

# 5. Create the draft release
RELEASE_JSON=$(curl -sS --fail-with-body -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "$(jq -n \
      --arg tag "$NEW_VERSION" \
      --arg name "${RELEASE_NAME_PREFIX} ${NEW_VERSION}" \
      --arg body "$RELEASE_BODY" \
      --argjson prerelease "$IS_PRERELEASE" \
      '{tag_name: $tag, name: $name, body: $body, draft: true, prerelease: $prerelease}')")

RELEASE_ID=$(echo "$RELEASE_JSON" | jq -r '.id')
if [ -z "$RELEASE_ID" ] || [ "$RELEASE_ID" = "null" ]; then
  echo "ERROR: Failed to create GitHub draft release. Response:"
  echo "$RELEASE_JSON"
  exit 1
fi
RELEASE_UPLOAD_URL=$(echo "$RELEASE_JSON" | jq -r '.upload_url')

echo "Created draft release $NEW_VERSION (id=$RELEASE_ID)"

# 6. Write release.env for downstream jobs
cat > release.env <<ENV
NEW_VERSION=$NEW_VERSION
SEMVER=$SEMVER
RELEASE_ID=$RELEASE_ID
RELEASE_UPLOAD_URL=$RELEASE_UPLOAD_URL
RELEASE_TAG_NAME=$NEW_VERSION
IS_PRERELEASE=$IS_PRERELEASE
RELEASE_SKIP=false
ENV

echo "Wrote release.env:"
cat release.env
