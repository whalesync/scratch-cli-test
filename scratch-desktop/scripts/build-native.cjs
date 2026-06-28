#!/usr/bin/env node
/*
 * Build the scratchmd-native cdylib and drop the platform-named `.node` next
 * to `scratch-git-2/napi/Cargo.toml`. The Electron main-process loader at
 * `src/main/native/scratchmd-native.ts` resolves to that path in dev mode;
 * in packaged builds, scripts/afterPack.cjs copies the `.node` into
 * `Resources/bin/`.
 *
 * Cross-platform Node replacement for the original build-native.sh — runs on
 * macOS, Linux, AND Windows (the bash script had no Windows/MINGW host case
 * and emitted unix-only .dylib/.so paths, so `predev`/`prebuild` failed on a
 * native Windows checkout). See `docs/plans/resolved/2026-05-20-slice-h-spec/2026-05-20-slice-h-spec.md`
 * (slice H.2 of DEV-10144) for the original rationale.
 *
 * Usage:
 *   node scripts/build-native.cjs           # release build (default)
 *   node scripts/build-native.cjs debug     # debug profile (faster compile)
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, copyFileSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

// Run from the scratch-desktop directory regardless of invocation cwd.
const scratchDesktopDir = resolve(__dirname, '..');
const napiDir = join(scratchDesktopDir, '..', 'scratch-git-2', 'napi');
const scratchGit2Dir = join(scratchDesktopDir, '..', 'scratch-git-2');

const profile = process.argv[2] || 'release';
if (profile !== 'release' && profile !== 'debug') {
  console.error(`Usage: node scripts/build-native.cjs [release|debug]`);
  process.exit(1);
}

if (!existsSync(napiDir)) {
  console.error(`ERROR: ${napiDir} not found. Run from a repo with scratch-git-2/napi.`);
  process.exit(1);
}

// Skip gracefully when there's no Rust toolchain available. This lets the
// JS-only desktop CI image (lint + bundler) run `yarn build` without needing
// Rust; the packaged-build CI image (where cargo is installed) still produces
// a fresh .node.
const cargoProbe = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
if (cargoProbe.status !== 0) {
  console.warn('WARN: cargo not on PATH; skipping scratchmd-native build.');
  console.warn('      This is expected on the JS-only desktop CI image. Packaged');
  console.warn('      builds need the .node — make sure cargo is installed there.');
  process.exit(0);
}

// Map the host (process.platform-process.arch) onto:
//   - dylibName:  the file cargo emits for a cdylib on this platform
//   - nodeSuffix: the `<platform>-<arch>[-<abi>]` token in the .node filename,
//                 matching nativeBinaryFilename() in src/main/native/scratchmd-native.ts.
//   - cargoTarget: an explicit `--target` triple, or null to build for the host.
//
// Windows note: napi-rs only supports the MSVC target on Windows — its build
// script's GNU path (napi-build::windows::setup_gnu) hard-requires a
// `libnode.dll` to link `-lnode` against, which Node/Electron do not ship
// (Node is statically linked). The MSVC path instead resolves the Node-API
// symbols from the host process at load time (no import lib needed) and is the
// correct ABI match for Electron (itself MSVC-built). So we force the MSVC
// target for the addon even though the scratchmd CLI ships as windows-gnu.
function hostMapping() {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch; // 'arm64' | 'x64'
  if (platform === 'darwin') {
    return { dylibName: 'libscratchmd_native.dylib', nodeSuffix: `darwin-${arch}`, cargoTarget: null };
  }
  if (platform === 'linux' && arch === 'x64') {
    return { dylibName: 'libscratchmd_native.so', nodeSuffix: 'linux-x64-gnu', cargoTarget: null };
  }
  if (platform === 'win32' && arch === 'x64') {
    // A Rust cdylib on Windows is `<crate>.dll` with no `lib` prefix.
    return { dylibName: 'scratchmd_native.dll', nodeSuffix: 'win32-x64', cargoTarget: 'x86_64-pc-windows-msvc' };
  }
  console.error(`ERROR: unsupported host ${platform}-${arch} for napi build`);
  process.exit(1);
}

const { dylibName, nodeSuffix, cargoTarget } = hostMapping();
const outNode = join(napiDir, `scratchmd-native.${nodeSuffix}.node`);

console.log(`Building scratchmd-native (${profile}${cargoTarget ? `, ${cargoTarget}` : ''})…`);
const cargoArgs = ['build', '-p', 'scratchmd-native'];
if (cargoTarget) cargoArgs.push('--target', cargoTarget);
if (profile === 'release') cargoArgs.push('--release');

const build = spawnSync('cargo', cargoArgs, {
  cwd: scratchGit2Dir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  console.error(`ERROR: cargo build -p scratchmd-native failed (exit ${build.status}).`);
  process.exit(build.status || 1);
}

// `--target` nests the profile dir under the triple: target/<triple>/<profile>/.
const profileDir = cargoTarget ? join('target', cargoTarget, profile) : join('target', profile);
const dylibPath = join(scratchGit2Dir, profileDir, dylibName);
if (!existsSync(dylibPath)) {
  console.error(`ERROR: expected cargo output at ${dylibPath} but it doesn't exist.`);
  process.exit(1);
}

copyFileSync(dylibPath, outNode);
const sizeMb = (statSync(outNode).size / (1024 * 1024)).toFixed(1);
console.log(`Wrote ${outNode} (${sizeMb} MB)`);

// On macOS, dyld validation kills any process that tries to `dlopen` a .node
// whose on-disk signature doesn't match what it had at first load — which
// fires every time we rebuild during dev. An ad-hoc sign clears the signature
// cache so subsequent `require(...)` calls work. Release builds get re-signed
// during electron-builder's notarization step anyway.
if (process.platform === 'darwin') {
  const sign = spawnSync('codesign', ['--force', '--sign', '-', outNode], { stdio: 'ignore' });
  if (sign.status !== 0) {
    console.warn(`WARN: ad-hoc codesign of ${outNode} failed; dlopen may SIGKILL on macOS`);
  }
}
