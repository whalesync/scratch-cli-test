#!/usr/bin/env node
/**
 * Post-packaging gate: read the REAL macOS Info.plist out of the packaged .app and fail if the
 * shipped App Transport Security posture drifts from scripts/expected-ats.cjs (Oneleet pentest
 * finding SCR-009 / DEV-11004) — a re-introduced NSAllowsArbitraryLoads, a weak-TLS exception, an
 * unexpected ATS dict, or a dropped required Info.plist key.
 *
 * Usage (from scratch-desktop/):
 *   node scripts/verify-ats.cjs [path/to/Scratch.app]
 * With no argument it auto-discovers the packaged bundle under the dist/ mac output dir (shared with
 * verify-entitlements.cjs).
 *
 * The vitest spec (src/main/__tests__/ats.spec.ts) asserts electron-builder.yml *declares* a safe
 * NSAppTransportSecurity; this asserts the packaged *artifact* actually has one. Both exist because
 * the declaration and the artifact can diverge — an electron-builder upgrade changing how extendInfo
 * merges, a --config pointing elsewhere, or a stray plist post-process would leave the config test
 * green and still ship a plist with ATS disabled. Both compare against the same expected-ats.cjs.
 *
 * Called by scripts/package.sh for the mac platform, before artifacts are collected into
 * dist-release/. To check a bundle by hand:
 *   plutil -p /path/to/Scratch.app/Contents/Info.plist
 */

const path = require('path');
const util = require('node:util');
const { execFileSync } = require('child_process');
const { EXPECTED_ATS_DICT, REQUIRED_INFO_PLIST_KEYS, collectAtsViolations } = require('./expected-ats.cjs');
const { findPackagedMacAppBundle } = require('./verify-entitlements.cjs');

// We extract per key rather than `plutil -convert json` on the whole plist, because that conversion
// errors on any <data>/<date> value elsewhere in the plist. `plutil` is always present on macOS and
// handles both XML and binary plists.

/**
 * Extract a dictionary/array Info.plist key as parsed JSON via `plutil -extract … json`. Returns
 * undefined if the key is absent (plutil exits non-zero).
 */
function extractPlistContainerAsJson(infoPlistPath, key) {
  let json;
  try {
    json = execFileSync('plutil', ['-extract', key, 'json', '-o', '-', infoPlistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  return JSON.parse(json);
}

/**
 * Extract a scalar STRING Info.plist key via `plutil -extract … raw` — the `json` format rejects a
 * top-level scalar ("invalid object in plist for JSON format"). Returns the trimmed string, or
 * undefined if the key is absent.
 */
function extractPlistString(infoPlistPath, key) {
  let raw;
  try {
    raw = execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  return raw.trim();
}

function main() {
  const appBundlePath = process.argv[2] ? path.resolve(process.argv[2]) : findPackagedMacAppBundle();
  const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  console.log(`verify-ats: inspecting ${infoPlistPath}`);

  const ats = extractPlistContainerAsJson(infoPlistPath, 'NSAppTransportSecurity');
  console.log(`  NSAppTransportSecurity: ${JSON.stringify(ats)}`);

  const failures = [];

  // 1. No global arbitrary-loads / weak-TLS anywhere (the SCR-009 finding), at any nesting depth.
  failures.push(...collectAtsViolations(ats));

  // 2. The ATS dict is EXACTLY the reviewed value — catches both a missing NSAllowsLocalNetworking
  // (which would break the Squirrel.Mac updater's loopback install) and any unexpected extra ATS key.
  if (!util.isDeepStrictEqual(ats, EXPECTED_ATS_DICT)) {
    failures.push(
      `NSAppTransportSecurity is ${JSON.stringify(ats)} but expected ${JSON.stringify(EXPECTED_ATS_DICT)} ` +
        '(scripts/expected-ats.cjs).',
    );
  }

  // 3. Converting extendInfo to map form is also what makes these non-ATS keys take effect, so guard
  // that they actually landed in the packaged plist.
  for (const { key, whyItMatters } of REQUIRED_INFO_PLIST_KEYS) {
    const value = extractPlistString(infoPlistPath, key);
    if (typeof value !== 'string' || value.length === 0) {
      failures.push(`Info.plist is missing required key ${key}. ${whyItMatters}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nverify-ats: ${failures.length} problem(s) in ${infoPlistPath}:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      '\nCheck mac.extendInfo.NSAppTransportSecurity in electron-builder.yml against ' +
        'scripts/expected-ats.cjs (SCR-009 / DEV-11004).',
    );
    process.exit(1);
  }

  console.log('verify-ats: OK — ATS enforced (no arbitrary loads / weak TLS), updater loopback preserved.');
}

// Only auto-run when invoked directly; when required by a unit test we just want the exported helper.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`verify-ats: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { extractPlistContainerAsJson, extractPlistString };
