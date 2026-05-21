/**
 * electron-builder afterPack hook.
 *
 * Copies the architecture-specific scratchmd CLI binary AND the
 * scratchmd-native cdylib (slice H of DEV-10144) into the packaged app's
 * resources/bin/ directory so the desktop ships with both bundled and never
 * falls back to a system-installed binary or a stale dev-machine .node.
 *
 * Expected source layout (populated by CI .build_cli_for_desktop or by the
 * local build_mac_*.sh scripts):
 *   scratch-git-2/cli-binaries/<rust-target>/scratchmd
 *   scratch-git-2/cli-binaries/<rust-target>/scratchmd-native.<platform>-<arch>[-<abi>].node
 *
 * Windows napi is not built yet (slice H.4 scoped to mac+linux); on win32
 * the .node copy is skipped with a warning, matching pre-H behavior where
 * Windows users would hit "binary not found" at cell-edit time. Tracked as a
 * separate follow-up.
 */

const fs = require('fs');
const path = require('path');

// electron-builder Arch enum: 0 = ia32, 1 = x64, 2 = armv7l, 3 = arm64, 4 = universal
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

const TARGET_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-gnu',
};

// Filename of the napi cdylib as the desktop's loader expects it
// (scratch-desktop/src/main/native/scratchmd-native.ts::nativeBinaryFilename).
// Returns null when napi isn't supported on this platform yet.
function nativeFilenameFor(platform, arch) {
  if (platform === 'darwin') return `scratchmd-native.darwin-${arch}.node`;
  if (platform === 'linux' && arch === 'x64') return `scratchmd-native.linux-x64-gnu.node`;
  return null;
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin', 'linux', 'win32'
  const arch = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${arch}`;
  const rustTarget = TARGET_MAP[key];

  if (!rustTarget) {
    throw new Error(`afterPack: no CLI binary mapping for platform/arch "${key}"`);
  }

  const cliBinariesDir = path.resolve(__dirname, '..', '..', 'scratch-git-2', 'cli-binaries', rustTarget);
  const binaryName = platform === 'win32' ? 'scratchmd.exe' : 'scratchmd';
  const srcBinary = path.join(cliBinariesDir, binaryName);

  if (!fs.existsSync(srcBinary)) {
    throw new Error(
      `afterPack: CLI binary not found at ${srcBinary}.\n` +
        'In CI this is provided by the build-cli-for-desktop job artifacts.\n' +
        'For local builds, run:\n' +
        `  cd scratch-git-2 && cargo zigbuild --release --bin scratchmd --target ${rustTarget}\n` +
        `  mkdir -p cli-binaries/${rustTarget}\n` +
        `  cp target/${rustTarget}/release/scratchmd cli-binaries/${rustTarget}/scratchmd`,
    );
  }

  // electron-builder's afterPack context:
  //   macOS:  context.appOutDir = "dist/mac-arm64", app at "dist/mac-arm64/Scratch.app"
  //   Linux:  context.appOutDir = "dist/linux-unpacked"
  //
  // At runtime, Electron's process.resourcesPath resolves to:
  //   macOS:  <app>.app/Contents/Resources
  //   Linux:  <unpacked>/resources
  let resourcesDir;
  if (platform === 'darwin') {
    // Find the .app bundle inside appOutDir
    const appName = context.packager.appInfo.productFilename + '.app';
    resourcesDir = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  } else {
    resourcesDir = path.join(context.appOutDir, 'resources');
  }

  const destDir = path.join(resourcesDir, 'bin');
  const destBinary = path.join(destDir, binaryName);

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcBinary, destBinary);
  fs.chmodSync(destBinary, 0o755);
  console.log(`afterPack: bundled ${srcBinary} → ${destBinary}`);

  // scratchmd-native cdylib — slice H.4. On platforms where we don't ship a
  // napi build yet (currently win32), the desktop's local cell-edit handlers
  // throw at runtime with "scratchmd-native binary not found" — a regression
  // ticket for that case, not a packaging failure here.
  const nativeFilename = nativeFilenameFor(platform, arch);
  if (!nativeFilename) {
    console.warn(`afterPack: napi cdylib not supported on ${key}; cell-edit IPC will fail at runtime.`);
    return;
  }
  const srcNative = path.join(cliBinariesDir, nativeFilename);
  if (!fs.existsSync(srcNative)) {
    throw new Error(
      `afterPack: native addon not found at ${srcNative}.\n` +
        'In CI this is provided by the build-cli-for-desktop job artifacts (slice H.4).\n' +
        'For local builds, run:\n' +
        `  cd scratch-git-2 && cargo zigbuild --release -p scratchmd-native --target ${rustTarget}\n` +
        `  cp target/${rustTarget}/release/libscratchmd_native.${platform === 'darwin' ? 'dylib' : 'so'} \\\n` +
        `     cli-binaries/${rustTarget}/${nativeFilename}`,
    );
  }
  const destNative = path.join(destDir, nativeFilename);
  fs.copyFileSync(srcNative, destNative);
  fs.chmodSync(destNative, 0o755);
  console.log(`afterPack: bundled ${srcNative} → ${destNative}`);
};
