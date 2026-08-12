#!/usr/bin/env node
/**
 * Post-packaging gate: read the REAL macOS entitlements out of the signed .app and fail if the
 * shipped binary carries a dangerous Hardened Runtime entitlement — or is missing a required one —
 * per scripts/expected-entitlements.cjs (Oneleet pentest finding SCR-004 / DEV-10999).
 *
 * Usage (from scratch-desktop/):
 *   node scripts/verify-entitlements.cjs [path/to/Scratch.app]
 * With no argument it auto-discovers the packaged bundle under the dist/ mac output dir.
 *
 * The vitest spec (src/main/__tests__/entitlements.spec.ts) asserts the *plists* declare a safe set;
 * this asserts the signed *artifact* actually has one. Both exist because the declaration and the
 * artifact can diverge — an entitlements file that isn't the one electron-builder signed with, a
 * --config pointing at a different profile, or a signing step that drops entitlements would all
 * leave the config test green and still ship a dangerous binary.
 *
 * Called by scripts/package.sh for the mac platform, before artifacts are collected into
 * dist-release/, so a build carrying disable-library-validation / allow-dyld-environment-variables
 * never reaches the GitHub release. To check an arbitrary bundle by hand:
 *   codesign -d --entitlements - --xml /path/to/Scratch.app
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { RELEASE_FORBIDDEN_ENTITLEMENTS, RELEASE_REQUIRED_ENTITLEMENTS } = require('./expected-entitlements.cjs');

const desktopPackageDir = path.resolve(__dirname, '..');
const distDir = path.join(desktopPackageDir, 'dist');

/**
 * Locate the packaged mac .app bundle. electron-builder writes it to dist/mac-arm64/Scratch.app
 * (or mac/, mac-universal/, … depending on target arch). Mirrors verify-fuses.cjs.
 */
function findPackagedMacAppBundle() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`verify-entitlements: no dist/ directory at ${distDir} — run electron-builder first.`);
  }
  const macOutputDirs = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => entry.name === 'mac' || entry.name.startsWith('mac-'));
  for (const macOutputDir of macOutputDirs) {
    const appBundles = fs.readdirSync(path.join(distDir, macOutputDir.name)).filter((name) => name.endsWith('.app'));
    if (appBundles.length > 0) {
      return path.join(distDir, macOutputDir.name, appBundles[0]);
    }
  }
  throw new Error(`verify-entitlements: no .app bundle found under ${distDir}/mac*/`);
}

/**
 * Return the entitlement keys embedded in a signed bundle/binary by parsing the XML that
 * `codesign -d --entitlements - --xml` prints to stdout. Returns null if codesign cannot read the
 * path (e.g. an unsigned nested bundle), so callers decide whether that is fatal.
 */
function readEmbeddedEntitlementKeys(machoPath) {
  let entitlementsXml;
  try {
    entitlementsXml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', machoPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const keys = [];
  for (const match of entitlementsXml.matchAll(/<key>([^<]+)<\/key>/g)) {
    keys.push(match[1].trim());
  }
  return keys;
}

/** Chromium ships several helper .app bundles under Contents/Frameworks/; they inherit entitlements. */
function findHelperAppBundles(appBundlePath) {
  const frameworksDir = path.join(appBundlePath, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworksDir)) {
    return [];
  }
  return fs
    .readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(frameworksDir, entry.name));
}

function main() {
  const appBundlePath = process.argv[2] ? path.resolve(process.argv[2]) : findPackagedMacAppBundle();
  console.log(`verify-entitlements: inspecting ${appBundlePath}`);

  const failures = [];

  // 1. The main app executable — the binary the pentest examined. Strict: no forbidden entitlement,
  // every required entitlement present.
  const mainKeys = readEmbeddedEntitlementKeys(appBundlePath);
  if (mainKeys === null) {
    failures.push(`could not read entitlements from ${appBundlePath} (is it code-signed?)`);
  } else {
    console.log(`  main app entitlements: ${mainKeys.join(', ') || '(none)'}`);
    for (const forbidden of RELEASE_FORBIDDEN_ENTITLEMENTS) {
      if (mainKeys.includes(forbidden.key)) {
        failures.push(`main app grants forbidden entitlement ${forbidden.key}. ${forbidden.whyItMatters}`);
      }
    }
    for (const required of RELEASE_REQUIRED_ENTITLEMENTS) {
      if (!mainKeys.includes(required.key)) {
        failures.push(`main app is missing required entitlement ${required.key}. ${required.whyItMatters}`);
      }
    }
  }

  // 2. Helper apps inherit entitlements via entitlementsInherit, so a forbidden key here is the same
  // regression. Best-effort: a helper codesign read failure is a warning, not a release blocker —
  // the main-app assertion above is the authoritative gate.
  for (const helperAppPath of findHelperAppBundles(appBundlePath)) {
    const helperKeys = readEmbeddedEntitlementKeys(helperAppPath);
    if (helperKeys === null) {
      console.warn(`  warning: could not read entitlements from helper ${helperAppPath} (skipping)`);
      continue;
    }
    for (const forbidden of RELEASE_FORBIDDEN_ENTITLEMENTS) {
      if (helperKeys.includes(forbidden.key)) {
        failures.push(
          `helper ${path.basename(helperAppPath)} grants forbidden entitlement ${forbidden.key}. ${forbidden.whyItMatters}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nverify-entitlements: ${failures.length} problem(s) in ${appBundlePath}:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      '\nCheck the mac.entitlements/entitlementsInherit wiring in electron-builder.yml and the plists in build/. ' +
        'The signed release must use build/entitlements.mac.plist (SCR-004 / DEV-10999).',
    );
    process.exit(1);
  }

  console.log(
    `verify-entitlements: OK — no forbidden entitlements, all ${RELEASE_REQUIRED_ENTITLEMENTS.length} required present.`,
  );
}

// Only auto-run when invoked directly; when required by a unit test we just want the exported
// helpers, not main()'s process.exit.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`verify-entitlements: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { readEmbeddedEntitlementKeys, findHelperAppBundles, findPackagedMacAppBundle };
