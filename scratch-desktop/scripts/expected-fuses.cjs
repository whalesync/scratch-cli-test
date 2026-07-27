/**
 * Single source of truth for the Electron fuse posture of packaged Scratch builds
 * (DEV-11000 / Oneleet pentest finding SCR-005).
 *
 * Three places consume this:
 *   - electron-builder.yml's `electronFuses` block is what actually flips the fuses.
 *   - src/main/__tests__/electron-fuses.spec.ts asserts that block matches this file,
 *     so a config edit that loosens a fuse fails `yarn test`.
 *   - scripts/verify-fuses.cjs reads the real fuse wire out of a packaged binary and
 *     asserts it matches this file, so a packaging regression fails the release job.
 *
 * Keys are electron-builder's camelCase fuse names; `electronFuseName` is the
 * corresponding `FuseV1Options` member in @electron/fuses (used to index the wire).
 */

/**
 * Fuses whose value is a security control. `expectedValue` is what a packaged build
 * MUST have; anything else is a release blocker, not a preference.
 */
const SECURITY_CRITICAL_FUSES = [
  {
    electronBuilderName: 'runAsNode',
    electronFuseName: 'RunAsNode',
    expectedValue: false,
    whyItMatters:
      'ELECTRON_RUN_AS_NODE=1 would turn the signed+notarized Scratch binary into a general-purpose node interpreter, letting local malware run arbitrary code under our code signature.',
  },
  {
    electronBuilderName: 'enableNodeOptionsEnvironmentVariable',
    electronFuseName: 'EnableNodeOptionsEnvironmentVariable',
    expectedValue: false,
    whyItMatters: 'NODE_OPTIONS / NODE_EXTRA_CA_CERTS are unused by the app and are a code-injection vector.',
  },
  {
    electronBuilderName: 'enableNodeCliInspectArguments',
    electronFuseName: 'EnableNodeCliInspectArguments',
    expectedValue: false,
    whyItMatters: '--inspect / --inspect-brk / SIGUSR1 would expose a debugger with full main-process privileges.',
  },
  {
    electronBuilderName: 'enableEmbeddedAsarIntegrityValidation',
    electronFuseName: 'EnableEmbeddedAsarIntegrityValidation',
    expectedValue: true,
    whyItMatters: 'Without it, the app.asar hash electron-builder already embeds is recorded but never enforced.',
  },
  {
    electronBuilderName: 'onlyLoadAppFromAsar',
    electronFuseName: 'OnlyLoadAppFromAsar',
    expectedValue: true,
    whyItMatters:
      'Without it, dropping an unsigned `app/` directory beside app.asar sidesteps the integrity check entirely.',
  },
  {
    electronBuilderName: 'enableCookieEncryption',
    electronFuseName: 'EnableCookieEncryption',
    expectedValue: true,
    whyItMatters: 'Encrypts the cookie store at rest with the OS keychain/keyring.',
  },
];

/**
 * Fuses deliberately left at Electron's own default. Listed explicitly so the packaged
 * app's full posture is readable in one place and a change to either is a conscious edit.
 */
const FUSES_PINNED_TO_ELECTRON_DEFAULTS = [
  {
    electronBuilderName: 'grantFileProtocolExtraPrivileges',
    electronFuseName: 'GrantFileProtocolExtraPrivileges',
    expectedValue: true,
    whyItMatters:
      'The packaged renderer is a file:// page (mainWindow.loadFile), so revoking file:// privileges needs a custom-protocol migration first.',
  },
  {
    electronBuilderName: 'loadBrowserProcessSpecificV8Snapshot',
    electronFuseName: 'LoadBrowserProcessSpecificV8Snapshot',
    expectedValue: false,
    whyItMatters: 'Not a security fuse — only relevant when shipping a custom browser-process V8 snapshot.',
  },
];

const ALL_EXPECTED_FUSES = [...SECURITY_CRITICAL_FUSES, ...FUSES_PINNED_TO_ELECTRON_DEFAULTS];

module.exports = { SECURITY_CRITICAL_FUSES, FUSES_PINNED_TO_ELECTRON_DEFAULTS, ALL_EXPECTED_FUSES };
