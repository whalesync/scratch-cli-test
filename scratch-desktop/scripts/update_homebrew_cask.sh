#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/update_homebrew_cask.sh
#
# Prod-only. Runs after finalize_release.sh has flipped the GitHub release to
# public. Computes sha256 for the macOS arm64 .zip asset (the cask formula
# currently points at .zip, not .dmg — see plan), rewrites the cask formulae
# in whalesync/homebrew-scratch-desktop, and pushes.
#
# Only arm64 is built (see electron-builder.yml mac target); the cask declares
# `depends_on arch: :arm64` so Intel installs fail cleanly instead of pulling
# an arm64 binary.
#
# Required env (normally from bootstrap dotenv):
#   SEMVER, NEW_VERSION
# Required secret:
#   GITHUB_TOKEN (must have push access to whalesync/homebrew-scratch-desktop)

if [ -z "$SEMVER" ] || [ -z "$NEW_VERSION" ]; then
  echo "ERROR: SEMVER and NEW_VERSION must be set (see bootstrap release.env)."
  exit 1
fi
if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN is required."
  exit 1
fi

GITHUB_REPO="whalesync/scratch-desktop"
TAP_REPO="whalesync/homebrew-scratch-desktop"
BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${NEW_VERSION}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$SEMVER"

ARM64_ZIP_NAME="Scratch-${SEMVER}-arm64.zip"

# Release is public at this point, so we can check/download with plain curl.
WORK_DIR=$(mktemp -d)
TAP_PARENT=$(mktemp -d)
TAP_DIR="$TAP_PARENT/homebrew-scratch-desktop"
trap 'rm -rf "$WORK_DIR" "$TAP_PARENT"' EXIT

# The mac Package/Upload jobs are optional in the pipeline — if the user
# who cut this release doesn't have a local-macos runner, the .zip asset
# won't exist. In that case, skip the cask update rather than failing
# Finalize: the previous cask version remains pinned to the last release
# that shipped mac artifacts.
arm64_status=$(curl -sSI -o /dev/null -w "%{http_code}" -L "${BASE_URL}/${ARM64_ZIP_NAME}")
if [ "$arm64_status" != "200" ]; then
  echo "macOS arm64 zip not present on release $NEW_VERSION"
  echo "  arm64 ($ARM64_ZIP_NAME): HTTP $arm64_status"
  echo "Skipping Homebrew cask update (no mac artifact to pin)."
  exit 0
fi

echo "Downloading macOS arm64 zip for checksumming..."
curl -sSL --fail-with-body "${BASE_URL}/${ARM64_ZIP_NAME}" -o "$WORK_DIR/arm64.zip"

SHA_DARWIN_ARM64=$(shasum -a 256 "$WORK_DIR/arm64.zip" | awk '{print $1}')

echo "  arm64: $SHA_DARWIN_ARM64"

echo "Cloning ${TAP_REPO}..."
git clone "https://${GITHUB_TOKEN}@github.com/${TAP_REPO}.git" "$TAP_DIR"

git -C "$TAP_DIR" config user.email "ci@whalesync.com"
git -C "$TAP_DIR" config user.name "GitLab CI"

mkdir -p "$TAP_DIR/Casks"
cat > "$TAP_DIR/Casks/scratch-desktop.rb" <<RUBY
cask "scratch-desktop" do
  version "$SEMVER"
  sha256 "${SHA_DARWIN_ARM64}"

  url "${BASE_URL}/${ARM64_ZIP_NAME}"
  name "Scratch Desktop"
  desc "Scratch content management desktop app"
  homepage "https://github.com/${GITHUB_REPO}"

  depends_on arch: :arm64

  app "Scratch Desktop.app"

  zap trash: [
    "~/Library/Application Support/Scratch Desktop",
    "~/Library/Preferences/com.scratch.desktop.plist",
    "~/Library/Caches/com.scratch.desktop",
  ]
end
RUBY

# Versioned cask variants (scratch-desktop@1, scratch-desktop@1.2, scratch-desktop@1.2.3)
for VARIANT in \
  "scratch-desktop@${MAJOR}" \
  "scratch-desktop@${MAJOR}.${MINOR}" \
  "scratch-desktop@${MAJOR}.${MINOR}.${PATCH}"; do
  CASK_FILE="$TAP_DIR/Casks/${VARIANT}.rb"
  cp "$TAP_DIR/Casks/scratch-desktop.rb" "$CASK_FILE"
  # Use a temp file for portability (BSD sed -i requires an extension arg; GNU sed -i does not).
  sed "s/cask \"scratch-desktop\"/cask \"${VARIANT}\"/" "$CASK_FILE" > "$CASK_FILE.tmp" \
    && mv "$CASK_FILE.tmp" "$CASK_FILE"
done

git -C "$TAP_DIR" add Casks/scratch-desktop*.rb

if git -C "$TAP_DIR" diff --staged --quiet; then
  echo "Homebrew cask already up to date for $NEW_VERSION — nothing to push."
else
  git -C "$TAP_DIR" commit -m "Scratch Desktop $NEW_VERSION"
  git -C "$TAP_DIR" push
  echo "✓ Pushed Homebrew cask update for $NEW_VERSION"
fi
