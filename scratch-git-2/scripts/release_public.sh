#!/bin/bash
set -e
# Ensure we are in the scratch-git-2 directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/release_public.sh [patch|minor|major]
RELEASE_TYPE=$1
GITHUB_REPO="whalesync/scratch-cli"
GITHUB_REPO_URL="https://github.com/${GITHUB_REPO}.git"

if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

echo "Starting release process ($RELEASE_TYPE)..."

# Configure git
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"
git fetch --tags

# 1. Find latest cli-X.Y.Z tag (shared sequence with the Go CLI)
LATEST_TAG=$(git tag -l "cli-*" --sort=-v:refname | head -n1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="cli-0.2.3"
fi
echo "Latest tag: $LATEST_TAG"

VERSION=${LATEST_TAG#cli-}
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
if [ "$RELEASE_TYPE" == "major" ]; then MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; fi
if [ "$RELEASE_TYPE" == "minor" ]; then MINOR=$((MINOR + 1)); PATCH=0; fi
if [ "$RELEASE_TYPE" == "patch" ]; then PATCH=$((PATCH + 1)); fi

NEW_VERSION="v$MAJOR.$MINOR.$PATCH"
CLI_TAG="cli-$MAJOR.$MINOR.$PATCH"
echo "Target version: $NEW_VERSION (gitlab tag: $CLI_TAG)"

PROD_SERVER_URL="https://api.scratch.md"
BINARY="scratchmd"
DIST_DIR="$(pwd)/dist-release"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 3. Build all targets
declare -A TARGETS=(
  ["aarch64-apple-darwin"]="${BINARY}_darwin_arm64"
  ["x86_64-unknown-linux-gnu"]="${BINARY}_linux_amd64"
  ["x86_64-pc-windows-gnu"]="${BINARY}_windows_amd64"
)

for TARGET in "${!TARGETS[@]}"; do
  echo "Building $TARGET..."
  SCRATCH_DEFAULT_URL="$PROD_SERVER_URL" cargo zigbuild --release --bin "$BINARY" --target "$TARGET"
done

# 4. Package archives
for TARGET in "${!TARGETS[@]}"; do
  ARCHIVE_BASE="${TARGETS[$TARGET]}"
  SRC_DIR="target/$TARGET/release"

  if [[ "$TARGET" == *"windows"* ]]; then
    ZIP="$DIST_DIR/${ARCHIVE_BASE}.zip"
    zip -j "$ZIP" "$SRC_DIR/${BINARY}.exe"
    echo "Created $ZIP"
  else
    TGZ="$DIST_DIR/${ARCHIVE_BASE}.tar.gz"
    tar -czf "$TGZ" -C "$SRC_DIR" "$BINARY"
    echo "Created $TGZ"
  fi
done

# 5. Compute SHA256 for each archive
SHA_FILE="$DIST_DIR/checksums.txt"
(cd "$DIST_DIR" && shasum -a 256 *.tar.gz *.zip 2>/dev/null > checksums.txt)
echo "SHA256 checksums:"
cat "$SHA_FILE"

# Helper: extract sha256 for a given archive name
sha_for() { grep "$1" "$SHA_FILE" | awk '{print $1}'; }

# 6. Create GitHub release tag on remote HEAD
echo "Creating GitHub tag $NEW_VERSION..."
REMOTE_SHA=$(git ls-remote "$GITHUB_REPO_URL" HEAD | awk '{ print $1 }')
curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/repos/${GITHUB_REPO}/git/refs" \
     -d "{\"ref\": \"refs/tags/$NEW_VERSION\", \"sha\": \"$REMOTE_SHA\"}"

# 7. Create GitHub release and upload artifacts
echo "Creating GitHub release $NEW_VERSION..."
RELEASE_JSON=$(curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "{
    \"tag_name\": \"$NEW_VERSION\",
    \"name\": \"scratchmd $NEW_VERSION\",
    \"draft\": false,
    \"prerelease\": false
  }")

RELEASE_ID=$(echo "$RELEASE_JSON" | grep -m1 '"id":' | tr -d ' ",' | cut -d: -f2)
echo "Release ID: $RELEASE_ID"

for FILE in "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  echo "Uploading $FNAME..."
  curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}/assets?name=${FNAME}" \
    --data-binary "@$FILE"
done

# 8. Update Homebrew formula in whalesync/homebrew-scratch-cli
echo "Updating Homebrew formula..."
TAP_DIR=$(mktemp -d)
git clone "https://${GITHUB_TOKEN}@github.com/whalesync/homebrew-scratch-cli.git" "$TAP_DIR"

SHA_DARWIN_ARM64=$(sha_for "${BINARY}_darwin_arm64.tar.gz")
SHA_DARWIN_AMD64=$(sha_for "${BINARY}_darwin_amd64.tar.gz")
SHA_LINUX_AMD64=$(sha_for "${BINARY}_linux_amd64.tar.gz")
SHA_LINUX_ARM64=$(sha_for "${BINARY}_linux_arm64.tar.gz")
BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${NEW_VERSION}"

write_formula() {
  local file="$1"
  local class_name="$2"
  cat > "$file" <<RUBY
class ${class_name} < Formula
  desc "Scratch content management CLI"
  homepage "https://github.com/${GITHUB_REPO}"
  version "$MAJOR.$MINOR.$PATCH"

  on_macos do
    on_arm do
      url "${BASE_URL}/${BINARY}_darwin_arm64.tar.gz"
      sha256 "${SHA_DARWIN_ARM64}"
    end
    on_intel do
      url "${BASE_URL}/${BINARY}_darwin_amd64.tar.gz"
      sha256 "${SHA_DARWIN_AMD64}"
    end
  end

  on_linux do
    on_arm do
      url "${BASE_URL}/${BINARY}_linux_arm64.tar.gz"
      sha256 "${SHA_LINUX_ARM64}"
    end
    on_intel do
      url "${BASE_URL}/${BINARY}_linux_amd64.tar.gz"
      sha256 "${SHA_LINUX_AMD64}"
    end
  end

  def install
    bin.install "$BINARY"
  end

  test do
    system "#{bin}/$BINARY --version"
  end
end
RUBY
}

write_formula "$TAP_DIR/scratchmd.rb"                            "Scratchmd"
write_formula "$TAP_DIR/scratchmd@${MAJOR}.rb"                   "ScratchmdAT${MAJOR}"
write_formula "$TAP_DIR/scratchmd@${MAJOR}.${MINOR}.rb"          "ScratchmdAT${MAJOR}${MINOR}"
write_formula "$TAP_DIR/scratchmd@${MAJOR}.${MINOR}.${PATCH}.rb" "ScratchmdAT${MAJOR}${MINOR}${PATCH}"

(cd "$TAP_DIR" && \
  git add scratchmd.rb "scratchmd@${MAJOR}.rb" "scratchmd@${MAJOR}.${MINOR}.rb" "scratchmd@${MAJOR}.${MINOR}.${PATCH}.rb" && \
  git commit -m "scratchmd $NEW_VERSION" && \
  git push)
rm -rf "$TAP_DIR"

# 9. Update Scoop manifest in whalesync/scratch-cli-bucket
echo "Updating Scoop manifest..."
SHA_WINDOWS_AMD64=$(sha_for "${BINARY}_windows_amd64.zip")
BUCKET_DIR=$(mktemp -d)
git clone "https://${GITHUB_TOKEN}@github.com/whalesync/scratch-cli-bucket.git" "$BUCKET_DIR"

MANIFEST="$BUCKET_DIR/scratchmd.json"
cat > "$MANIFEST" <<JSON
{
  "version": "$MAJOR.$MINOR.$PATCH",
  "description": "Scratch content management CLI",
  "homepage": "https://github.com/${GITHUB_REPO}",
  "license": "Proprietary",
  "architecture": {
    "64bit": {
      "url": "${BASE_URL}/${BINARY}_windows_amd64.zip",
      "hash": "${SHA_WINDOWS_AMD64}",
      "bin": "${BINARY}.exe"
    }
  }
}
JSON

(cd "$BUCKET_DIR" && \
  git add scratchmd.json && \
  git commit -m "scratchmd $NEW_VERSION" && \
  git push)
rm -rf "$BUCKET_DIR"

# 10. Tag GitLab with cli-X.Y.Z to save state for next release
echo "Tagging GitLab with $CLI_TAG..."
git tag "$CLI_TAG"
git push "https://oauth2:${CICD_ACCESS_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" "$CLI_TAG"

echo "Release $NEW_VERSION complete."
