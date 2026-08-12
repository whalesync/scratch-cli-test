import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * Regression guard for the macOS entitlement hardening in DEV-10999 (Oneleet pentest finding
 * SCR-004). The signed, notarized Scratch.app had shipped with two Hardened Runtime exceptions
 * (disable-library-validation + allow-dyld-environment-variables) that let a local attacker inject
 * a dylib via DYLD_INSERT_LIBRARIES into the trusted, TCC-privileged, token-holding process — so
 * the entitlements plists and their electron-builder wiring are a security control, not a
 * preference. This spec fails the build if a future edit re-introduces a dangerous entitlement or
 * mis-wires the profiles.
 *
 * It asserts the *config* (the plists + the yml wiring), not a packaged binary: reading the real
 * signed entitlements needs a full electron-builder run, which is gated separately by
 * scripts/verify-entitlements.cjs in the release pipeline. Both compare against the same
 * scripts/expected-entitlements.cjs.
 */

interface ExpectedEntitlement {
  key: string;
  whyItMatters: string;
}

interface ExpectedEntitlementsModule {
  RELEASE_FORBIDDEN_ENTITLEMENTS: ExpectedEntitlement[];
  RELEASE_REQUIRED_ENTITLEMENTS: ExpectedEntitlement[];
  ADHOC_EXTRA_ENTITLEMENTS: ExpectedEntitlement[];
}

interface MacEntitlementsWiring {
  entitlements?: string;
  entitlementsInherit?: string;
  extends?: string;
}

// expected-entitlements.cjs is CommonJS because the release build scripts require it at packaging
// time, where TypeScript isn't available. `yarn test` runs vitest from the scratch-desktop package
// dir, so resolve from cwd (same pattern as electron-fuses.spec.ts).
const desktopPackageDir = process.cwd();
const loadCommonJs = createRequire(path.join(desktopPackageDir, 'vitest.config.mts'));
const { RELEASE_FORBIDDEN_ENTITLEMENTS, RELEASE_REQUIRED_ENTITLEMENTS, ADHOC_EXTRA_ENTITLEMENTS } = loadCommonJs(
  path.join(desktopPackageDir, 'scripts', 'expected-entitlements.cjs'),
) as ExpectedEntitlementsModule;

const releaseForbiddenKeys = RELEASE_FORBIDDEN_ENTITLEMENTS.map((entitlement) => entitlement.key);
const releaseRequiredKeys = RELEASE_REQUIRED_ENTITLEMENTS.map((entitlement) => entitlement.key);
const adhocExtraKeys = ADHOC_EXTRA_ENTITLEMENTS.map((entitlement) => entitlement.key);

function sortedUnique(values: string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique.sort();
}

// Each entitlement in these plists is a `<key>NAME</key>` line followed by `<true/>`; the surrounding
// comments never contain a literal `<key>` tag, so extracting every `<key>` element yields exactly
// the granted entitlement set.
function readEntitlementKeysFromPlist(plistFilename: string): string[] {
  const contents = readFileSync(path.join(desktopPackageDir, 'build', plistFilename), 'utf8');
  const keys: string[] = [];
  const keyPattern = /<key>([^<]+)<\/key>/g;
  let match: RegExpExecArray | null = keyPattern.exec(contents);
  while (match !== null) {
    const capturedKey: string | undefined = match[1];
    if (typeof capturedKey === 'string') {
      keys.push(capturedKey.trim());
    }
    match = keyPattern.exec(contents);
  }
  return keys;
}

function readMacEntitlementsWiring(configFilename: string): MacEntitlementsWiring {
  const contents = readFileSync(path.join(desktopPackageDir, configFilename), 'utf8');
  const config = parseYaml(contents) as { mac?: MacEntitlementsWiring; extends?: string };
  return {
    entitlements: config.mac?.entitlements,
    entitlementsInherit: config.mac?.entitlementsInherit,
    extends: config.extends,
  };
}

describe('build/entitlements.mac.plist (signed release profile)', () => {
  const releaseProfileKeys = readEntitlementKeysFromPlist('entitlements.mac.plist');

  it.each(RELEASE_FORBIDDEN_ENTITLEMENTS)(
    'does NOT grant the dangerous entitlement $key (Oneleet SCR-004 / DEV-10999)',
    ({ key, whyItMatters }) => {
      expect(releaseProfileKeys, whyItMatters).not.toContain(key);
    },
  );

  it.each(RELEASE_REQUIRED_ENTITLEMENTS)('grants the required entitlement $key', ({ key, whyItMatters }) => {
    expect(releaseProfileKeys, whyItMatters).toContain(key);
  });

  it('grants EXACTLY the required entitlements and nothing else', () => {
    expect(sortedUnique(releaseProfileKeys)).toEqual(sortedUnique(releaseRequiredKeys));
  });
});

describe('build/entitlements.mac.adhoc.plist (dev-only ad-hoc profile)', () => {
  const adhocProfileKeys = readEntitlementKeysFromPlist('entitlements.mac.adhoc.plist');

  it('grants exactly the release-required entitlements plus the ad-hoc-only extras', () => {
    expect(sortedUnique(adhocProfileKeys)).toEqual(sortedUnique([...releaseRequiredKeys, ...adhocExtraKeys]));
  });

  // Every release-forbidden key that is NOT an intentional ad-hoc exception must be absent here too.
  it.each(RELEASE_FORBIDDEN_ENTITLEMENTS.filter((entitlement) => !adhocExtraKeys.includes(entitlement.key)))(
    'does NOT grant $key even in the ad-hoc profile',
    ({ key, whyItMatters }) => {
      expect(adhocProfileKeys, whyItMatters).not.toContain(key);
    },
  );
});

describe('electron-builder entitlements wiring', () => {
  it('signs the Developer ID release with the clean release profile', () => {
    const wiring = readMacEntitlementsWiring('electron-builder.yml');
    expect(wiring.entitlements).toBe('build/entitlements.mac.plist');
    expect(wiring.entitlementsInherit).toBe('build/entitlements.mac.plist');
  });

  it('signs local ad-hoc builds with the dev-only ad-hoc profile', () => {
    const wiring = readMacEntitlementsWiring('electron-builder.unsigned-mac.yml');
    expect(wiring.extends).toBe('electron-builder.yml');
    expect(wiring.entitlements).toBe('build/entitlements.mac.adhoc.plist');
    expect(wiring.entitlementsInherit).toBe('build/entitlements.mac.adhoc.plist');
  });
});

describe('scripts/expected-entitlements.cjs', () => {
  it('keeps the required and forbidden entitlement sets disjoint', () => {
    const overlap = releaseRequiredKeys.filter((key) => releaseForbiddenKeys.includes(key));
    expect(overlap).toEqual([]);
  });

  it('only re-adds known release-forbidden entitlements as ad-hoc exceptions, never brand-new ones', () => {
    for (const key of adhocExtraKeys) {
      const message = `${key} is added in the ad-hoc profile but is not a known release-forbidden entitlement`;
      expect(releaseForbiddenKeys, message).toContain(key);
    }
  });

  it('never re-adds allow-dyld-environment-variables, not even in the ad-hoc profile', () => {
    expect(adhocExtraKeys).not.toContain('com.apple.security.cs.allow-dyld-environment-variables');
  });
});
