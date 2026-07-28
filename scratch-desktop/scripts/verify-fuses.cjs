#!/usr/bin/env node
/**
 * Post-packaging gate: read the REAL Electron fuse wire out of a packaged binary and
 * fail if it does not match scripts/expected-fuses.cjs (DEV-11000 / Oneleet SCR-005).
 *
 * Usage (from scratch-desktop/):
 *   node scripts/verify-fuses.cjs <mac|linux|windows>
 *
 * The vitest spec asserts electron-builder.yml *declares* the right fuses; this asserts
 * the shipped artifact actually *has* them. Both exist because the declaration and the
 * artifact can diverge — an electron-builder upgrade that renames a config key, a build
 * script passing `--config` with a different file, or a packager option that skips the
 * fuse flip would all leave the config test green and the app unhardened.
 *
 * Called by scripts/package.sh for every release platform. To check an arbitrary bundle
 * by hand: `npx @electron/fuses read --app <path to .app>`.
 */

const fs = require('fs');
const path = require('path');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const { ALL_EXPECTED_FUSES } = require('./expected-fuses.cjs');

// getCurrentFuseWire returns each fuse as the raw byte in the wire: '0'/'1' as char codes.
const FUSE_WIRE_BYTE_DISABLED = '0'.charCodeAt(0);
const FUSE_WIRE_BYTE_ENABLED = '1'.charCodeAt(0);

const desktopPackageDir = path.resolve(__dirname, '..');
const distDir = path.join(desktopPackageDir, 'dist');

// electron-builder names the Linux executable after `executableName`, which defaults to
// package.json `name` ("scratch-desktop"), lowercased. Crucially this is NOT `productName`, so
// the release build's `-c.productName="Scratch (Test)"` override does not change it — making the
// package name the reliable way to find the app binary in dist/linux-unpacked/.
const expectedLinuxExecutableName = String(require(path.join(desktopPackageDir, 'package.json')).name).toLowerCase();

// Chromium ships these extension-less executables next to the Electron app binary in
// dist/linux-unpacked/. Only the app binary carries a fuse sentinel, so a helper must never be
// mistaken for it (reading fuses from chrome-sandbox is what broke the Package test Linux job).
const CHROMIUM_HELPER_EXECUTABLE_NAMES = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);

/**
 * Pick the Electron app binary out of the extension-less executables in dist/linux-unpacked/.
 * Prefer an exact match on the known executable name; if that is absent (e.g. a future
 * executableName change), fall back to the single non-helper executable, erroring loudly when
 * the choice is ambiguous rather than silently verifying the wrong file.
 */
function selectLinuxAppExecutableName(extensionlessExecutableNames, expectedExecutableName) {
  if (extensionlessExecutableNames.includes(expectedExecutableName)) {
    return expectedExecutableName;
  }
  const nonHelperExecutableNames = extensionlessExecutableNames.filter(
    (name) => !CHROMIUM_HELPER_EXECUTABLE_NAMES.has(name),
  );
  if (nonHelperExecutableNames.length === 1) {
    return nonHelperExecutableNames[0];
  }
  throw new Error(
    `verify-fuses: could not identify the Linux app binary (expected '${expectedExecutableName}'). ` +
      `Extension-less executables found: [${extensionlessExecutableNames.join(', ') || 'none'}].`,
  );
}

/**
 * electron-builder names the unpacked output dir per platform/arch. The executable inside it is
 * named after `productName` (which release builds override to "Scratch (Test)") on mac/windows,
 * or after `executableName` on linux. Locate the one binary to verify.
 */
