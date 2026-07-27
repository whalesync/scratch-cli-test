import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * Regression guard for the Electron fuse hardening in DEV-11000 (Oneleet pentest
 * finding SCR-005). A packaged build that ships with `RunAsNode` enabled lets local
 * malware execute arbitrary Node.js code under our Developer ID signature, so the
 * `electronFuses` block in electron-builder.yml is a security control, not a
 * preference — this spec fails the build if a future edit drops or loosens it.
 *
 * It asserts the *config*, not a packaged binary: reading the real fuse wire needs a
 * full electron-builder run, which is gated separately by scripts/verify-fuses.cjs in
 * the release pipeline. Both compare against the same scripts/expected-fuses.cjs.
 */

interface ExpectedFuse {
  electronBuilderName: string;
  electronFuseName: string;
  expectedValue: boolean;
  whyItMatters: string;
}

interface ExpectedFusesModule {
  SECURITY_CRITICAL_FUSES: ExpectedFuse[];
  FUSES_PINNED_TO_ELECTRON_DEFAULTS: ExpectedFuse[];
  ALL_EXPECTED_FUSES: ExpectedFuse[];
}

// expected-fuses.cjs is CommonJS because the release build scripts require it at
// packaging time, where TypeScript isn't available. `yarn test` runs vitest from the
// scratch-desktop package dir, so resolve from cwd (same pattern as notarize-retry.spec.ts).
const desktopPackageDir = process.cwd();
const loadCommonJs = createRequire(path.join(desktopPackageDir, 'vitest.config.mts'));
const { SECURITY_CRITICAL_FUSES, FUSES_PINNED_TO_ELECTRON_DEFAULTS, ALL_EXPECTED_FUSES } = loadCommonJs(
  path.join(desktopPackageDir, 'scripts', 'expected-fuses.cjs'),
) as ExpectedFusesModule;

function readElectronBuilderConfig(filename: string): Record<string, unknown> {
  const contents = readFileSync(path.join(desktopPackageDir, filename), 'utf8');
  return parseYaml(contents) as Record<string, unknown>;
}

describe('electron-builder.yml electronFuses', () => {
  const config = readElectronBuilderConfig('electron-builder.yml');
  const declaredFuses = config.electronFuses as Record<string, boolean> | undefined;

  it('declares an electronFuses block (omitting it makes electron-builder skip flipping entirely)', () => {
    expect(declaredFuses).toBeDefined();
  });

  it.each(SECURITY_CRITICAL_FUSES)(
    'pins the security-critical fuse $electronBuilderName to $expectedValue',
    ({ electronBuilderName, expectedValue, whyItMatters }) => {
      expect(declaredFuses?.[electronBuilderName], whyItMatters).toBe(expectedValue);
    },
  );

  it.each(FUSES_PINNED_TO_ELECTRON_DEFAULTS)(
    'states the Electron-default fuse $electronBuilderName explicitly as $expectedValue',
    ({ electronBuilderName, expectedValue, whyItMatters }) => {
      expect(declaredFuses?.[electronBuilderName], whyItMatters).toBe(expectedValue);
    },
  );

  it('declares exactly the fuses expected-fuses.cjs covers, so none is left implicitly at a default', () => {
    const expectedFuseNames = ALL_EXPECTED_FUSES.map((fuse) => fuse.electronBuilderName).sort();
    expect(Object.keys(declaredFuses ?? {}).sort()).toEqual(expectedFuseNames);
  });

  it('keeps asar packing on, without which onlyLoadAppFromAsar and the integrity fuse cannot hold', () => {
    // electron-builder defaults `asar` to true; the risk is an explicit `asar: false`.
    expect(config.asar).not.toBe(false);
  });
});

describe('electron-builder.unsigned-mac.yml', () => {
  const unsignedMacConfig = readElectronBuilderConfig('electron-builder.unsigned-mac.yml');

  it('extends the shared config so local unsigned builds exercise the same fuses', () => {
    expect(unsignedMacConfig.extends).toBe('electron-builder.yml');
  });

  it('does not override electronFuses', () => {
    expect(unsignedMacConfig.electronFuses).toBeUndefined();
  });
});

describe('scripts/expected-fuses.cjs', () => {
  it('names fuses that actually exist in @electron/fuses', () => {
    const { FuseV1Options } = loadCommonJs('@electron/fuses') as { FuseV1Options: Record<string, number> };
    for (const fuse of ALL_EXPECTED_FUSES) {
      expect(FuseV1Options[fuse.electronFuseName], `${fuse.electronFuseName} is not a FuseV1Options member`).toBeTypeOf(
        'number',
      );
    }
  });

  it('covers every fuse electron-builder can flip, so nothing is silently unreviewed', () => {
    const { FuseV1Options } = loadCommonJs('@electron/fuses') as { FuseV1Options: Record<string, number> };
    // The enum is bidirectional (name -> index and index -> name); keep the string keys.
    const allElectronFuseNames = Object.keys(FuseV1Options)
      .filter((key) => Number.isNaN(Number(key)))
      .sort();
    expect(ALL_EXPECTED_FUSES.map((fuse) => fuse.electronFuseName).sort()).toEqual(allElectronFuseNames);
  });
});
