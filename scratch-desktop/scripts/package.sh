#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# No-op sentinel threaded from the hourly schedule's bootstrap: when nothing
# desktop-relevant changed since the last test release, every downstream job
# early-exits. RELEASE_SKIP is only ever set for the test variant.
if [ "${RELEASE_SKIP:-}" = "true" ]; then
  echo "RELEASE_SKIP=true — no changes since last test release. Skipping package."
  exit 0
fi

# Usage: ./scripts/package.sh <mac|linux>
#
# Thin wrapper around electron-builder. Reads SEMVER and VITE_* env vars from
# the environment (passed in via the bootstrap dotenv for SEMVER, and job
# variables for VITE_*). Produces release-ready files in ./dist-release/.
#
# The macOS invocation is expected to run on a shell runner that can sign the
# app; the Linux invocation runs on a shared Linux runner.

PLATFORM=${1:-}
if [[ "$PLATFORM" != "mac" && "$PLATFORM" != "linux" && "$PLATFORM" != "windows" ]]; then
  echo "Usage: $0 <mac|linux|windows>"
  exit 1
fi

if [ -z "$SEMVER" ]; then
  echo "ERROR: SEMVER is required (usually propagated via the bootstrap release.env dotenv)."
  exit 1
fi
if [ -z "$VITE_SCRATCH_API_URL" ] || [ -z "$VITE_SCRATCH_WEB_URL" ]; then
  echo "ERROR: VITE_SCRATCH_API_URL and VITE_SCRATCH_WEB_URL must be set."
  exit 1
fi
if [ -z "$UPDATE_CHANNEL" ]; then
  # Read by electron-builder via ${env.UPDATE_CHANNEL} in publish.channel; controls
  # the channel manifest filename (desktop-mac.yml vs desktop-test-mac.yml). Without
  # it, electron-builder falls back to "latest" and stable installs would pick up
  # CLI releases on the same repo.
  echo "ERROR: UPDATE_CHANNEL is required (e.g. 'desktop' or 'desktop-test')."
  exit 1
fi
export UPDATE_CHANNEL

# Test builds get a distinct app name so users can tell them apart from production.
if [ "$UPDATE_CHANNEL" = "desktop-test" ]; then
  PRODUCT_NAME_OVERRIDE=(-c.productName="Scratch (Test)")
else
  PRODUCT_NAME_OVERRIDE=()
fi

# Bootstrap ran on a different job/runner, so this workspace's package.json
# still has whatever version was committed. Sync it to the release version so
# electron-builder stamps artifacts with the correct filename.
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$SEMVER';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "package.json version set to $SEMVER"

echo "Installing dependencies..."
# Retry wrapper — the packaging jobs pull electron + electron-builder binaries
# from GitHub releases, the same fetches that flake in the other CI jobs.
bash ../scripts/ci/yarn-install-with-retry.sh --ignore-engines

echo "Building renderer + main + preload bundles..."
rm -rf ./dist
yarn build

# Fetch dugite-native git bundle for the target platform (DEV-10196).
# afterPack.cjs reads from scratch-desktop/.git-bundle/<target>/ and errors
# loudly if missing. Linux skips bundling — system git is the answer there.
if [ "$PLATFORM" = "mac" ]; then
  # Mac runners are arm64; add darwin-x64 here if we add an Intel build target.
  node scripts/download-git.cjs darwin-arm64
elif [ "$PLATFORM" = "windows" ]; then
  node scripts/download-git.cjs win32-x64
fi

if [ "$PLATFORM" = "mac" ]; then
  # Defaults match the existing local-macos job (dmg + zip).
  MAC_TARGETS="${MAC_TARGETS:-dmg zip}"
  echo "Packaging macOS targets ($MAC_TARGETS)..."
  # shellcheck disable=SC2086  # intentional word splitting for multiple targets
  yarn electron-builder --mac $MAC_TARGETS "${PRODUCT_NAME_OVERRIDE[@]}" --publish never
