/**
 * electron-builder afterPack hook.
 *
 * Copies the architecture-specific scratchmd CLI binary AND the
 * scratchmd-native cdylib (slice H of DEV-10144) into the packaged app's
 * resources/bin/ directory so the desktop ships with both bundled and never
 * falls back to a system-installed binary or a stale dev-machine .node.
 *
 * Expected source layout (populated by CI .build_cli_for_desktop or by the
 * local build_mac_*.sh scripts):
 *   scratch-git-2/cli-binaries/<rust-target>/scratchmd
 *   scratch-git-2/cli-binaries/<rust-target>/scratchmd-native.<platform>-<arch>[-<abi>].node
 *
 * Windows napi IS built and bundled now. The addon targets MSVC (napi-rs's
 * gnu path needs a libnode.dll Electron doesn't ship; MSVC is the right ABI for
 * Electron anyway) — built natively by build-win.cjs locally, and cross-built
 * with cargo-xwin in CI (.gitlab-ci-release.yml). It still lives in the
 * windows-GNU cli-binaries dir because this dir is keyed on the CLI's rust
 * target; the loader only matches on the win32-x64 filename, not the compiler.
 * If a future platform/arch lacks a napi build, nativeFilenameFor() returns
 * null and the copy is skipped with a warning (cell-edit IPC then throws there).
 *
 * DO NOT modify app.asar from this hook. Packaged builds enable the
 * `enableEmbeddedAsarIntegrityValidation` fuse (see electron-builder.yml), and
 * electron-builder computes the app.asar header hash BEFORE this hook runs — it is
 * already baked into Info.plist (macOS) / the .exe resources (Windows) by the time
 * we get here. Editing the archive afterwards makes the packaged app refuse to
 * start. Adding files elsewhere under Resources/ (as this hook does for bin/ and
 * git/) is not covered by the hash and is fine.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EXPECTED_ATS_DICT } = require('./expected-ats.cjs');

// electron-builder Arch enum: 0 = ia32, 1 = x64, 2 = armv7l, 3 = arm64, 4 = universal
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

const TARGET_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-gnu',
};

// Filename of the napi cdylib as the desktop's loader expects it
// (scratch-desktop/src/main/native/scratchmd-native.ts::nativeBinaryFilename).
// Returns null when napi isn't supported on this platform yet.
function nativeFilenameFor(platform, arch) {
  if (platform === 'darwin') return `scratchmd-native.darwin-${arch}.node`;
  if (platform === 'linux' && arch === 'x64') return `scratchmd-native.linux-x64-gnu.node`;
  if (platform === 'win32' && arch === 'x64') return `scratchmd-native.win32-x64.node`;
  return null;
}

// Read a container (dict/array) Info.plist key as parsed JSON via `plutil -extract … json`. Returns
// undefined if the key is absent (plutil exits non-zero). Mirrors verify-ats.cjs's extractor — we go
// per-key rather than converting the whole plist, because a whole-plist `-convert json` errors on any
// <data>/<date> value elsewhere in the file.
function readPlistContainerKeyAsJson(infoPlistPath, key) {
  try {
    const json = execFileSync('plutil', ['-extract', key, 'json', '-o', '-', infoPlistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// Normalize the packaged macOS Info.plist's App Transport Security back to the canonical, reviewed
// posture (Oneleet SCR-009 / DEV-11004). electron-builder's configureLocalhostAts() unconditionally
// re-injects NSAllowsArbitraryLoads:true plus weak-TLS (TLS 1.0) NSExceptionDomains for
// localhost/127.0.0.1 — for the Squirrel.Mac updater's cleartext loopback proxy — AFTER our
// electron-builder.yml mac.extendInfo merge, so the shipped plist would otherwise carry the exact global
// ATS kill-switch the remediation removed. (On macOS 11+ NSAllowsArbitraryLoads is ignored while
// NSAllowsLocalNetworking is present, so those injected keys are redundant at runtime — but they still
// fail the literal-plist audit gate and shouldn't ship.) This hook runs after the plist is written and
// immediately BEFORE code signing, so the signature covers the corrected plist and scripts/verify-ats.cjs
// passes. We rewrite ONLY the NSAppTransportSecurity key via targeted plutil — ElectronAsarIntegrity and
// every other key (and app.asar itself) are left untouched. EXPECTED_ATS_DICT is the single source of
// truth shared with the verifier, so the hook and the gate can never drift.
function normalizeMacAppTransportSecurityInPlist(infoPlistPath) {
  if (!fs.existsSync(infoPlistPath)) {
    throw new Error(`afterPack: Info.plist not found at ${infoPlistPath}; cannot normalize App Transport Security.`);
  }
  const before = readPlistContainerKeyAsJson(infoPlistPath, 'NSAppTransportSecurity');
  // -remove tolerates an absent key (exits non-zero); ignore that so the -insert below always runs.
  try {
    execFileSync('plutil', ['-remove', 'NSAppTransportSecurity', infoPlistPath], { stdio: 'ignore' });
  } catch {
    // key absent — fine, we insert it fresh below
  }
  execFileSync(
    'plutil',
    ['-insert', 'NSAppTransportSecurity', '-json', JSON.stringify(EXPECTED_ATS_DICT), infoPlistPath],
    {
      stdio: 'ignore',
    },
  );
  console.log(
    `afterPack: normalized NSAppTransportSecurity in ${infoPlistPath}\n` +
      `  before: ${JSON.stringify(before)}\n` +
      `  after:  ${JSON.stringify(EXPECTED_ATS_DICT)}`,
  );
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin', 'linux', 'win32'
  const arch = ARCH_NAMES[context.arch] || String(context.arch);
  const key = `${platform}-${arch}`;
  const rustTarget = TARGET_MAP[key];

  if (!rustTarget) {
    throw new Error(`afterPack: no CLI binary mapping for platform/arch "${key}"`);
  }

  const cliBinariesDir = path.resolve(__dirname, '..', '..', 'scratch-git-2', 'cli-binaries', rustTarget);
  const binaryName = platform === 'win32' ? 'scratchmd.exe' : 'scratchmd';
  const srcBinary = path.join(cliBinariesDir, binaryName);

  if (!fs.existsSync(srcBinary)) {
    throw new Error(
      `afterPack: CLI binary not found at ${srcBinary}.\n` +
        'In CI this is provided by the build-cli-for-desktop job artifacts.\n' +
        'For local builds, run:\n' +
        `  cd scratch-git-2 && cargo zigbuild --release --bin scratchmd --target ${rustTarget}\n` +
        `  mkdir -p cli-binaries/${rustTarget}\n` +
        `  cp target/${rustTarget}/release/scratchmd cli-binaries/${rustTarget}/scratchmd`,
    );
  }

  // electron-builder's afterPack context:
  //   macOS:  context.appOutDir = "dist/mac-arm64", app at "dist/mac-arm64/Scratch.app"
  //   Linux:  context.appOutDir = "dist/linux-unpacked"
  //
  // At runtime, Electron's process.resourcesPath resolves to:
  //   macOS:  <app>.app/Contents/Resources
  //   Linux:  <unpacked>/resources
  let resourcesDir;
  if (platform === 'darwin') {
    // Find the .app bundle inside appOutDir
    const appName = context.packager.appInfo.productFilename + '.app';
    resourcesDir = path.join(context.appOutDir, appName, 'Contents', 'Resources');
    // Undo electron-builder's re-introduction of the SCR-009 ATS kill-switch before signing seals it.
    normalizeMacAppTransportSecurityInPlist(path.join(context.appOutDir, appName, 'Contents', 'Info.plist'));
  } else {
    resourcesDir = path.join(context.appOutDir, 'resources');
  }

  const destDir = path.join(resourcesDir, 'bin');
  const destBinary = path.join(destDir, binaryName);

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcBinary, destBinary);
  fs.chmodSync(destBinary, 0o755);
  console.log(`afterPack: bundled ${srcBinary} → ${destBinary}`);

  // scratchmd-native cdylib — slice H.4. On platforms where we don't ship a
  // napi build yet (currently win32), the desktop's local cell-edit handlers
  // throw at runtime with "scratchmd-native binary not found" — a regression
  // ticket for that case, not a packaging failure here.
  const nativeFilename = nativeFilenameFor(platform, arch);
  if (!nativeFilename) {
    console.warn(`afterPack: napi cdylib not supported on ${key}; cell-edit IPC will fail at runtime.`);
  } else {
    const srcNative = path.join(cliBinariesDir, nativeFilename);
    if (!fs.existsSync(srcNative)) {
      throw new Error(
        `afterPack: native addon not found at ${srcNative}.\n` +
          'In CI this is provided by the build-cli-for-desktop job artifacts (slice H.4).\n' +
          'For local builds, run:\n' +
          `  cd scratch-git-2 && cargo zigbuild --release -p scratchmd-native --target ${rustTarget}\n` +
          `  cp target/${rustTarget}/release/libscratchmd_native.${platform === 'darwin' ? 'dylib' : 'so'} \\\n` +
          `     cli-binaries/${rustTarget}/${nativeFilename}`,
      );
    }
    const destNative = path.join(destDir, nativeFilename);
    fs.copyFileSync(srcNative, destNative);
    fs.chmodSync(destNative, 0o755);
    console.log(`afterPack: bundled ${srcNative} → ${destNative}`);
  }

  // Bundled git binary (DEV-10196). Lets non-dev macOS users run the app
  // without installing Xcode CLT / accepting Apple's developer license.
  // The dugite-native tree is fetched by scripts/download-git.cjs into
  // scratch-desktop/.git-bundle/<platform-arch>/.
  //
  // Layouts differ between platforms (dugite mirrors what each OS ships):
  //   macOS: flat unix tree — bin/git + libexec/git-core + share/git-core
  //   win32: full Git-for-Windows tree — mingw64/bin/git.exe +
  //          mingw64/libexec/git-core, plus a sibling `usr/` of bash/curl/ssh
  //          deps git.exe invokes for some commands. We keep the layout as-is
  //          and point SCRATCH_GIT_BIN at mingw64/bin/git.exe in the desktop
  //          spawn helper (src/main/scratchmd.ts). The Rust wrapper's
  //          `derive_exec_path` (<git_bin>/../../libexec/git-core) lands on the
  //          mingw64 libexec naturally because git.exe lives two dirs deep.
  //
  // Linux: skipped per DEV-10196 scope (package managers cover that audience).
  if (platform === 'linux') {
    console.log(`afterPack: skipping bundled git for ${key} (linux uses system git).`);
    return;
  }
  const isWin = platform === 'win32';
  const gitBinRel = isWin ? path.join('mingw64', 'bin', 'git.exe') : path.join('bin', 'git');
  const gitBundleSrc = path.resolve(__dirname, '..', '.git-bundle', key);
  if (!fs.existsSync(path.join(gitBundleSrc, gitBinRel))) {
    throw new Error(
      `afterPack: bundled git not found at ${path.join(gitBundleSrc, gitBinRel)}.\n` +
        `Run \`node scripts/download-git.cjs ${key}\` (or \`--all\`) to fetch the dugite-native tarball before packaging.`,
    );
  }
  const gitBundleDest = path.join(resourcesDir, 'git');
  copyTreeRecursive(gitBundleSrc, gitBundleDest, prunePatternsFor(platform));
  fs.chmodSync(path.join(gitBundleDest, gitBinRel), 0o755);
  console.log(`afterPack: bundled git from ${gitBundleSrc} → ${gitBundleDest}`);
};

// Prune dugite-native components Scratch doesn't use. Patterns are matched
// against the basename of each entry, so they apply at any depth in the tree.
//
// macOS-only patterns target the .NET / Avalonia bundle dugite ships for the
// Git Credential Manager (~135 MB). Scratch authenticates via
// `http.extraHeader=Authorization: API-Token ...` in scratch-git-2/src/cli/
// git_ops/remote.rs, so the GCM and its runtime are dead weight. We also drop
// git-lfs and scalar everywhere (Scratch repos don't use either).
//
// On Windows we deliberately do NOT strip *.dll — Git-for-Windows depends on a
// long list of legit DLLs in mingw64/bin/ (libgit-pcre2, libcurl-4, libssl-3,
// zlib, …). The win-specific GCM/LFS executables are caught by the name list.
function prunePatternsFor(platform) {
  const common = [
    /^\.dugite-version$/,
    /^git-credential-manager(-ui|-core)?(\.exe)?$/i,
    /^git-lfs(\.exe)?$/i,
    /^scalar(\.exe)?$/i,
    /\.pdb$/i,
  ];
  if (platform === 'darwin') {
    return [
      ...common,
      // Every System.*.dll + Avalonia.*.dll shipped for the .NET GCM.
      /\.dll$/i,
      /^lib(coreclr|clrjit|hostpolicy|hostfxr|nethost|mscordaccore|HarfBuzzSharp|SkiaSharp)\.(dylib|so)$/i,
    ];
  }
  return common;
}

function copyTreeRecursive(srcDir, destDir, skipNames = []) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.some((re) => re.test(entry.name))) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeRecursive(src, dest, skipNames);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      fs.symlinkSync(link, dest);
    } else {
      fs.copyFileSync(src, dest);
      const mode = fs.statSync(src).mode;
      fs.chmodSync(dest, mode);
    }
  }
}
