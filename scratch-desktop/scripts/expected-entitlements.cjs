/**
 * Single source of truth for the macOS Hardened Runtime entitlement posture of packaged
 * Scratch builds (Oneleet pentest finding SCR-004 / DEV-10999).
 *
 * Three places consume this:
 *   - build/entitlements.mac.plist (the signed RELEASE profile) and
 *     build/entitlements.mac.adhoc.plist (the DEV-ONLY ad-hoc profile) are the plists
 *     electron-builder actually signs with.
 *   - src/main/__tests__/entitlements.spec.ts asserts those two plists — and the entitlements
 *     wiring in electron-builder.yml / electron-builder.unsigned-mac.yml — match this file, so a
 *     config edit that re-introduces a dangerous entitlement fails `yarn test`.
 *   - scripts/verify-entitlements.cjs reads the REAL entitlements out of the signed .app during
 *     packaging and asserts they match this file, so a packaging/signing regression fails the
 *     release job before the artifact is published.
 *
 * Background: the signed, notarized Scratch.app had shipped with two Hardened Runtime exceptions
 * (disable-library-validation + allow-dyld-environment-variables) that let a local attacker inject
 * a dylib via DYLD_INSERT_LIBRARIES into the trusted, TCC-privileged, token-holding process.
 * Neither is used by the production app; both are removed from the signed release here.
 */

/**
 * Entitlements that MUST NOT appear in the signed RELEASE profile or the packaged release binary.
 * Presence of any of these is a release blocker, not a preference.
 */
const RELEASE_FORBIDDEN_ENTITLEMENTS = [
  {
    key: 'com.apple.security.cs.disable-library-validation',
    whyItMatters:
      'Lets the process load dylibs not signed by our Team ID. Unneeded in a Developer ID build (all nested Mach-O, including the scratchmd-native.node addon, is signed with our Team ID, so library validation passes) and a primary dylib-injection vector. Kept only in the dev-only ad-hoc profile.',
  },
  {
    key: 'com.apple.security.cs.allow-dyld-environment-variables',
    whyItMatters:
      'Honors DYLD_* env vars (e.g. DYLD_INSERT_LIBRARIES) — the classic dylib-injection lever. The app never reads DYLD_* vars, so it is pure attack surface. Removed everywhere, dev and prod.',
  },
];

/**
 * Entitlements that MUST be present in BOTH profiles. allow-jit / allow-unsigned-executable-memory
 * are required by the Chromium/V8 runtime Electron embeds; the other two are the app's own sandbox
 * needs. Removing any would break the app, so a MISSING required entitlement is also a blocker.
 */
const RELEASE_REQUIRED_ENTITLEMENTS = [
  {
    key: 'com.apple.security.cs.allow-jit',
    whyItMatters: 'Chromium/V8 JIT-compiles JavaScript; without it the renderer crashes on launch.',
  },
  {
    key: 'com.apple.security.cs.allow-unsigned-executable-memory',
    whyItMatters: 'Required by the V8/Node runtime Electron embeds; without it the app fails to start.',
  },
  {
    key: 'com.apple.security.network.client',
    whyItMatters: 'The app is a network client (Scratch API, GitHub updater, PostHog).',
  },
  {
    key: 'com.apple.security.files.user-selected.read-write',
    whyItMatters: 'The app reads/writes the workspace folders the user picks in the native file dialog.',
  },
];

/**
 * Entitlements the DEV-ONLY ad-hoc profile (build/entitlements.mac.adhoc.plist) adds on top of
 * RELEASE_REQUIRED — and nothing else. Ad-hoc-signed local builds need disable-library-validation
 * to load the app's own frameworks under Hardened Runtime; this exception is confined here and
 * never ships. Every RELEASE_FORBIDDEN key that is NOT listed here must also be absent from the
 * ad-hoc profile (i.e. allow-dyld-environment-variables stays out everywhere).
 */
const ADHOC_EXTRA_ENTITLEMENTS = [
  {
    key: 'com.apple.security.cs.disable-library-validation',
    whyItMatters:
      'Ad-hoc signatures have no Team ID, so Hardened Runtime library validation would reject the app’s own Electron frameworks. Dev-only; never in the signed release.',
  },
];

module.exports = {
  RELEASE_FORBIDDEN_ENTITLEMENTS,
  RELEASE_REQUIRED_ENTITLEMENTS,
  ADHOC_EXTRA_ENTITLEMENTS,
};
