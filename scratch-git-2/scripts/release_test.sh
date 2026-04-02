#!/bin/bash
set -e
# Ensure we are in the scratch-git-2 directory regardless of where the script is called from
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

echo "Starting TEST release process ($RELEASE_TYPE)..."

# Configure git
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"
git fetch --tags

# 1. Find latest production cli-X.Y.Z tag to base off of
LATEST_TAG=$(git tag -l "cli-*" --sort=-v:refname | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="cli-0.0.0"
fi
echo "Latest production tag: $LATEST_TAG"

VERSION=${LATEST_TAG#cli-}
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
if [ "$RELEASE_TYPE" == "major" ]; then MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; fi
if [ "$RELEASE_TYPE" == "minor" ]; then MINOR=$((MINOR + 1)); PATCH=0; fi
if [ "$RELEASE_TYPE" == "patch" ]; then PATCH=$((PATCH + 1)); fi

NEW_VERSION="v$MAJOR.$MINOR.$PATCH-test"
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

TEST_SERVER_URL="https://test-api.scratch.md"
BINARY="scratchmd"
DIST_DIR="$(pwd)/dist-release-test"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 4. Inject release version into Cargo.toml so the binary reports the correct version
VERSION_NO_TEST="${MAJOR}.${MINOR}.${PATCH}"
sed -i "s/^version = .*/version = \"$VERSION_NO_TEST\"/" Cargo.toml

# Build all targets pointing at test server
declare -A TARGETS=(
  ["aarch64-apple-darwin"]="${BINARY}_darwin_arm64"
  ["x86_64-unknown-linux-gnu"]="${BINARY}_linux_amd64"
  ["x86_64-pc-windows-gnu"]="${BINARY}_windows_amd64"
)

for TARGET in "${!TARGETS[@]}"; do
  # Output markers for sections in Gitlab job view
  echo -e "\e[0Ksection_start:$(date +%s):${TARGET}\r\e[0KBuilding ${TARGET}"

  SCRATCH_DEFAULT_URL="$TEST_SERVER_URL" cargo zigbuild --release --bin "$BINARY" --target "$TARGET"

  echo -e "\e[0Ksection_end:$(date +%s):${TARGET}\r\e[0K"
done

# 5. Package archives (same naming as prod for compatibility)
for TARGET in "${!TARGETS[@]}"; do
  ARCHIVE_BASE="${TARGETS[$TARGET]}"
  SRC_DIR="target/$TARGET/release"

  if [[ "$TARGET" == *"windows"* ]]; then
    ZIP="$DIST_DIR/${ARCHIVE_BASE}.zip"
    zip -j "$ZIP" "$SRC_DIR/${BINARY}.exe"
  else
    TGZ="$DIST_DIR/${ARCHIVE_BASE}.tar.gz"
    tar -czf "$TGZ" -C "$SRC_DIR" "$BINARY"
  fi
done

# 6. Create tag and push to GitHub
if [ -z "$GITHUB_TOKEN" ]; then
  echo "WARNING: GITHUB_TOKEN is not set — skipping GitHub release. Binaries were built successfully."
  exit 0
fi

git tag -f "$NEW_VERSION"
git push -f "$GITHUB_AUTH_URL" "$NEW_VERSION"

# 7. Create GitHub release (prerelease = true, no Homebrew/Scoop update)
RELEASE_JSON=$(curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "{
    \"tag_name\": \"$NEW_VERSION\",
    \"name\": \"scratchmd $NEW_VERSION\",
    \"draft\": false,
    \"prerelease\": true,
    \"body\": \"Test release pointing at test-api.scratch.md. Not for end users.\"
  }")

RELEASE_ID=$(echo "$RELEASE_JSON" | grep -m1 '"id":' | tr -d ' ",' | cut -d: -f2)

BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${NEW_VERSION}"
for FILE in "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  echo "Uploading $FNAME..."
  curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${FNAME}" \
    --data-binary "@$FILE"
done

echo "Test release $NEW_VERSION complete. Artifacts at: $BASE_URL"
echo "(No Homebrew or Scoop update for test releases)"
