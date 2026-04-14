#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/release_test.sh [patch|minor|major]
RELEASE_TYPE=$1
GITHUB_REPO="whalesync/scratch-cli"
GITHUB_REPO_URL="https://github.com/${GITHUB_REPO}.git"

if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed."
  echo "  macOS: brew install jq"
  exit 1
fi

echo "Starting desktop TEST release process ($RELEASE_TYPE)..."

# Configure git
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"

# 1. Find latest desktop test tag from the GitHub release repo
# (tags live on GitHub, not in this GitLab repo)
# Tags use format: v0.0.1-desktop-test
LATEST_TAG=$(git ls-remote --tags "$GITHUB_REPO_URL" "*-desktop-test" \
  | sed 's|.*/||' \
  | grep -v '\^{}' \
  | sort -V -r \
  | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="v0.0.0-desktop-test"
fi
echo "Latest tag: $LATEST_TAG"

# Extract semver: v0.0.1-desktop-test -> 0.0.1
VERSION=$(echo "$LATEST_TAG" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
if [ "$RELEASE_TYPE" == "major" ]; then MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; fi
if [ "$RELEASE_TYPE" == "minor" ]; then MINOR=$((MINOR + 1)); PATCH=0; fi
if [ "$RELEASE_TYPE" == "patch" ]; then PATCH=$((PATCH + 1)); fi

NEW_VERSION="v$MAJOR.$MINOR.$PATCH-desktop-test"
SEMVER="$MAJOR.$MINOR.$PATCH"
echo "Target test version: $NEW_VERSION"

# 3. Fail if this version already exists on GitHub
REMOTE_EXISTS=$(git ls-remote --tags "$GITHUB_REPO_URL" "refs/tags/$NEW_VERSION" 2>/dev/null)
if [ -n "$REMOTE_EXISTS" ]; then
  echo "ERROR: Tag $NEW_VERSION already exists on GitHub. Delete the release manually or bump the version."
  exit 1
fi

# 4. Update version in package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$SEMVER';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Updated package.json version to $SEMVER"

TEST_API_URL="https://test-api.scratch.md"

# 5. Build the Electron app for all targets
echo "Building Electron app..."
rm -rf "./dist"
VITE_SCRATCH_API_URL="$TEST_API_URL" yarn build

# Configurable via CI variables (defaults match current behavior)
MAC_TARGETS="${MAC_TARGETS:-zip}"
BUILD_LINUX="${BUILD_LINUX:-true}"

# Build macOS targets (unsigned — test releases never need signing)
# NOTE: DMG requires dmg-license module + macOS host, so we only build ZIP on Linux CI.
# Set MAC_TARGETS="dmg zip" and BUILD_LINUX="false" for native macOS builds.
echo "Packaging macOS targets (unsigned, ${MAC_TARGETS})..."
# shellcheck disable=SC2086
# intentional word splitting for multiple targets
CSC_IDENTITY_AUTO_DISCOVERY=false yarn electron-builder --mac $MAC_TARGETS --publish never

# Build Linux targets (can be disabled via BUILD_LINUX=false)
if [ "$BUILD_LINUX" = "true" ]; then
  echo "Packaging Linux targets..."
  yarn electron-builder --linux --publish never
fi

# 6. Ad-hoc codesign the .app bundle (requires macOS host with codesign)
for APP in dist/mac-arm64/*.app; do
  [ -d "$APP" ] || continue
  if command -v codesign &>/dev/null; then
    echo "Ad-hoc signing $APP..."
    chmod +x scripts/fix_macos_app_signatures.sh
    scripts/fix_macos_app_signatures.sh "$APP"
  else
    echo "WARNING: codesign not available (not on macOS). Skipping ad-hoc signing."
  fi
done

# 7. Collect artifacts into dist-release-test
DIST_DIR="./dist-release-test"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
echo "Collecting artifacts..."
for FILE in dist/*.dmg dist/*.zip dist/*.AppImage dist/*.deb; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  cp "$FILE" "$DIST_DIR/$FNAME"
  echo "  $FNAME"
done
# Zip .app bundles so they can be uploaded to the GitHub release
for APP in dist/mac-arm64/*.app; do
  [ -d "$APP" ] || continue
  APPNAME=$(basename "$APP" .app)
  ZIPNAME="${APPNAME}.app.zip"
  echo "  Zipping $APP → $ZIPNAME"
  (cd dist/mac-arm64 && zip -r -y "../../$DIST_DIR/$ZIPNAME" "$(basename "$APP")")
done
# Copy linux-unpacked
if [ -d "dist/linux-unpacked" ]; then
  cp -R dist/linux-unpacked "$DIST_DIR/linux-unpacked"
  echo "  linux-unpacked/"
fi

# 8. Validate at least one artifact was collected
ARTIFACT_COUNT=$(find "$DIST_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')
if [ "$ARTIFACT_COUNT" -eq 0 ]; then
  echo "ERROR: No build artifacts found in $DIST_DIR. Aborting release."
  exit 1
fi
echo "Found $ARTIFACT_COUNT artifact(s)"

# 9. Compute checksums (files only, not directories like .app or linux-unpacked)
# shellcheck disable=SC2094
# checksums.txt is excluded by grep -v before the redirect, so no read/write conflict
(cd "$DIST_DIR" && find . -maxdepth 1 -type f ! -name checksums.txt -exec shasum -a 256 {} + > checksums.txt)

# 10. Create GitHub release (prerelease = true, no Homebrew update)
# The release API creates the tag on GitHub automatically — no need to push a local tag.
RELEASE_JSON=$(curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "{
    \"tag_name\": \"$NEW_VERSION\",
    \"name\": \"Scratch $NEW_VERSION\",
    \"draft\": false,
    \"prerelease\": true,
    \"body\": \"Test release pointing at test-api.scratch.md. Not for end users.\"
  }")

RELEASE_ID=$(echo "$RELEASE_JSON" | jq -r '.id')
if [ -z "$RELEASE_ID" ] || [ "$RELEASE_ID" = "null" ]; then
  echo "ERROR: Failed to create GitHub release. Response:"
  echo "$RELEASE_JSON"
  exit 1
fi

BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${NEW_VERSION}"
for FILE in "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip "$DIST_DIR"/*.AppImage "$DIST_DIR"/*.deb; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  echo "Uploading $FNAME..."
  curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${FNAME}" \
    --data-binary "@$FILE"
done

RELEASE_URL="https://github.com/${GITHUB_REPO}/releases/tag/${NEW_VERSION}"
echo ""
echo "✓ Test release $NEW_VERSION complete"
echo "  Release URL: $RELEASE_URL"
echo "  Artifacts: $BASE_URL"
echo "(No Homebrew update for test releases)"

# Generate annotations.json for GitLab CI
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
echo "Generated annotations.json"
