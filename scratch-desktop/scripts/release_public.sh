#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/release_public.sh [patch|minor|major]
RELEASE_TYPE=$1
GITHUB_REPO="whalesync/scratch-cli"
GITHUB_REPO_URL="https://github.com/${GITHUB_REPO}.git"

if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

echo "Starting desktop release process ($RELEASE_TYPE)..."

# Configure git
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"
git fetch --tags

# 1. Find latest desktop-X.Y.Z tag (separate sequence from the CLI)
LATEST_TAG=$(git tag -l "desktop-*" --sort=-v:refname | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="desktop-0.1.0"
fi
echo "Latest tag: $LATEST_TAG"

VERSION=${LATEST_TAG#desktop-}
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
if [ "$RELEASE_TYPE" == "major" ]; then MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; fi
if [ "$RELEASE_TYPE" == "minor" ]; then MINOR=$((MINOR + 1)); PATCH=0; fi
if [ "$RELEASE_TYPE" == "patch" ]; then PATCH=$((PATCH + 1)); fi

NEW_VERSION="v$MAJOR.$MINOR.$PATCH-desktop"
DESKTOP_TAG="desktop-$MAJOR.$MINOR.$PATCH"
SEMVER="$MAJOR.$MINOR.$PATCH"
echo "Target version: $NEW_VERSION (gitlab tag: $DESKTOP_TAG)"

# 3. Update version in package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$SEMVER';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Updated package.json version to $SEMVER"

PROD_API_URL="https://api.scratch.md"

# 4. Build the Electron app for all targets
#
# NOTE: electron-builder on Linux can cross-build Linux targets natively.
# macOS targets (.dmg) are built WITHOUT code signing for now.
# When Apple Developer certificates are available:
#   - Set CSC_LINK (base64 .p12) and CSC_KEY_PASSWORD in CI variables
#   - Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID for notarization
#   - electron-builder will automatically sign and notarize when these are present
echo "Building Electron app..."
rm -rf "./dist"
VITE_SCRATCH_API_URL="$PROD_API_URL" yarn build

# Build macOS targets (unsigned for now)
# TODO: Add code signing — set CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID,
#       APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID CI variables.
#       electron-builder handles signing automatically when these are present.
# NOTE: DMG requires dmg-license module + macOS host, so we only build ZIP on Linux CI.
# TODO: Add DMG builds when we have a macOS runner with code signing.
echo "Packaging macOS targets (unsigned, zip only)..."
CSC_IDENTITY_AUTO_DISCOVERY=false yarn electron-builder --mac zip --publish never

# Build Linux targets
echo "Packaging Linux targets..."
yarn electron-builder --linux --publish never

# 5. Collect and rename artifacts into dist-release
DIST_DIR="./dist-release"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
echo "Collecting artifacts..."
for FILE in dist/*.dmg dist/*.zip dist/*.AppImage dist/*.deb; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  cp "$FILE" "$DIST_DIR/$FNAME"
  echo "  $FNAME"
done

# 6. Compute SHA256 for each archive
SHA_FILE="$DIST_DIR/checksums.txt"
(cd "$DIST_DIR" && shasum -a 256 *.dmg *.zip *.AppImage *.deb 2>/dev/null > checksums.txt)
echo "SHA256 checksums:"
cat "$SHA_FILE"

# Helper: extract sha256 for a given archive name
sha_for() { grep "$1" "$SHA_FILE" | awk '{print $1}'; }

# 7. Create GitHub release tag on remote HEAD
echo "Creating GitHub tag $NEW_VERSION..."
REMOTE_SHA=$(git ls-remote "$GITHUB_REPO_URL" HEAD | awk '{ print $1 }')
curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/repos/${GITHUB_REPO}/git/refs" \
     -d "{\"ref\": \"refs/tags/$NEW_VERSION\", \"sha\": \"$REMOTE_SHA\"}"

# 8. Create GitHub release and upload artifacts
echo "Creating GitHub release $NEW_VERSION..."
RELEASE_JSON=$(curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "{
    \"tag_name\": \"$NEW_VERSION\",
    \"name\": \"Scratch Desktop $NEW_VERSION\",
    \"draft\": false,
    \"prerelease\": false
  }")

RELEASE_ID=$(echo "$RELEASE_JSON" | grep -m1 '"id":' | tr -d ' ",' | cut -d: -f2)
echo "Release ID: $RELEASE_ID"

for FILE in "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip "$DIST_DIR"/*.AppImage "$DIST_DIR"/*.deb; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  echo "Uploading $FNAME..."
  curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${FNAME}" \
    --data-binary "@$FILE"
done

# 9. Update Homebrew cask in whalesync/homebrew-scratch-cli
echo "Updating Homebrew cask..."
TAP_DIR=$(mktemp -d)
git clone "https://${GITHUB_TOKEN}@github.com/whalesync/homebrew-scratch-cli.git" "$TAP_DIR"

SHA_DARWIN_ARM64=$(sha_for "Scratch Desktop-${SEMVER}-arm64.zip")
SHA_DARWIN_AMD64=$(sha_for "Scratch Desktop-${SEMVER}-x64.zip")
BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${NEW_VERSION}"

# Homebrew cask formula for the desktop app
# TODO: Switch URLs to .dmg once we have a macOS runner with code signing
mkdir -p "$TAP_DIR/Casks"
cat > "$TAP_DIR/Casks/scratch-desktop.rb" <<RUBY
cask "scratch-desktop" do
  version "$SEMVER"

  if Hardware::CPU.arm?
    url "${BASE_URL}/Scratch%20Desktop-${SEMVER}-arm64.zip"
    sha256 "${SHA_DARWIN_ARM64}"
  else
    url "${BASE_URL}/Scratch%20Desktop-${SEMVER}-x64.zip"
    sha256 "${SHA_DARWIN_AMD64}"
  end

  name "Scratch Desktop"
  desc "Scratch content management desktop app"
  homepage "https://github.com/${GITHUB_REPO}"

  app "Scratch Desktop.app"

  zap trash: [
    "~/Library/Application Support/Scratch Desktop",
    "~/Library/Preferences/com.scratch.desktop.plist",
    "~/Library/Caches/com.scratch.desktop",
  ]
end
RUBY

# Also write versioned cask variants
for VARIANT in \
  "scratch-desktop@${MAJOR}:ScratchDesktopAT${MAJOR}" \
  "scratch-desktop@${MAJOR}.${MINOR}:ScratchDesktopAT${MAJOR}${MINOR}" \
  "scratch-desktop@${MAJOR}.${MINOR}.${PATCH}:ScratchDesktopAT${MAJOR}${MINOR}${PATCH}"; do
  CASK_FILE="${VARIANT%%:*}"
  cp "$TAP_DIR/Casks/scratch-desktop.rb" "$TAP_DIR/Casks/${CASK_FILE}.rb"
  # Update the cask name in the file
  sed -i "s/cask \"scratch-desktop\"/cask \"${CASK_FILE}\"/" "$TAP_DIR/Casks/${CASK_FILE}.rb"
done

(cd "$TAP_DIR" && \
  git add Casks/scratch-desktop*.rb && \
  git commit -m "Scratch Desktop $NEW_VERSION" && \
  git push)
rm -rf "$TAP_DIR"

# 10. Tag GitLab with desktop-X.Y.Z to save state for next release
echo "Tagging GitLab with $DESKTOP_TAG..."
git tag "$DESKTOP_TAG"
git push "https://oauth2:${CICD_ACCESS_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" "$DESKTOP_TAG"

echo "Release $NEW_VERSION complete."
