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

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed."
  echo "  macOS: brew install jq"
  exit 1
fi

echo "Starting desktop release process ($RELEASE_TYPE)..."

# Configure git
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"

# 1. Find latest desktop release tag from the GitHub release repo
# (tags live on GitHub, not in this GitLab repo)
# Production tags use format: v0.1.0-desktop
LATEST_TAG=$(git ls-remote --tags "$GITHUB_REPO_URL" "*-desktop" \
  | sed 's|.*/||' \
  | grep -v '\^{}' \
  | sort -V -r \
  | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="v0.1.0-desktop"
fi
echo "Latest tag: $LATEST_TAG"

# Extract semver: v0.1.0-desktop -> 0.1.0
VERSION=$(echo "$LATEST_TAG" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
if [ "$RELEASE_TYPE" == "major" ]; then MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; fi
if [ "$RELEASE_TYPE" == "minor" ]; then MINOR=$((MINOR + 1)); PATCH=0; fi
if [ "$RELEASE_TYPE" == "patch" ]; then PATCH=$((PATCH + 1)); fi

NEW_VERSION="v$MAJOR.$MINOR.$PATCH-desktop"
SEMVER="$MAJOR.$MINOR.$PATCH"
echo "Target version: $NEW_VERSION"

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

PROD_API_URL="https://api.scratch.md"
PROD_WEB_URL="https://app.scratch.md"

# 5. Build the Electron app for all targets
#
# NOTE: electron-builder on Linux can cross-build Linux targets natively.
# macOS targets (.dmg) are built WITHOUT code signing for now.
# When Apple Developer certificates are available:
#   - Set CSC_LINK (base64 .p12) and CSC_KEY_PASSWORD in CI variables
#   - Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID for notarization
#   - electron-builder will automatically sign and notarize when these are present
echo "Building Electron app..."
rm -rf "./dist"
VITE_SCRATCH_API_URL="$PROD_API_URL" VITE_SCRATCH_WEB_URL="$PROD_WEB_URL" yarn build

# Build macOS targets (ad-hoc signed but not notarized for now)
# TODO: Add code notarizing — set CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID,
#       APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID CI variables.
#       electron-builder handles signing automatically when these are present.
# NOTE: DMG requires dmg-license module + macOS host, so Linux CI defaults to zip only;
#       a macOS runner can opt into dmg via MAC_TARGETS (e.g. "dmg zip").
MAC_TARGETS="${MAC_TARGETS:-zip}"
echo "Packaging macOS targets ($MAC_TARGETS)..."
yarn electron-builder --mac $MAC_TARGETS --publish never

# Build Linux targets (skip on hosts that can't cross-compile, e.g. macOS runners)
BUILD_LINUX="${BUILD_LINUX:-true}"
if [ "$BUILD_LINUX" = "true" ]; then
  echo "Packaging Linux targets..."
  yarn electron-builder --linux --x64 --publish never
else
  echo "Skipping Linux packaging (BUILD_LINUX=$BUILD_LINUX)"
fi

# 7. Collect and rename artifacts into dist-release
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

# 9. Compute SHA256 for each archive (files only, not directories like .app or linux-unpacked)
SHA_FILE="$DIST_DIR/checksums.txt"
(cd "$DIST_DIR" && find . -maxdepth 1 -type f ! -name checksums.txt -exec shasum -a 256 {} + > checksums.txt)
echo "SHA256 checksums:"
cat "$SHA_FILE"

# Helper: extract sha256 for a given archive name
sha_for() { grep "$1" "$SHA_FILE" | awk '{print $1}'; }

# 10. Create GitHub release and upload artifacts
# The release API creates the tag on GitHub automatically — no need to push a local tag.
echo "Creating GitHub release $NEW_VERSION..."
RELEASE_JSON=$(curl -sS --fail-with-body -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "{
    \"tag_name\": \"$NEW_VERSION\",
    \"name\": \"Scratch Desktop $NEW_VERSION\",
    \"draft\": false,
    \"prerelease\": false
  }")

RELEASE_ID=$(echo "$RELEASE_JSON" | jq -r '.id')
if [ -z "$RELEASE_ID" ] || [ "$RELEASE_ID" = "null" ]; then
  echo "ERROR: Failed to create GitHub release. Response:"
  echo "$RELEASE_JSON"
  exit 1
fi
echo "Release ID: $RELEASE_ID"

for FILE in "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip "$DIST_DIR"/*.AppImage "$DIST_DIR"/*.deb; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  echo "Uploading $FNAME..."
  curl -sS --fail-with-body -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${FNAME}" \
    --data-binary "@$FILE"
done

# 11. Update Homebrew cask in whalesync/homebrew-scratch-cli
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
  # Use temp file for portability (BSD sed -i requires extension arg, GNU sed -i does not)
  sed "s/cask \"scratch-desktop\"/cask \"${CASK_FILE}\"/" "$TAP_DIR/Casks/${CASK_FILE}.rb" > "$TAP_DIR/Casks/${CASK_FILE}.rb.tmp" \
    && mv "$TAP_DIR/Casks/${CASK_FILE}.rb.tmp" "$TAP_DIR/Casks/${CASK_FILE}.rb"
done

(cd "$TAP_DIR" && \
  git add Casks/scratch-desktop*.rb && \
  git commit -m "Scratch Desktop $NEW_VERSION" && \
  git push)
rm -rf "$TAP_DIR"

# Version state is tracked by GitHub tags — no GitLab tag needed.

RELEASE_URL="https://github.com/${GITHUB_REPO}/releases/tag/${NEW_VERSION}"
echo ""
echo "✓ Release $NEW_VERSION complete"
echo "  Release URL: $RELEASE_URL"
echo "  Homebrew cask updated"

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
