// DEV-13025: the bundled scratchmd's own crate version is always the build
// default, so Desktop names its app version in the spawned CLI's environment.
// scratchmd adds it to its User-Agent, which is how the server tells Desktop
// versions apart before the table-spec git copies are turned off.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({ isPackaged: false, getVersion: () => '1.0.150', getAppPath: () => '/fake' }));
vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../setup-git-env', () => ({ bundledGitBinaryPath: () => '/bundled/git' }));

import { scratchmdEnv } from '../scratchmd';

describe('scratchmdEnv', () => {
  beforeEach(() => {
    electronApp.isPackaged = false;
  });

  it('names the app version in a dev build', () => {
    expect(scratchmdEnv().SCRATCH_DESKTOP_APP_VERSION).toBe('1.0.150');
  });

  it('names the app version in a packaged build, alongside the bundled git', () => {
    electronApp.isPackaged = true;
    const env = scratchmdEnv();
    expect(env.SCRATCH_DESKTOP_APP_VERSION).toBe('1.0.150');
    expect(env.SCRATCH_GIT_BIN).toBe('/bundled/git');
  });
});
