/**
 * electron-builder afterPack hook.
 *
 * Copies the correct architecture-specific scratchmd CLI binary into the
 * packaged app's resources/bin/ directory so the desktop app ships with a
 * bundled CLI and never falls back to a system-installed binary.
 *
 * Expected source layout (populated by CI or manually for local builds):
 *   scratch-git-2/cli-binaries/<rust-target>/scratchmd
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

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin', 'linux', 'win32'
  const arch = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${arch}`;
  const rustTarget = TARGET_MAP[key];

  if (!rustTarget) {
    throw new Error(`afterPack: no CLI binary mapping for platform/arch "${key}"`);
  }

  const binaryName = platform === 'win32' ? 'scratchmd.exe' : 'scratchmd';
  const srcBinary = path.resolve(__dirname, '..', '..', 'scratch-git-2', 'cli-binaries', rustTarget, binaryName);

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
};
