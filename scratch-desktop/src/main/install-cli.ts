/**
 * Install / uninstall the `scratchmd` CLI on PATH via a symlink at
 * /usr/local/bin/scratchmd.
 *
 * Triggers the standard macOS admin password prompt via `osascript ... with
 * administrator privileges`. The symlink target follows the same dev-vs-packaged
 * resolution the desktop app itself uses (`getScratchmdBinaryPath`):
 *   - Dev: <repoRoot>/scratch-git-2/target/debug/scratchmd
 *   - Packaged: <Scratch.app>/Contents/Resources/bin/scratchmd
 *
 * macOS only for now; the menu item is hidden on other platforms.
 */

import { spawn } from 'child_process';
import { app } from 'electron';
import { existsSync, lstatSync } from 'fs';
import { getScratchmdBinaryPath } from './scratchmd';

const INSTALL_PATH = '/usr/local/bin/scratchmd';

/**
 * Returns true iff /usr/local/bin/scratchmd exists and is a symlink (which is
 * what install creates). Narrower than "scratchmd is on PATH" — we don't want
 * to claim ownership of a homebrew-installed or hand-placed binary, since
 * uninstall would then refuse to delete it.
 */
export function isCliSymlinkInstalled(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return lstatSync(INSTALL_PATH).isSymbolicLink();
  } catch {
    return false;
  }
}

export type InstallCliResult =
  | { status: 'installed'; target: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

/**
 * Create (or refresh) the /usr/local/bin/scratchmd symlink pointing at the
 * binary this build of the app uses. Triggers the macOS admin password prompt.
 *
 * `ln -sf` overwrites any existing symlink (including a stale dev one). The
 * mkdir is defensive: /usr/local/bin doesn't exist on a fresh Apple Silicon
 * Mac that hasn't run any privileged installs.
 */
export async function installScratchmdToPath(): Promise<InstallCliResult> {
  if (process.platform !== 'darwin') {
    return { status: 'failed', message: 'CLI install is only supported on macOS.' };
  }

  const target = getScratchmdBinaryPath();
  if (!existsSync(target)) {
    const hint = app.isPackaged
      ? `Bundled scratchmd binary missing at ${target} — the app may be corrupted.`
      : `scratchmd debug binary not found at ${target}. Run 'cargo build --bin scratchmd' in scratch-git-2/ first.`;
    return { status: 'failed', message: hint };
  }

  const shellCmd = `mkdir -p /usr/local/bin && ln -sf '${shellQuote(target)}' '${INSTALL_PATH}'`;
  const appleScript = `do shell script "${appleScriptEscape(shellCmd)}" with administrator privileges`;
  return runOsascript(appleScript).then((res) => {
    if (res.status === 'ok') return { status: 'installed' as const, target };
    return res.error;
  });
}

export type UninstallCliResult =
  | { status: 'uninstalled' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

/**
 * Remove the /usr/local/bin/scratchmd symlink. Refuses if the path exists but
 * isn't a symlink — that's a binary we didn't create, and deleting it would
 * destroy work that isn't ours.
 */
export async function uninstallScratchmdFromPath(): Promise<UninstallCliResult> {
  if (process.platform !== 'darwin') {
    return { status: 'failed', message: 'CLI uninstall is only supported on macOS.' };
  }

  let stat;
  try {
    stat = lstatSync(INSTALL_PATH);
  } catch {
    // Already absent — treat as success so menu state catches up.
    return { status: 'uninstalled' };
  }
  if (!stat.isSymbolicLink()) {
    return {
      status: 'failed',
      message: `${INSTALL_PATH} exists but is not a symlink. Refusing to delete a real binary.`,
    };
  }

  const appleScript = `do shell script "rm '${INSTALL_PATH}'" with administrator privileges`;
  const res = await runOsascript(appleScript);
  if (res.status === 'ok') return { status: 'uninstalled' };
  return res.error;
}

type OsascriptOutcome =
  | { status: 'ok' }
  | { status: 'err'; error: { status: 'cancelled' } | { status: 'failed'; message: string } };

function runOsascript(appleScript: string): Promise<OsascriptOutcome> {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', appleScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => resolve({ status: 'err', error: { status: 'failed', message: err.message } }));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ status: 'ok' });
        return;
      }
      // osascript returns exit code 1 with "User canceled." on the stderr stream
      // when the user dismisses the admin prompt or hits Cancel.
      if (/User canceled|cancelled/i.test(stderr)) {
        resolve({ status: 'err', error: { status: 'cancelled' } });
        return;
      }
      resolve({
        status: 'err',
        error: { status: 'failed', message: stderr.trim() || `osascript exited with code ${code}` },
      });
    });
  });
}

function shellQuote(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
