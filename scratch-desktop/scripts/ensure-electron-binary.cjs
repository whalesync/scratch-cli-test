#!/usr/bin/env node
/*
 * Ensure node_modules/electron/dist holds a complete Electron binary on Windows.
 *
 * Electron's own postinstall (extract-zip) intermittently leaves a PARTIAL dist
 * on Windows — e.g. when a sibling workspace package's postinstall fails and
 * yarn aborts the run mid-extraction, electron's install.js can still resolve
 * (exit 0) with electron.exe missing and only `locales/` present. The dev app
 * and packaging then fail in confusing ways.
 *
 * This guard re-extracts from the sha-verified @electron/get cache zip using a
 * reliable extractor (.NET ZipFile via PowerShell handles the ~180 MB archive
 * cleanly where extract-zip flaked). It is a no-op on macOS/Linux and whenever
 * the binary is already present, so it is safe to run on every install.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32') {
  process.exit(0);
}

const electronPackageJsonPath = require.resolve('electron/package.json');
const electronDir = path.dirname(electronPackageJsonPath);
const distDir = path.join(electronDir, 'dist');
const electronExePath = path.join(distDir, 'electron.exe');
const electronVersion = require(electronPackageJsonPath).version;

// Healthy: the executable and the `version` marker electron's isInstalled() checks.
if (fs.existsSync(electronExePath) && fs.existsSync(path.join(distDir, 'version'))) {
  process.exit(0);
}

const arch = process.arch; // 'x64' | 'arm64'
const cacheRoot =
  process.env.electron_config_cache ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache');
const cachedZipName = `electron-v${electronVersion}-win32-${arch}.zip`;

let cachedZipPath = null;
try {
  // @electron/get cache layout: <cacheRoot>/<sha>/<zipName>
  for (const cacheEntry of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, cacheEntry, cachedZipName);
    if (fs.existsSync(candidate)) {
      cachedZipPath = candidate;
      break;
    }
  }
} catch {
  // cacheRoot doesn't exist — nothing to repair from.
}

if (!cachedZipPath) {
  console.warn(
    `[ensure-electron-binary] electron.exe missing and no cached ${cachedZipName} found under ${cacheRoot}.`,
  );
  console.warn('  Re-run `yarn install` to re-download Electron (set force_no_cache=true to force a fresh download).');
  // Don't fail the whole monorepo install for a desktop-only binary.
  process.exit(0);
}

console.log(`[ensure-electron-binary] repairing incomplete Electron dist from ${cachedZipPath}`);
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const powershellExtractCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${JSON.stringify(
  cachedZipPath,
)}, ${JSON.stringify(distDir)})`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', powershellExtractCommand], {
  stdio: 'inherit',
});

// electron's install.js writes this so its isInstalled() check passes next time.
fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe');

if (!fs.existsSync(electronExePath)) {
  console.error('[ensure-electron-binary] extraction completed but electron.exe is still missing.');
  process.exit(1);
}
console.log('[ensure-electron-binary] electron.exe restored.');
