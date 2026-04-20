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

# 1. Find the latest matching tag on GitHub, considering both published
#    releases AND drafts. `GET /releases` returns every release visible to
#    the token — drafts don't have git refs yet, but their reserved tag_name
#    still has to be avoided, or concurrent pipelines will both pick the
#    same version.
LATEST_TAG=$(curl -sS --fail-with-body \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100" \
  | jq -r --arg suf "$TAG_SUFFIX" '.[] | select(.tag_name | endswith($suf)) | .tag_name' \
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
ENV

echo "Wrote release.env:"
cat release.env
