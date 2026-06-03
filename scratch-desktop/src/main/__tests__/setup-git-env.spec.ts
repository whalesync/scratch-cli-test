// DEV-10318: the main process must point in-process (napi) git shell-outs at
// the bundled git binary, so a packaged build never falls back to /usr/bin/git
// (the Xcode CLT stub) on a clean macOS machine. These tests pin the path
// derivation and the packaged-vs-dev env behavior of configureBundledGitEnvironment().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module only imports `app` from electron; a tiny mock keeps vitest from
// booting a real Electron context. `isPackaged` is mutated per test.
vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { app } from 'electron';
import { bundledGitBinaryPath, configureBundledGitEnvironment } from '../setup-git-env';

const appMock = app as unknown as { isPackaged: boolean };
const processMock = process as unknown as { resourcesPath?: string };
const GIT_ENV_KEYS = ['SCRATCH_GIT_BIN', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR'] as const;
const RESOURCES = '/Applications/Scratch.app/Contents/Resources';

describe('setup-git-env', () => {
  let savedResourcesPath: string | undefined;
  let savedEnv: Record<string, string | undefined>;
  let savedPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedResourcesPath = processMock.resourcesPath;
    savedEnv = {};
    for (const key of GIT_ENV_KEYS) savedEnv[key] = process.env[key];
    savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    processMock.resourcesPath = RESOURCES;
  });

  afterEach(() => {
    appMock.isPackaged = false;
    processMock.resourcesPath = savedResourcesPath;
    for (const key of GIT_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  });

  describe('bundledGitBinaryPath', () => {
    it('returns the unix bin/git path off Resources on macOS/Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      expect(bundledGitBinaryPath()).toBe(`${RESOURCES}/git/bin/git`);
    });

    it('returns the mingw64 git.exe path on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(bundledGitBinaryPath()).toBe(`${RESOURCES}/git/mingw64/bin/git.exe`);
    });
  });

  describe('configureBundledGitEnvironment', () => {
    it('is a no-op in dev builds (leaves SCRATCH_GIT_BIN unset)', () => {
      appMock.isPackaged = false;
      delete process.env.SCRATCH_GIT_BIN;
      configureBundledGitEnvironment();
      expect(process.env.SCRATCH_GIT_BIN).toBeUndefined();
    });

    it('sets SCRATCH_GIT_BIN to the bundled git in a packaged build', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      appMock.isPackaged = true;
      configureBundledGitEnvironment();
      expect(process.env.SCRATCH_GIT_BIN).toBe(`${RESOURCES}/git/bin/git`);
    });

    it('strips inherited GIT_EXEC_PATH / GIT_TEMPLATE_DIR when packaged', () => {
      appMock.isPackaged = true;
      process.env.GIT_EXEC_PATH = '/usr/libexec/git-core';
      process.env.GIT_TEMPLATE_DIR = '/usr/share/git-core/templates';
      configureBundledGitEnvironment();
      expect(process.env.GIT_EXEC_PATH).toBeUndefined();
      expect(process.env.GIT_TEMPLATE_DIR).toBeUndefined();
    });
  });
});
