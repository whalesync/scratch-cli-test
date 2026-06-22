#!/usr/bin/env bash
# Verify the code-signing + notarization of a packaged macOS Scratch.app, with
# special attention to the bundled git tree under Contents/Resources/git.
#
# Background (DEV-10319): we bundle dugite-native's git into the app
# (Contents/Resources/git). bin/git, libexec/git-core/git and
# libexec/git-core/createdump are real Mach-O binaries; the ~190 git-* helpers
# are symlinks back to "git". Because the mac build uses hardened runtime +
# notarization, every nested Mach-O must be deep-signed with the runtime flag,
# or Gatekeeper can kill the bundled git at runtime on an end user's machine.
# The Rust git wrapper (scratch-git-2/src/shared/git_exec.rs) does NOT fall back
# to /usr/bin/git, so such a failure surfaces as a hard git error rather than a
# fallback. This script checks for that regression.
#
# Usage (from anywhere):
#   scripts/verify-mac-release.sh                 # defaults to /Applications/Scratch.app
#   scripts/verify-mac-release.sh /path/to/Scratch.app
#   scripts/verify-mac-release.sh "/Volumes/Scratch X.Y.Z/Scratch.app"
#
# Validate a REAL signed + notarized release artifact (a downloaded release DMG,
# or the .app built by `yarn build:mac`). A local dev/unsigned build
# (`yarn build:mac:unsigned`) is ad-hoc signed and will legitimately fail the
# notarization/Gatekeeper checks below.
#
# Exit code is non-zero if any check fails, so this is also usable as a CI
# post-build assertion gate.

set -uo pipefail

APP="${1:-/Applications/Scratch.app}"

if [ ! -d "$APP" ]; then
  echo "Error: '$APP' not found or is not a directory" >&2
  echo "Usage: $0 [path-to-Scratch.app]" >&2
  exit 1
fi

GIT="$APP/Contents/Resources/git"

# Track the overall result without aborting on the first failure, so a single
# run surfaces every problem at once.
FAILURES=0
section() { printf '\n========== %s ==========\n' "$1"; }
# Run a check; on non-zero exit, record a failure but keep going.
check() {
  local label="$1"; shift
  echo "--- $label ---"
  if "$@"; then
    echo "  -> OK"
  else
    echo "  -> FAIL ($label)" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

echo "Verifying: $APP"

# ---------------------------------------------------------------------------
# 1. The app bundle itself
# ---------------------------------------------------------------------------
section "App bundle"

# Print the app's own signature details (authority chain, identifier, etc.).
echo "--- codesign info (app) ---"
codesign -dv --verbose=4 "$APP" 2>&1 || true

# Deep, strict verification of the whole bundle and everything nested in it.
# This recurses into Contents/Resources/git, so it is the broadest single check.
check "codesign --verify --deep --strict (app)" \
  codesign --verify --deep --strict --verbose=2 "$APP"

# Gatekeeper assessment: confirms the app is accepted as a notarized Developer ID
# app, i.e. it would actually launch on a clean end-user machine.
#
# NOTE: spctl --assess is intentionally run ONLY against the app bundle, never
# against the nested git binaries. spctl --type execute assesses APP BUNDLES;
# pointing it at a bare executable like Resources/git/bin/git returns
# "rejected (the code is valid but does not seem to be an app)" -- that is spctl
# refusing to judge a non-app, NOT a signing problem ("the code is valid" means
# the signature is fine). Notarization/Gatekeeper trust applies at the bundle
# level and nested binaries are covered by the app's stapled ticket, so they are
# verified below with `codesign --verify` + the hardened-runtime flag instead.
check "spctl --assess (app)" \
  spctl --assess --type execute --verbose=4 "$APP"

# Confirm the notarization ticket is stapled to the app (works offline).
check "stapler validate (app)" \
  xcrun stapler validate -v "$APP"

# ---------------------------------------------------------------------------
# 2. Bundled git tree presence
# ---------------------------------------------------------------------------
section "Bundled git tree"

if [ ! -d "$GIT" ]; then
  echo "Error: bundled git tree not found at '$GIT'" >&2
  echo "(Expected Contents/Resources/git from afterPack.cjs.)" >&2
  exit 1
fi
echo "Found bundled git tree at: $GIT"

# Spot-check that the git-* helpers are symlinks back to the real "git" binary
# (so they inherit its signature rather than needing their own).
echo "--- libexec/git-core symlink targets (should be just 'git') ---"
find "$GIT/libexec/git-core" -type l -name 'git-*' -exec readlink {} \; 2>/dev/null | sort -u

# ---------------------------------------------------------------------------
# 3. Key real Mach-O binaries in the git tree
# ---------------------------------------------------------------------------
section "Key git binaries"

for bin in "bin/git" "libexec/git-core/git" "libexec/git-core/createdump"; do
  target="$GIT/$bin"
  [ -f "$target" ] || { echo "--- $bin: not present, skipping ---"; continue; }

  # Strict signature verification of this individual binary.
  check "codesign --verify ($bin)" \
    codesign --verify --strict --verbose=2 "$target"

  # The signing flags MUST include "runtime" (hardened runtime). Without it,
  # Gatekeeper can kill the binary even if it is otherwise signed.
  echo "--- hardened runtime flag ($bin) ---"
  if codesign -d --verbose=2 "$target" 2>&1 | grep -i 'flags=' | grep -qi 'runtime'; then
    echo "  -> OK (runtime present)"
  else
    echo "  -> FAIL (hardened runtime flag missing on $bin)" >&2
    codesign -d --verbose=2 "$target" 2>&1 | grep -i 'flags=' || true
    FAILURES=$((FAILURES + 1))
  fi
done

# Show the entitlements carried by bin/git for manual inspection.
echo "--- entitlements (bin/git) ---"
codesign -d --entitlements - --xml "$GIT/bin/git" 2>&1 || true

# ---------------------------------------------------------------------------
# 4. Full sweep: every nested Mach-O in the git tree
# ---------------------------------------------------------------------------
# The real regression test. Find every actual Mach-O file (skipping symlinks and
# shell scripts), then assert each one is signed AND carries the runtime flag.
# Any FAIL line, or any binary missing "runtime", is the DEV-10319 regression.
section "Full Mach-O sweep (Contents/Resources/git)"

SWEEP_FAILURES=$(find -H "$GIT" -type f -print0 | while IFS= read -r -d '' f; do
  file "$f" 2>/dev/null | grep -q "Mach-O" || continue
  flags=$(codesign -d --verbose=2 "$f" 2>&1 | sed -n 's/^.*flags=//p' | head -1)
  if codesign --verify --strict "$f" 2>/dev/null; then
    if printf '%s' "$flags" | grep -qi 'runtime'; then
      echo "OK    [$flags]  $f"
    else
      echo "FAIL  [no runtime] [$flags]  $f" >&2
      echo "x"  # marker counted below
    fi
  else
    echo "FAIL  [unsigned/invalid] [$flags]  $f" >&2
    echo "x"  # marker counted below
  fi
done | grep -c '^x' || true)

# The loop above runs in a subshell (pipe), so it can't mutate FAILURES directly;
# fold its failure count back in here.
if [ "${SWEEP_FAILURES:-0}" -gt 0 ]; then
  FAILURES=$((FAILURES + SWEEP_FAILURES))
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
section "Result"
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS: all code-signing / notarization checks succeeded."
  exit 0
else
  echo "FAIL: $FAILURES check(s) failed. See messages above." >&2
  exit 1
fi
