#!/usr/bin/env bash
# Local macOS (arm64) desktop build: compile scratchmd for Apple Silicon, place it where
# electron-builder afterPack expects it, then package the Electron app.
#
# Usage (from scratch-desktop/):
#   yarn build:mac:local
#
# Uses yarn build:mac:unsigned (ad-hoc sign, not notarized). For Developer ID + notarization
# use yarn build:mac with CSC_* and APPLE_* env — see electron-builder.yml.
#
# Prerequisites: Rust toolchain, cargo-zigbuild, and Zig (same as CI scratch-git-2 builds).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH_DESKTOP="$REPO_ROOT/scratch-desktop"
SCRATCH_GIT_2="$REPO_ROOT/scratch-git-2"

RUST_TARGET="aarch64-apple-darwin"

echo "==> Building scratchmd ($RUST_TARGET) in scratch-git-2"
cd "$SCRATCH_GIT_2"
# Optional; matches .gitlab-ci-release.yml for embed-time defaults
export SCRATCH_DEFAULT_URL="${SCRATCH_DEFAULT_URL:-}"
cargo zigbuild --release --bin scratchmd --target "$RUST_TARGET"
mkdir -p "cli-binaries/$RUST_TARGET"
cp "target/$RUST_TARGET/release/scratchmd" "cli-binaries/$RUST_TARGET/scratchmd"
echo "==> CLI binary: $SCRATCH_GIT_2/cli-binaries/$RUST_TARGET/scratchmd"

echo "==> Building Scratch.app (electron-vite + electron-builder --mac, ad-hoc / unsigned)"
cd "$SCRATCH_DESKTOP"
yarn build:mac:unsigned
