#!/usr/bin/env bash
# Ad-hoc local "production" desktop build: prod API URLs, UPDATE_CHANNEL=desktop,
# same path as GitLab (scripts/package.sh mac) — for testing before/without a full release.
#
# Usage (from anywhere):
#   ./scratch-desktop/scripts/build_mac_prod_local.sh [SEMVER]
# Or (from scratch-desktop/):
#   yarn build:mac:prod-local -- 1.2.3
#
# Env:
#   ENV_FILE — defaults to scratch-desktop/.env.signing-credentials (CSC_*, APPLE_*; see build_mac_local_signed.sh)
#   SEMVER   — if not passed as $1, taken from this env or from package.json
#   BUILD_SCRATCHMD — default 1: cargo zigbuild scratchmd + scratchmd-native in scratch-git-2; set 0 to skip if cli-binaries (CLI + .node) is ready
#   SCRATCH_DEFAULT_URL — passed to scratchmd build; default https://api.scratch.md (CI prod)
#
# Output: dist-release/ like the Package prod macOS job.
#
# Prerequisites: Same as build_mac_local.sh (Rust, cargo-zigbuild, Zig) if BUILD_SCRATCHMD=1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRATCH_DESKTOP="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH_GIT_2="$REPO_ROOT/scratch-git-2"
ENV_FILE="${ENV_FILE:-$SCRATCH_DESKTOP/.env.signing-credentials}"
RUST_TARGET="aarch64-apple-darwin"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Env file not found: $ENV_FILE" >&2
  echo "Create it with CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

unset CSC_IDENTITY
export CSC_IDENTITY_AUTO_DISCOVERY=true

required_vars=(
  CSC_LINK
  CSC_KEY_PASSWORD
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
)
missing=()
for v in "${required_vars[@]}"; do
  val=
  eval "val=\${$v-}"
  if [[ -z "$val" ]]; then
    missing+=("$v")
  fi
done
if ((${#missing[@]} > 0)); then
  echo "ERROR: Missing or empty in $ENV_FILE: ${missing[*]}" >&2
  exit 1
fi

_crlf_strip() { printf '%s' "$1" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
CSC_LINK="$(_crlf_strip "$CSC_LINK")"
CSC_KEY_PASSWORD="$(_crlf_strip "$CSC_KEY_PASSWORD")"
APPLE_ID="$(_crlf_strip "$APPLE_ID")"
APPLE_APP_SPECIFIC_PASSWORD="$(_crlf_strip "$APPLE_APP_SPECIFIC_PASSWORD")"
APPLE_TEAM_ID="$(_crlf_strip "$APPLE_TEAM_ID")"
export CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
unset -f _crlf_strip

_CSC_RESOLVED=$(
  cd "$SCRATCH_DESKTOP" && node "$SCRATCH_DESKTOP/scripts/resolve-csc-p12.cjs" | tr -d '\n\r'
) || exit 1
CSC_LINK="$_CSC_RESOLVED"
export CSC_LINK
if [[ "$CSC_LINK" == *'/scratch-csc-'*".p12" ]]; then
  _CSC_TMP_P12="$CSC_LINK"
  trap '[[ -n "${_CSC_TMP_P12:-}" ]] && rm -f "$_CSC_TMP_P12" 2>/dev/null' EXIT
fi
unset -v _CSC_RESOLVED

# Prod (Package prod macOS in CI). Always these for this script — not dev .env.
export VITE_SCRATCH_API_URL="https://api.scratch.md"
export VITE_SCRATCH_WEB_URL="https://app.scratch.md"
export UPDATE_CHANNEL=desktop
export SEMVER="${1:-${SEMVER:-}}"

if [[ -z "$SEMVER" ]]; then
  SEMVER=$(cd "$SCRATCH_DESKTOP" && node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null | tr -d '\n\r' || true)
  if [[ -z "$SEMVER" ]]; then
    echo "ERROR: Pass SEMVER as first arg or set env SEMVER (e.g. $0 0.1.0)" >&2
    exit 1
  fi
  echo "==> Using SEMVER from package.json: $SEMVER" >&2
else
  echo "==> SEMVER=$SEMVER" >&2
fi
export SEMVER

CLI_BIN="$SCRATCH_GIT_2/cli-binaries/$RUST_TARGET/scratchmd"
NATIVE_NODE="$SCRATCH_GIT_2/cli-binaries/$RUST_TARGET/scratchmd-native.darwin-arm64.node"
if [[ ! -f "$CLI_BIN" ]] || [[ ! -f "$NATIVE_NODE" ]] || [[ "${BUILD_SCRATCHMD:-1}" == "1" ]]; then
  echo "==> Building scratchmd ($RUST_TARGET) in scratch-git-2 (SCRATCH_DEFAULT_URL=${SCRATCH_DEFAULT_URL:-https://api.scratch.md})"
  cd "$SCRATCH_GIT_2"
  export SCRATCH_DEFAULT_URL="${SCRATCH_DEFAULT_URL:-https://api.scratch.md}"
  cargo zigbuild --release --bin scratchmd --target "$RUST_TARGET"
  # scratchmd-native cdylib (slice H of DEV-10144). afterPack.cjs copies the
  # .node from cli-binaries/<triple>/ into the packaged .app's Resources/bin/.
  cargo zigbuild --release -p scratchmd-native --target "$RUST_TARGET"
  mkdir -p "cli-binaries/$RUST_TARGET"
  cp "target/$RUST_TARGET/release/scratchmd" "cli-binaries/$RUST_TARGET/scratchmd"
  cp "target/$RUST_TARGET/release/libscratchmd_native.dylib" "$NATIVE_NODE"
  echo "==> CLI: $CLI_BIN"
  echo "==> napi: $NATIVE_NODE"
else
  echo "==> Using existing CLI (BUILD_SCRATCHMD=0): $CLI_BIN" >&2
  echo "==> Using existing napi (BUILD_SCRATCHMD=0): $NATIVE_NODE" >&2
  if [[ ! -f "$CLI_BIN" ]]; then
    echo "ERROR: Missing $CLI_BIN — run without BUILD_SCRATCHMD=0 or run the scratchmd build first." >&2
    exit 1
  fi
  if [[ ! -f "$NATIVE_NODE" ]]; then
    echo "ERROR: Missing $NATIVE_NODE — run without BUILD_SCRATCHMD=0 or run the scratchmd build first." >&2
    exit 1
  fi
fi

cd "$SCRATCH_DESKTOP"
if ! node -e "if(!process.env.CSC_LINK||!process.env.CSC_KEY_PASSWORD) process.exit(1)"; then
  echo "ERROR: CSC not visible in Node" >&2
  exit 1
fi

echo "==> package.sh mac (prod: api.scratch.md, channel=desktop) → dist-release/"
./scripts/package.sh mac

echo ""
echo "==> Done. Artifacts under: $SCRATCH_DESKTOP/dist-release/"
echo "To verify the signature of the application, unzip the build file in ./dist-release and run:"
echo ""
echo "  codesign -dv --verbose=4 ./dist-release/Scratch.app 2>&1"
echo ""
