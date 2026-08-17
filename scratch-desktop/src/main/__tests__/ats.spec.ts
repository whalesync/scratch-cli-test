import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * Regression guard for the macOS App Transport Security hardening in DEV-11004 (Oneleet pentest
 * finding SCR-009). Stock Electron's Info.plist ships NSAppTransportSecurity={NSAllowsArbitraryLoads:
 * true}, disabling ATS globally so the app could make cleartext HTTP to any host — so the
 * NSAppTransportSecurity block in electron-builder.yml is a security control, not a preference. This
 * spec fails the build if a future edit re-introduces a global arbitrary-loads flag, a weak-TLS
 * exception, or regresses the extendInfo map back to the (silently broken) list form.
 *
 * It asserts the *config* (the yml), not a packaged binary: reading the real Info.plist needs a full
 * electron-builder run, which is gated separately by scripts/verify-ats.cjs in the release pipeline.
 * Both compare against the same scripts/expected-ats.cjs.
 */

interface ExpectedInfoPlistKey {
  key: string;
  whyItMatters: string;
}

interface ExpectedAtsModule {
  EXPECTED_ATS_DICT: Record<string, unknown>;
  ATS_FORBIDDEN_FLAGS: ExpectedInfoPlistKey[];
  TLS_VERSION_KEYS: string[];
  FORBIDDEN_TLS_VERSIONS: string[];
  REQUIRED_INFO_PLIST_KEYS: ExpectedInfoPlistKey[];
  collectAtsViolations: (atsDict: unknown) => string[];
}

interface ElectronBuilderConfig {
  extends?: string;
  mac?: {
    extendInfo?: unknown;
  };
}

// expected-ats.cjs is CommonJS because the release build scripts require it at packaging time, where
// TypeScript isn't available. `yarn test` runs vitest from the scratch-desktop package dir, so
// resolve from cwd (same pattern as entitlements.spec.ts / electron-fuses.spec.ts).
const desktopPackageDir = process.cwd();
const loadCommonJs = createRequire(path.join(desktopPackageDir, 'vitest.config.mts'));
const { EXPECTED_ATS_DICT, ATS_FORBIDDEN_FLAGS, REQUIRED_INFO_PLIST_KEYS, collectAtsViolations } = loadCommonJs(
  path.join(desktopPackageDir, 'scripts', 'expected-ats.cjs'),
) as ExpectedAtsModule;

function readElectronBuilderConfig(configFilename: string): ElectronBuilderConfig {
  const contents = readFileSync(path.join(desktopPackageDir, configFilename), 'utf8');
  return parseYaml(contents) as ElectronBuilderConfig;
}

describe('electron-builder.yml mac.extendInfo (production ATS posture)', () => {
  const extendInfo = readElectronBuilderConfig('electron-builder.yml').mac?.extendInfo;

  it('is declared as a map, not a YAML list (a list assigns an index-"0" key and drops these entries)', () => {
    expect(Array.isArray(extendInfo)).toBe(false);
    expect(typeof extendInfo).toBe('object');
    expect(extendInfo).not.toBeNull();
  });

  const extendInfoMap = (extendInfo ?? {}) as Record<string, unknown>;
  const declaredAts = extendInfoMap.NSAppTransportSecurity;

  it('declares exactly the hardened NSAppTransportSecurity dict from expected-ats.cjs', () => {
    expect(declaredAts).toEqual(EXPECTED_ATS_DICT);
  });

  it('has no ATS violations (no arbitrary-loads, no weak TLS, at any depth)', () => {
    expect(collectAtsViolations(declaredAts)).toEqual([]);
  });

  it.each(ATS_FORBIDDEN_FLAGS)('does not enable the global ATS kill-switch $key', ({ key, whyItMatters }) => {
    expect((declaredAts as Record<string, unknown> | undefined)?.[key], whyItMatters).not.toBe(true);
  });

  it.each(REQUIRED_INFO_PLIST_KEYS)('preserves the non-ATS Info.plist key $key', ({ key, whyItMatters }) => {
    const value = extendInfoMap[key];
    expect(typeof value, whyItMatters).toBe('string');
    expect((value as string).length, whyItMatters).toBeGreaterThan(0);
  });
});

describe('electron-builder.unsigned-mac.yml (dev-only ad-hoc profile)', () => {
  const devConfig = readElectronBuilderConfig('electron-builder.unsigned-mac.yml');

  it('extends the shared config so local ad-hoc builds inherit the same ATS posture', () => {
    expect(devConfig.extends).toBe('electron-builder.yml');
  });

  // ATS does not govern dev networking (localhost dev server is Chromium, not NSURLSession) and the
  // updater is off for unsigned builds, so the dev profile must not weaken ATS — it inherits it.
  // Mirrors electron-fuses.spec.ts's "does not override electronFuses" guard.
  it('does not override mac.extendInfo (never ships a more permissive dev ATS)', () => {
    expect(devConfig.mac?.extendInfo).toBeUndefined();
  });
});

describe('scripts/expected-ats.cjs (source of truth + validator)', () => {
  it('keeps EXPECTED_ATS_DICT itself compliant', () => {
    expect(collectAtsViolations(EXPECTED_ATS_DICT)).toEqual([]);
  });

  it('flags a global NSAllowsArbitraryLoads', () => {
    expect(collectAtsViolations({ NSAllowsArbitraryLoads: true }).length).toBeGreaterThan(0);
  });

  it('flags a weak TLS version nested inside NSExceptionDomains', () => {
    const violations = collectAtsViolations({
      NSExceptionDomains: { 'example.com': { NSExceptionMinimumTLSVersion: 'TLSv1.0' } },
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('accepts a narrowly-scoped loopback insecure-HTTP exception (the empirical fallback shape)', () => {
    const violations = collectAtsViolations({
      NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true, NSIncludesSubdomains: false } },
    });
    expect(violations).toEqual([]);
  });

  it('flags a missing or non-object ATS dict', () => {
    expect(collectAtsViolations(undefined).length).toBeGreaterThan(0);
    expect(collectAtsViolations(null).length).toBeGreaterThan(0);
  });
});
