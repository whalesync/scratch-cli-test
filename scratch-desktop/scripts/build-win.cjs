#!/usr/bin/env node
/*
 * Package the Windows desktop app (NSIS installer) natively on Windows.
 *
 * The bash `build:mac` / `build:linux` scripts embed `${UPDATE_CHANNEL:-...}`,
 * which does not run under cmd.exe (how yarn invokes scripts on Windows). This
 * Node orchestrator is the portable Windows equivalent and also stages the two
 * Rust artifacts the packager expects:
 *
 *   - scratchmd CLI            → built for x86_64-pc-windows-gnu (matches CI)
 *   - scratchmd-native (.node) → built for x86_64-pc-windows-msvc (napi-rs only
 *                                supports MSVC on Windows; see build-native.cjs)
 *
 * Both are copied into scratch-git-2/cli-binaries/x86_64-pc-windows-gnu/, where
 * scripts/afterPack.cjs picks them up (it keys the dir on the CLI's rust target;
 * the .node filename is what the loader resolves, regardless of which compiler
 * produced it).
 *
 * Prereqs (see scratch-desktop/README.md → Windows): Node, Rust (gnu default +
 * msvc target), MSYS2 mingw-w64 gcc on PATH, VS Build Tools, nasm.
 *
 * Usage:
 *   node scripts/build-win.cjs           # UPDATE_CHANNEL defaults to desktop-test
 *   UPDATE_CHANNEL=desktop node scripts/build-win.cjs
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, copyFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const desktopDir = resolve(__dirname, '..');
const repoRoot = resolve(desktopDir, '..');
const scratchGit2Dir = join(repoRoot, 'scratch-git-2');
const RUST_TARGET_CLI = 'x86_64-pc-windows-gnu';
const cliBinariesDir = join(scratchGit2Dir, 'cli-binaries', RUST_TARGET_CLI);
const nativeNodeFilename = 'scratchmd-native.win32-x64.node';

process.env.UPDATE_CHANNEL = process.env.UPDATE_CHANNEL || 'desktop-test';

function run(cmd, args, cwd) {
  const where = cwd || desktopDir;
  console.log(`\n> ${cmd} ${args.join(' ')}   (cwd=${where})`);
  const result = spawnSync(cmd, args, {
    cwd: where,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(' ')} (exit ${result.status})`);
    process.exit(result.status || 1);
  }
}

// 1. Release scratchmd CLI (gnu host → target/release/scratchmd.exe).
run('cargo', ['build', '--release', '--bin', 'scratchmd'], scratchGit2Dir);

// 2. Release napi addon (msvc) → scratch-git-2/napi/scratchmd-native.win32-x64.node.
run('node', ['scripts/build-native.cjs', 'release'], desktopDir);

// 3. Stage both Rust artifacts where afterPack.cjs expects them.
mkdirSync(cliBinariesDir, { recursive: true });
const cliSrc = join(scratchGit2Dir, 'target', 'release', 'scratchmd.exe');
const nativeSrc = join(scratchGit2Dir, 'napi', nativeNodeFilename);
for (const [src, dest] of [
  [cliSrc, join(cliBinariesDir, 'scratchmd.exe')],
  [nativeSrc, join(cliBinariesDir, nativeNodeFilename)],
]) {
  if (!existsSync(src)) {
    console.error(`Expected build artifact missing: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`staged ${src} -> ${dest}`);
}

// 4. Bundled git tree (dugite-native) for win32-x64.
run('node', ['scripts/download-git.cjs', 'win32-x64'], desktopDir);

// 5. Bundle the JS (main/preload/renderer), then package the NSIS installer.
//    Invoked via yarn so the hoisted electron-vite / electron-builder bins resolve.
run('yarn', ['electron-vite', 'build'], desktopDir);
run('yarn', ['electron-builder', '--win'], desktopDir);

console.log('\nWindows package complete. Artifacts in scratch-desktop/dist/.');
