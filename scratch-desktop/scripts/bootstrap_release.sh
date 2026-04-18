#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/bootstrap_release.sh <prod|test> <patch|minor|major>
#
# Computes the next desktop-release version, creates a DRAFT GitHub release on
# whalesync/scratch-cli, updates scratch-desktop/package.json with the new
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

GITHUB_REPO="whalesync/scratch-cli"
GITHUB_REPO_URL="https://github.com/${GITHUB_REPO}.git"

if [ "$VARIANT" = "prod" ]; then
  TAG_SUFFIX="-desktop"
  IS_PRERELEASE=false
  RELEASE_NAME_PREFIX="Scratch Desktop"
  FALLBACK_TAG="v0.1.0-desktop"
  RELEASE_BODY=""
else
  TAG_SUFFIX="-desktop-test"
  IS_PRERELEASE=true
  RELEASE_NAME_PREFIX="Scratch"
  FALLBACK_TAG="v0.0.0-desktop-test"
  RELEASE_BODY="Test release pointing at test-api.scratch.md. Not for end users."
fi

echo "Bootstrapping desktop ${VARIANT} release (${RELEASE_TYPE})..."

# Configure git (harmless if already set)
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"

# 1. Find the latest matching tag on the GitHub release repo
LATEST_TAG=$(git ls-remote --tags "$GITHUB_REPO_URL" "*${TAG_SUFFIX}" \
  | sed 's|.*/||' \
  | grep -v '\^{}' \
  | sort -V -r \
  | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="$FALLBACK_TAG"
fi
echo "Latest tag: $LATEST_TAG"

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

# 3. Fail if a published (non-draft) release with this tag already exists.
#    Stale drafts from prior failed pipelines are OK — we'll delete them below.
#    A 404 here means "tag doesn't exist yet," which is the happy path — so we
#    don't use --fail-with-body; instead we distinguish via the HTTP status.
TAG_LOOKUP_HTTP=$(curl -sS -o /tmp/tag_lookup_body -w "%{http_code}" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${NEW_VERSION}")
if [ "$TAG_LOOKUP_HTTP" = "200" ]; then
  PUBLISHED_EXISTS=$(jq -r 'select(.draft == false) | .id // empty' < /tmp/tag_lookup_body)
  if [ -n "$PUBLISHED_EXISTS" ]; then
    echo "ERROR: Published release $NEW_VERSION already exists on GitHub."
    echo "       Bump the version or delete the release manually."
    exit 1
  fi
elif [ "$TAG_LOOKUP_HTTP" != "404" ]; then
  echo "ERROR: Unexpected HTTP $TAG_LOOKUP_HTTP from GET /releases/tags/${NEW_VERSION}. Response:"
  cat /tmp/tag_lookup_body
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
ENV

echo "Wrote release.env:"
cat release.env
