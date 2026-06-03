/**
 * DEV-10318: make the Electron main process resolve the bundled git binary for
 * EVERY git shell-out, including the in-process ones — not just the spawned
 * `scratchmd` CLI children.
 *
 * Background: the Rust git wrapper (`scratch-git-2/src/shared/git_exec.rs`)
 * resolves the git binary from the `SCRATCH_GIT_BIN` env var at call time and
 * SILENTLY falls back to bare `git` on `PATH` when it is unset/empty/missing.
 * On a clean macOS machine without Xcode Command Line Tools installed, bare
 * `git` resolves (via the launchd PATH a GUI-launched .app inherits:
 * `/usr/bin:/bin:/usr/sbin:/sbin`) to `/usr/bin/git` — Apple's `xcode-select`
 * stub — which pops the "Install the command line developer tools?" dialog.
 *
 * `scratchmdEnv()` in `scratchmd.ts` already injects `SCRATCH_GIT_BIN` onto
 * spawned `scratchmd` CLI children, so that path is fine. The gap is the
 * `scratchmd-native` napi addon (`src/main/native/scratchmd-native.ts`): it
 * runs IN-PROCESS inside the Electron main process and inherits the main
 * process environment. Its git-reading operations (folder refresh on workspace
 * open, grid blob reads, cell accept/reject/discard) reach the same Rust
 * wrapper, but the main process never had `SCRATCH_GIT_BIN` set — so they fall
 * back to `/usr/bin/git` and trigger the Xcode dialog.
 *
 * The fix: set `SCRATCH_GIT_BIN` on the main process's own `process.env` at
 * startup (before the napi addon's first call). Node mirrors `process.env`
 * writes into the C environment, so the native addon's `std::env::var` reads
 * see it. We also strip any inherited `GIT_EXEC_PATH` / `GIT_TEMPLATE_DIR` so
 * the wrapper's bundled-tree derivation wins over stale parent-shell values —
 * mirroring `scratchmdEnv()`.
 *
 * Dev (`!app.isPackaged`) is intentionally left untouched so developer runs
 * keep using whatever git is on their PATH (there is no bundled git tree in a
 * dev checkout, and developers have working git).
 */

import { app } from 'electron';
import { join } from 'path';

/**
 * Absolute path to the git binary bundled into the packaged app's Resources by
 * `scripts/afterPack.cjs`. Layout mirrors what dugite-native ships per OS:
 *   macOS / Linux: `Resources/git/bin/git`
 *   Windows:       `Resources/git/mingw64/bin/git.exe`
 *
 * Only meaningful in a packaged build — `process.resourcesPath` points at the
 * app's `Contents/Resources` (macOS) / `resources` (Linux/Windows) dir there.
 */
export function bundledGitBinaryPath(): string {
  return process.platform === 'win32'
    ? join(process.resourcesPath, 'git', 'mingw64', 'bin', 'git.exe')
    : join(process.resourcesPath, 'git', 'bin', 'git');
}

/**
 * Point the Rust git wrapper at the bundled git binary for in-process (napi)
 * git shell-outs by setting `SCRATCH_GIT_BIN` on the main process environment.
 *
 * Call this once, early in main-process startup, BEFORE the first
 * `scratchmd-native` napi call. No-op in dev builds.
 */
export function configureBundledGitEnvironment(): void {
  if (!app.isPackaged) {
    return;
  }
  process.env.SCRATCH_GIT_BIN = bundledGitBinaryPath();
  delete process.env.GIT_EXEC_PATH;
  delete process.env.GIT_TEMPLATE_DIR;
}
