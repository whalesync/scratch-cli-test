import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Unit test for the Linux app-binary selection in scripts/verify-fuses.cjs (DEV-11000).
 *
 * dist/linux-unpacked/ holds the Electron app binary alongside Chromium's own extension-less
 * helper executables (chrome-sandbox, chrome_crashpad_handler). Only the app binary carries a
 * fuse sentinel; picking a helper makes @electron/fuses throw "Could not find sentinel …" —
 * which is exactly what broke the Package test Linux release job when the selector took the
 * first executable it found. This asserts the selector targets the app binary by name
 * regardless of readdir order.
 */

interface VerifyFusesModule {
  selectLinuxAppExecutableName: (extensionlessExecutableNames: string[], expectedExecutableName: string) => string;
}

// verify-fuses.cjs is CommonJS because the release build scripts require it at packaging time,
// where TypeScript isn't available. `yarn test` runs vitest from the scratch-desktop package
// dir, so resolve from cwd (same pattern as electron-fuses.spec.ts).
const desktopPackageDir = process.cwd();
const loadCommonJs = createRequire(path.join(desktopPackageDir, 'vitest.config.mts'));
const { selectLinuxAppExecutableName } = loadCommonJs(
  path.join(desktopPackageDir, 'scripts', 'verify-fuses.cjs'),
) as VerifyFusesModule;

const APP_EXECUTABLE_NAME = 'scratch-desktop';
const CHROMIUM_HELPER_EXECUTABLES = ['chrome-sandbox', 'chrome_crashpad_handler'];

describe('selectLinuxAppExecutableName', () => {
  it('returns the app binary when it is listed after the Chromium helpers (the CI failure order)', () => {
    expect(
      selectLinuxAppExecutableName([...CHROMIUM_HELPER_EXECUTABLES, APP_EXECUTABLE_NAME], APP_EXECUTABLE_NAME),
    ).toBe(APP_EXECUTABLE_NAME);
  });

  it('returns the app binary regardless of readdir order', () => {
    expect(
      selectLinuxAppExecutableName([APP_EXECUTABLE_NAME, ...CHROMIUM_HELPER_EXECUTABLES], APP_EXECUTABLE_NAME),
    ).toBe(APP_EXECUTABLE_NAME);
    expect(
      selectLinuxAppExecutableName(
        ['chrome_crashpad_handler', APP_EXECUTABLE_NAME, 'chrome-sandbox'],
        APP_EXECUTABLE_NAME,
      ),
    ).toBe(APP_EXECUTABLE_NAME);
  });

  it('falls back to the single non-helper executable when the expected name is absent (e.g. an executableName change)', () => {
    expect(selectLinuxAppExecutableName([...CHROMIUM_HELPER_EXECUTABLES, 'scratch'], APP_EXECUTABLE_NAME)).toBe(
      'scratch',
    );
  });

  it('throws with a clear message when only Chromium helpers are present', () => {
    expect(() => selectLinuxAppExecutableName(CHROMIUM_HELPER_EXECUTABLES, APP_EXECUTABLE_NAME)).toThrow(
      /could not identify the Linux app binary/,
    );
  });

  it('throws when the app binary is missing and the remaining candidates are ambiguous', () => {
    expect(() =>
      selectLinuxAppExecutableName([...CHROMIUM_HELPER_EXECUTABLES, 'scratch', 'other-binary'], APP_EXECUTABLE_NAME),
    ).toThrow(/could not identify the Linux app binary/);
  });
});
