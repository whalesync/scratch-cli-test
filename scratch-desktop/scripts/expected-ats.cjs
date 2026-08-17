/**
 * Single source of truth for the macOS App Transport Security posture of packaged Scratch builds
 * (Oneleet pentest finding SCR-009 / DEV-11004).
 *
 * Three places consume this (mirrors expected-entitlements.cjs / expected-fuses.cjs):
 *   - electron-builder.yml mac.extendInfo.NSAppTransportSecurity is what actually ships.
 *   - src/main/__tests__/ats.spec.ts asserts that declaration matches this file, so a config edit
 *     that re-introduces NSAllowsArbitraryLoads (or a weak-TLS exception) fails `yarn test`.
 *   - scripts/verify-ats.cjs reads the REAL packaged Info.plist and asserts it matches this file, so
 *     a packaging regression fails the release job before the artifact is published.
 *
 * Background: stock Electron ships Info.plist with NSAppTransportSecurity={NSAllowsArbitraryLoads:
 * true}, globally disabling ATS so the app can make cleartext HTTP to any host. The ONLY ATS-governed
 * traffic in the app is the Squirrel.Mac auto-updater's cleartext loopback proxy
 * (http://127.0.0.1:<random port>); NSAllowsLocalNetworking keeps that path open while enforcing
 * HTTPS + TLS>=1.2 for every public host. Everything else (Scratch API, PostHog, external links,
 * scratchmd) is Chromium/Node/Rust, not NSURLSession, so ATS does not apply to it.
 */

// ─── THE canonical value — the ONE place to change ──────────────────────────────────────────────
// If the empirical auto-update probe shows NSAllowsLocalNetworking does not reliably permit cleartext
// to the numeric literal 127.0.0.1 on a supported macOS version, swap this for a scoped exception,
// e.g. { NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true,
// NSIncludesSubdomains: false } } } (and patch electron-updater to use the `localhost` hostname).
// The spec and verifier both derive from this constant, so nothing else needs to change.
const EXPECTED_ATS_DICT = {
  NSAllowsLocalNetworking: true,
};

// Global ATS kill-switches that must be ABSENT or false, at any nesting depth. Presence-as-true is a
// release blocker, not a preference. (A per-domain NSExceptionAllowsInsecureHTTPLoads scoped to a
// single loopback host is NOT here — that is the narrowly-scoped exception the remediation permits.)
const ATS_FORBIDDEN_FLAGS = [
  {
    key: 'NSAllowsArbitraryLoads',
    whyItMatters: 'Globally disables ATS — the SCR-009 finding. Enforce HTTPS by default instead.',
  },
  {
    key: 'NSAllowsArbitraryLoadsInWebContent',
    whyItMatters: 'Disables ATS for WKWebView content; unneeded (the renderer is Chromium, not NSURLSession).',
  },
  {
    key: 'NSAllowsArbitraryLoadsForMedia',
    whyItMatters: 'Disables ATS for AVFoundation media loads; unused by the app.',
  },
];

// A *MinimumTLSVersion key set to any of these (top-level or nested inside NSExceptionDomains) is a
// downgrade below TLS 1.2 and a release blocker.
const TLS_VERSION_KEYS = ['NSExceptionMinimumTLSVersion', 'NSTemporaryExceptionMinimumTLSVersion'];
const FORBIDDEN_TLS_VERSIONS = ['TLSv1.0', 'TLSv1.1'];

// Non-ATS Info.plist keys the extendInfo map-form change must NOT drop. Converting extendInfo from
// list to map form is also what makes this key actually take effect (a YAML list assigns an index-"0"
// key and drops the string), so the guard keeps it from silently regressing again.
const REQUIRED_INFO_PLIST_KEYS = [
  {
    key: 'NSDocumentsFolderUsageDescription',
    whyItMatters: 'macOS TCC prompt string for Documents-folder access; regresses to a generic prompt if dropped.',
  },
];

/**
 * Shared validator: given a parsed NSAppTransportSecurity dict (from YAML for the config test, or
 * from `plutil -convert json` for the packaged binary), return human-readable violation strings.
 * An empty array means compliant. Both consumers call this so config and binary apply identical
 * rules, and the spec self-applies it to EXPECTED_ATS_DICT so the source of truth itself can't go
 * dangerous. It recurses so it still guards a nested NSExceptionDomains entry if the canonical value
 * ever gains one.
 */
function collectAtsViolations(atsDict) {
  if (atsDict == null || typeof atsDict !== 'object' || Array.isArray(atsDict)) {
    return ['NSAppTransportSecurity is missing or not a dictionary'];
  }
  const violations = [];
  const walk = (node, pathLabel) => {
    if (node == null || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = pathLabel ? `${pathLabel}.${key}` : key;
      const forbidden = ATS_FORBIDDEN_FLAGS.find((flag) => flag.key === key);
      if (forbidden && value === true) {
        violations.push(`${here} must not be true. ${forbidden.whyItMatters}`);
      }
      if (TLS_VERSION_KEYS.includes(key) && FORBIDDEN_TLS_VERSIONS.includes(value)) {
        violations.push(`${here} is ${value}; TLS below 1.2 is forbidden (SCR-009 / DEV-11004).`);
      }
      if (value && typeof value === 'object') {
        walk(value, here);
      }
    }
  };
  walk(atsDict, 'NSAppTransportSecurity');
  return violations;
}

module.exports = {
  EXPECTED_ATS_DICT,
  ATS_FORBIDDEN_FLAGS,
  TLS_VERSION_KEYS,
  FORBIDDEN_TLS_VERSIONS,
  REQUIRED_INFO_PLIST_KEYS,
  collectAtsViolations,
};
