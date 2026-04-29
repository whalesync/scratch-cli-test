#!/usr/bin/env bash
# Load signing + notarization credentials from a local file, then run a full
# Developer ID + notarized mac build (yarn build:mac).
#
# Usage (from anywhere):
#   scratch-desktop/scripts/build_mac_local_signed.sh
# Or from scratch-desktop/:
#   yarn build:mac:local-signed
#
# Default env file: scratch-desktop/.env.notarize-test
# Override: ENV_FILE=/path/to/file.sh ... build_mac_local_signed.sh
#
# Required in that file (KEY=value per line, # comments allowed):
#   CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#
# After a successful build, runs codesign verify + TeamIdentifier check vs APPLE_TEAM_ID.

set -euo pipefail

# productName in electron-builder.yml is "Scratch"; output dir is dist/mac-arm64 for arm64.
verify_signed_app() {
  local app root
  root="$SCRATCH_DESKTOP/dist/mac-arm64"
  app="$root/Scratch.app"
  if [[ ! -d "$app" ]]; then
    local -a found
    shopt -s nullglob
    found=( "$root"/*.app )
    shopt -u nullglob
    if ((${#found[@]} == 1)) && [[ -d "${found[0]}" ]]; then
      app="${found[0]}"
    else
      echo "ERROR: Expected $app (or exactly one $root/*.app) after build." >&2
      return 1
    fi
  fi

  echo "==> codesign verify: $app"
  if ! codesign --verify --deep --strict "$app"; then
    echo "ERROR: codesign --verify --deep --strict failed" >&2
    return 1
  fi

  local found_team
  found_team=$(codesign -dvv "$app" 2>&1 | grep -E '^TeamIdentifier=' | head -1 | cut -d= -f2-)
  if [[ -z "$found_team" ]]; then
    echo "ERROR: Could not read TeamIdentifier (codesign -dvv $app)" >&2
    return 1
  fi
  if [[ "$found_team" != "$APPLE_TEAM_ID" ]]; then
    echo "ERROR: TeamIdentifier mismatch: expected '$APPLE_TEAM_ID' (from .env), got '$found_team'" >&2
    return 1
  fi
  if ! codesign -dvv "$app" 2>&1 | grep -qF 'Authority=Developer ID Application:'; then
    echo "ERROR: No Developer ID Application authority on signature (ad-hoc or wrong cert?)" >&2
    return 1
  fi
  echo "==> codesign check OK: TeamIdentifier=$found_team, Developer ID Application"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SCRATCH_DESKTOP="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$SCRATCH_DESKTOP/.env.notarize-test}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Env file not found: $ENV_FILE" >&2
  echo "Create it with the variables listed in scripts/build_mac_local_signed.sh" >&2
  exit 1
fi

# Export every assignment in the file so yarn/electron-builder inherit them.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# If set (e.g. from a previous unsigned build), this forces ad-hoc signing and breaks notarization.
unset CSC_IDENTITY

# app-builder only auto-picks a cert from the imported keychain when this is not false. Some .env
# or shells set "false" and you get: findIdentity() never runs → "falling back to ad-hoc…".
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
  # Bash 3.2–safe (no ${!name}); values may be long (base64 p12).
  val=
  eval "val=\${$v-}"
  if [[ -z "$val" ]]; then
    missing+=("$v")
  fi
done
if ((${#missing[@]} > 0)); then
  echo "ERROR: Missing or empty after sourcing $ENV_FILE: ${missing[*]}" >&2
  exit 1
fi

# Strip Windows CRLF and leading/trailing whitespace (common in pasted .env / 1Password exports).
_crlf_strip() { printf '%s' "$1" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }
CSC_LINK="$(_crlf_strip "$CSC_LINK")"
CSC_KEY_PASSWORD="$(_crlf_strip "$CSC_KEY_PASSWORD")"
APPLE_ID="$(_crlf_strip "$APPLE_ID")"
APPLE_APP_SPECIFIC_PASSWORD="$(_crlf_strip "$APPLE_APP_SPECIFIC_PASSWORD")"
APPLE_TEAM_ID="$(_crlf_strip "$APPLE_TEAM_ID")"
export CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
unset -f _crlf_strip

# materialize a real .p12 on disk; see scripts/resolve-csc-p12.cjs
_CSC_RESOLVED=$(
  cd "$SCRATCH_DESKTOP" && node "$SCRATCH_DESKTOP/scripts/resolve-csc-p12.cjs" | tr -d '\n\r'
) || exit 1
CSC_LINK="$_CSC_RESOLVED"
export CSC_LINK
# Remove decoded temp p12 on exit
if [[ "$CSC_LINK" == *'/scratch-csc-'*".p12" ]]; then
  _CSC_TMP_P12="$CSC_LINK"
  trap '[[ -n "${_CSC_TMP_P12:-}" ]] && rm -f "$_CSC_TMP_P12" 2>/dev/null' EXIT
fi
unset -v _CSC_RESOLVED

export UPDATE_CHANNEL="${UPDATE_CHANNEL:-desktop-test}"

cd "$SCRATCH_DESKTOP"
echo "==> mac build (signed + notarized), env from: $ENV_FILE"
echo "  CSC_LINK: $CSC_LINK"
# Fail fast with a clear error if the shell env is not what Node will read (should match).
node -e "const u=process.env.CSC_LINK, p=process.env.CSC_KEY_PASSWORD; if(!u||!p) process.exit(1)" || {
  echo "ERROR: CSC_LINK or CSC_KEY_PASSWORD not visible in Node. Check exports before yarn." >&2
  exit 1
}

if ! yarn build:mac; then
  exit 1
fi
verify_signed_app