elif [ "$PLATFORM" = "windows" ]; then
  # Ship the Windows NSIS installer UNSIGNED on purpose (DEV-11010 / Oneleet SCR-015).
  # electron-builder resolves the Windows cert as WIN_CSC_LINK and *falls back to the
  # cross-platform CSC_LINK*, which in our pipeline holds the Apple Developer ID .p12 (the mac
  # signing cert). If that leaks in, the .exe is Authenticode-signed with a cert whose chain is
  # untrusted on Windows; app-builder-lib then bakes the Apple CN into app-update.yml as the
  # expected publisherName and electron-updater rejects every update with
  # ERR_UPDATER_INVALID_SIGNATURE — Windows auto-update dies. So strip every *CSC* var here: no
  # ambient cert can sign this build, and a genuinely-unsigned build writes no publisherName, so
  # electron-updater skips signature verification and auto-update works. Real Authenticode signing
  # is tracked in docs/plans/2026-05-30-sign-windows-desktop-builds/. Requires wine because
  # electron-builder runs the NSIS compiler under wine when cross-building from Linux.
  echo "Packaging Windows x64 targets (unsigned)..."
  env -u CSC_LINK -u CSC_KEY_PASSWORD -u WIN_CSC_LINK -u WIN_CSC_KEY_PASSWORD \
    yarn electron-builder --win --x64 "${PRODUCT_NAME_OVERRIDE[@]}" --publish never
else
  echo "Packaging Linux x64 targets..."
  yarn electron-builder --linux --x64 "${PRODUCT_NAME_OVERRIDE[@]}" --publish never
fi

# Hard gate on the packaged binary's Electron fuse wire (DEV-11000 / Oneleet SCR-005).
# The vitest spec only proves electron-builder.yml *declares* the hardened fuses; this
# proves the artifact we are about to publish actually has them. Runs before artifacts
# are collected so an unhardened build never reaches dist-release/ or the GitHub release.
echo "Verifying Electron fuses on the packaged binary..."
node scripts/verify-fuses.cjs "$PLATFORM"

# Hard gate on the packaged binary's REAL macOS entitlements (DEV-10999 / Oneleet SCR-004).
# The vitest spec only proves the plists DECLARE a safe set; this proves the signed .app we are
# about to publish doesn't carry disable-library-validation / allow-dyld-environment-variables (the
# dylib-injection entitlements). mac-only — entitlements don't apply to linux/windows builds.
if [ "$PLATFORM" = "mac" ]; then
  echo "Verifying macOS entitlements on the signed app bundle..."
  node scripts/verify-entitlements.cjs
fi

# Hard gate that the Windows installer + app ship UNSIGNED (DEV-11010 / Oneleet SCR-015).
# The vitest spec only proves the PE parser works; this proves the real artifacts we are about to
# publish carry no Authenticode signature, so a leaked Apple CSC_LINK can never regress Windows
# auto-update again. windows-only — the other platforms don't run signtool.
if [ "$PLATFORM" = "windows" ]; then
  echo "Verifying the Windows executables are unsigned (no cert leaked in)..."
  node scripts/verify-windows-unsigned.cjs
fi

# Collect release-ready files into dist-release/ so the downstream upload job
# has a single, predictable directory to pull into its workspace.
DIST_DIR="./dist-release"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
echo "Collecting artifacts into $DIST_DIR..."
# Installers/archives + electron-updater metadata (channel manifest + delta blockmaps).
for FILE in dist/*.dmg dist/*.zip dist/*.AppImage dist/*.deb dist/*.exe dist/*.yml dist/*.blockmap; do
  [ -f "$FILE" ] || continue
  FNAME=$(basename "$FILE")
  cp "$FILE" "$DIST_DIR/$FNAME"
  echo "  $FNAME"
done

ARTIFACT_COUNT=$(find "$DIST_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')
if [ "$ARTIFACT_COUNT" -eq 0 ]; then
  echo "ERROR: No build artifacts found in $DIST_DIR. Aborting."
  exit 1
fi
echo "Collected $ARTIFACT_COUNT artifact(s)"