function findPackagedBinaryPath(platform) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`verify-fuses: no dist/ directory at ${distDir} — run electron-builder first.`);
  }
  const distEntries = fs.readdirSync(distDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  if (platform === 'mac') {
    // dist/mac-arm64/Scratch.app (or mac/, mac-universal/, … depending on target arch).
    const macOutputDirs = distEntries.filter((entry) => entry.name === 'mac' || entry.name.startsWith('mac-'));
    for (const macOutputDir of macOutputDirs) {
      const appBundles = fs.readdirSync(path.join(distDir, macOutputDir.name)).filter((name) => name.endsWith('.app'));
      if (appBundles.length > 0) {
        return path.join(distDir, macOutputDir.name, appBundles[0]);
      }
    }
    throw new Error(`verify-fuses: no .app bundle found under ${distDir}/mac*/`);
  }

  if (platform === 'windows') {
    // dist/win-unpacked/Scratch.exe
    const winOutputDir = distEntries.find((entry) => entry.name.startsWith('win-unpacked'));
    if (!winOutputDir) {
      throw new Error(`verify-fuses: no win-unpacked/ directory under ${distDir}`);
    }
    const executables = fs.readdirSync(path.join(distDir, winOutputDir.name)).filter((name) => name.endsWith('.exe'));
    if (executables.length === 0) {
      throw new Error(`verify-fuses: no .exe found under ${distDir}/${winOutputDir.name}/`);
    }
    return path.join(distDir, winOutputDir.name, executables[0]);
  }

  // Linux: dist/linux-unpacked/scratch-desktop — the ELF next to resources/. The unpacked dir
  // also holds Chromium's own extension-less executables (chrome-sandbox, chrome_crashpad_handler),
  // so select the app binary by its known executableName rather than taking the first executable.
  const linuxOutputDir = distEntries.find((entry) => entry.name.startsWith('linux-unpacked'));
  if (!linuxOutputDir) {
    throw new Error(`verify-fuses: no linux-unpacked/ directory under ${distDir}`);
  }
  const linuxOutputPath = path.join(distDir, linuxOutputDir.name);
  const extensionlessExecutableNames = fs
    .readdirSync(linuxOutputPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !path.extname(entry.name))
    .filter((entry) => (fs.statSync(path.join(linuxOutputPath, entry.name)).mode & 0o111) !== 0)
    .map((entry) => entry.name);
  const linuxAppExecutableName = selectLinuxAppExecutableName(
    extensionlessExecutableNames,
    expectedLinuxExecutableName,
  );
  return path.join(linuxOutputPath, linuxAppExecutableName);
}

function describeFuseWireByte(wireByte) {
  if (wireByte === FUSE_WIRE_BYTE_ENABLED) return 'enabled';
  if (wireByte === FUSE_WIRE_BYTE_DISABLED) return 'disabled';
  return `unknown (raw byte ${String(wireByte)})`;
}

async function main() {
  const platform = process.argv[2];
  if (!['mac', 'linux', 'windows'].includes(platform)) {
    console.error('Usage: node scripts/verify-fuses.cjs <mac|linux|windows>');
    process.exit(1);
  }

  const packagedBinaryPath = findPackagedBinaryPath(platform);
  console.log(`verify-fuses: reading fuse wire from ${packagedBinaryPath}`);
  const actualFuseWire = await getCurrentFuseWire(packagedBinaryPath);

  const failures = [];
  for (const expectedFuse of ALL_EXPECTED_FUSES) {
    const fuseWireIndex = FuseV1Options[expectedFuse.electronFuseName];
    if (fuseWireIndex === undefined) {
      failures.push(
        `${expectedFuse.electronFuseName}: not a known FuseV1Options member — expected-fuses.cjs is out of date with @electron/fuses.`,
      );
      continue;
    }
    const actualWireByte = actualFuseWire[fuseWireIndex];
    const expectedWireByte = expectedFuse.expectedValue ? FUSE_WIRE_BYTE_ENABLED : FUSE_WIRE_BYTE_DISABLED;
    const status = actualWireByte === expectedWireByte ? 'OK  ' : 'FAIL';
    console.log(
      `  ${status} ${expectedFuse.electronFuseName.padEnd(38)} expected ${describeFuseWireByte(
        expectedWireByte,
      )}, got ${describeFuseWireByte(actualWireByte)}`,
    );
    if (actualWireByte !== expectedWireByte) {
      failures.push(
        `${expectedFuse.electronFuseName} is ${describeFuseWireByte(actualWireByte)} but must be ${describeFuseWireByte(
          expectedWireByte,
        )}. ${expectedFuse.whyItMatters}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\nverify-fuses: ${failures.length} fuse(s) wrong in ${packagedBinaryPath}:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      '\nCheck the `electronFuses` block in electron-builder.yml and that electron-builder is flipping fuses (it logs "executing @electron/fuses" during packaging).',
    );
    process.exit(1);
  }

  console.log(`verify-fuses: all ${ALL_EXPECTED_FUSES.length} fuses match the expected posture.`);
}

// Only auto-run when invoked directly (node scripts/verify-fuses.cjs …); when required by a unit
// test we just want the exported helpers, not main()'s process.exit.
if (require.main === module) {
  main().catch((error) => {
    console.error(`verify-fuses: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = { selectLinuxAppExecutableName };
