#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/release_test.sh [patch|minor|major]
RELEASE_TYPE=$1
GITHUB_REPO="whalesync/scratch-cli"
GITHUB_AUTH_URL="https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
GITHUB_REPO_URL="https://github.com/${GITHUB_REPO}.git"

if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

echo "Starting desktop TEST release process ($RELEASE_TYPE)..."

# Configure git
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"
git fetch --tags

# 1. Find latest production desktop-X.Y.Z tag to base off of
LATEST_TAG=$(git tag -l "desktop-*" --sort=-v:refname | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="desktop-0.0.0"
fi
echo "Latest production tag: $LATEST_TAG"

VERSION=${LATEST_TAG#desktop-}
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
if [ "$RELEASE_TYPE" == "major" ]; then MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; fi
if [ "$RELEASE_TYPE" == "minor" ]; then MINOR=$((MINOR + 1)); PATCH=0; fi
if [ "$RELEASE_TYPE" == "patch" ]; then PATCH=$((PATCH + 1)); fi

NEW_VERSION="v$MAJOR.$MINOR.$PATCH-desktop-test"
SEMVER="$MAJOR.$MINOR.$PATCH"
echo "Target test version: $NEW_VERSION"

# 3. Clean up existing test tag/release on GitHub if it already exists
REMOTE_EXISTS=$(git ls-remote --tags "$GITHUB_REPO_URL" "refs/tags/$NEW_VERSION" 2>/dev/null)
if [ -n "$REMOTE_EXISTS" ]; then
  echo "Tag $NEW_VERSION already exists — cleaning up..."

  RELEASE_JSON=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/$NEW_VERSION")
  RELEASE_ID=$(echo "$RELEASE_JSON" | grep -m1 '"id":' | tr -d ' ",' | cut -d: -f2)
  if [ -n "$RELEASE_ID" ] && [ "$RELEASE_ID" != "null" ]; then
    curl -s -X DELETE -H "Authorization: token $GITHUB_TOKEN" \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/$RELEASE_ID" || true
  fi

  git push --delete "$GITHUB_AUTH_URL" "$NEW_VERSION" || true
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

# Ad-hoc codesign macOS .app bundles so they can launch without Apple Developer certs.
# Only runs on macOS (codesign isn't available on Linux).
if command -v codesign &>/dev/null; then
  for APP in dist/mac-*/*.app; do
    [ -d "$APP" ] || continue
    echo "Ad-hoc signing $APP..."
    codesign --force --deep --sign - "$APP"
  done
fi

# 6. Collect artifacts into dist-release-test
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

# 7. Compute checksums
(cd "$DIST_DIR" && shasum -a 256 * 2>/dev/null | grep -v checksums.txt > checksums.txt)

# 8. Create tag and push to GitHub
git tag -f "$NEW_VERSION"
git push -f "$GITHUB_AUTH_URL" "$NEW_VERSION"

# 9. Create GitHub release (prerelease = true, no Homebrew update)
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

RELEASE_ID=$(echo "$RELEASE_JSON" | grep -m1 '"id":' | tr -d ' ",' | cut -d: -f2)

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

echo "Test release $NEW_VERSION complete. Artifacts at: $BASE_URL"
echo "(No Homebrew update for test releases)"
