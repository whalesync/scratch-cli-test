#!/usr/bin/env bash
# Build the scratchmd-native cdylib and drop the platform-named `.node` next
# to `scratch-git-2/napi/Cargo.toml`. The Electron main-process loader at
# `src/main/native/scratchmd-native.ts` resolves to that path in dev mode;
# in packaged builds, electron-builder's `extraResources` glob copies the
# `.node` into `Resources/bin/`.
#
# Slice H.2 of DEV-10144. See `docs/plans/2026-05-20-slice-h-spec.md`.
#
# Usage:
#   scripts/build-native.sh           # release build (default — recommended for dev too;
#                                     # napi build time is dominated by the scratch-git-2 lib)
#   scripts/build-native.sh debug     # debug profile (faster compile, larger .node)

set -euo pipefail

# cd to the scratch-desktop directory regardless of where the script is invoked.
cd "$(dirname "$0")/.."

PROFILE="${1:-release}"
if [[ "$PROFILE" != "release" && "$PROFILE" != "debug" ]]; then
  echo "Usage: $0 [release|debug]" >&2
  exit 1
fi

NAPI_DIR="../scratch-git-2/napi"
if [[ ! -d "$NAPI_DIR" ]]; then
  echo "ERROR: $NAPI_DIR not found. Run from a repo with scratch-git-2/napi." >&2
  exit 1
fi

# Skip gracefully when there's no Rust toolchain available. This lets the
# JS-only desktop CI image (lint + bundler) run `yarn build` without needing
# Rust; the packaged-build CI image (where cargo is installed alongside the
# existing scratchmd binary build) still produces a fresh .node. Slice H.2 of
# DEV-10144 — see `docs/plans/2026-05-20-slice-h-spec.md`.
if ! command -v cargo >/dev/null 2>&1; then
  echo "WARN: cargo not on PATH; skipping scratchmd-native build."
  echo "      This is expected on the JS-only desktop CI image. Packaged"
  echo "      builds need the .node — make sure cargo is installed there."
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TRIPLE_SUFFIX="darwin-arm64" ;;
  Darwin-x86_64) TRIPLE_SUFFIX="darwin-x64" ;;
  Linux-x86_64) TRIPLE_SUFFIX="linux-x64-gnu" ;;
  *)
    echo "ERROR: unsupported host $(uname -s)-$(uname -m) for napi build" >&2
    exit 1
    ;;
esac

OUT_NODE="$NAPI_DIR/scratchmd-native.${TRIPLE_SUFFIX}.node"

# Build the cdylib. We invoke cargo directly (not @napi-rs/cli) because the
# napi CLI's workspace handling in our setup proved fiddly; cargo's `-p`
# selection works cleanly. The renaming-to-.node step is what napi-rs's CLI
# would otherwise do for us.
echo "Building scratchmd-native ($PROFILE)…"
CARGO_FLAGS=()
TARGET_DIR_NAME="$PROFILE"
if [[ "$PROFILE" == "release" ]]; then
  CARGO_FLAGS+=("--release")
fi

(
  cd ../scratch-git-2
  cargo build -p scratchmd-native "${CARGO_FLAGS[@]}"
)

DYLIB_PATH=""
case "$(uname -s)" in
  Darwin) DYLIB_PATH="../scratch-git-2/target/$TARGET_DIR_NAME/libscratchmd_native.dylib" ;;
  Linux) DYLIB_PATH="../scratch-git-2/target/$TARGET_DIR_NAME/libscratchmd_native.so" ;;
esac

if [[ ! -f "$DYLIB_PATH" ]]; then
  echo "ERROR: expected cargo output at $DYLIB_PATH but it doesn't exist." >&2
  exit 1
fi

cp "$DYLIB_PATH" "$OUT_NODE"
echo "Wrote $OUT_NODE ($(du -h "$OUT_NODE" | cut -f1))"

# On macOS, dyld validation kills any process that tries to `dlopen` a
# .node whose on-disk signature doesn't match what it had at first load —
# which fires every time we rebuild during dev. An ad-hoc sign clears the
# signature cache so subsequent `require(...)` calls work. Cheap enough to
# do on every build; release builds get re-signed during electron-builder's
# notarization step anyway.
if [[ "$(uname -s)" == "Darwin" ]] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$OUT_NODE" >/dev/null 2>&1 || \
    echo "WARN: ad-hoc codesign of $OUT_NODE failed; dlopen may SIGKILL on macOS"
fi
