#!/usr/bin/env node
/**
 * Download + extract dugite-native prebuilt git tarballs for desktop bundling.
 *
 * DEV-10196: the desktop app ships its own git binary so non-dev macOS users
 * don't need Xcode CLT installed. dugite-native is the GitHub Desktop team's
 * prebuilt git distribution — stripped, code-signed (mac), kept current.
 *
 * Usage:
 *   node scripts/download-git.cjs                 # current platform/arch
 *   node scripts/download-git.cjs darwin-arm64    # specific target
 *   node scripts/download-git.cjs --all           # all platforms in manifest
 *
 * Idempotent: skips download when the tarball is already cached and extracted.
 * SHA256-verified against scripts/git-bundle-manifest.json.
 *
 * Output layout (consumed by scripts/afterPack.cjs):
 *   scratch-desktop/.git-bundle/<electron-platform>-<electron-arch>/
 *     bin/git
 *     libexec/git-core/...
 *     share/git-core/...
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'git-bundle-manifest.json');
const CACHE_DIR = path.join(ROOT, '.git-bundle-cache');
const OUTPUT_DIR = path.join(ROOT, '.git-bundle');
const PLACEHOLDER_SHA = 'REPLACE_WITH_SHA256_FROM_DUGITE_RELEASE_CHECKSUMS';

function currentTarget() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${process.platform}-${arch}`;
}

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.platforms || typeof parsed.platforms !== 'object') {
    throw new Error('git-bundle-manifest.json: missing "platforms" object');
  }
  return parsed;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const onError = (err) => {
      file.close();
      fs.unlink(dest, () => reject(err));
    };
    const request = (location, redirectsLeft) => {
      https
        .get(location, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            if (redirectsLeft <= 0) return onError(new Error(`too many redirects: ${location}`));
            response.resume();
            return request(response.headers.location, redirectsLeft - 1);
          }
          if (response.statusCode !== 200) {
            response.resume();
            return onError(new Error(`HTTP ${response.statusCode} for ${location}`));
          }
          response.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          response.on('error', onError);
        })
        .on('error', onError);
    };
    request(url, 5);
  });
}

function sha256Of(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function extractTarGz(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // dugite-native tarballs have no top-level dir — entries are bin/git,
  // libexec/git-core/..., share/git-core/... directly at the archive root.
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir]);
}

// Relative-to-bundle path to the git binary + libexec dir for a given target.
//   macOS: flat unix layout — bin/git + libexec/git-core
//   Windows: dugite ships the full Git-for-Windows tree — mingw64/bin/git.exe +
//            mingw64/libexec/git-core, plus a sibling `usr/` tree of bash/curl/
//            ssh deps that git.exe invokes for some commands. Keep the layout
//            as-is; afterPack.cjs and the desktop spawn helper point at the
//            mingw64-prefixed git.exe.
function bundlePaths(target) {
  if (target.startsWith('win32-')) {
    return {
      gitBin: path.join('mingw64', 'bin', 'git.exe'),
      execDir: path.join('mingw64', 'libexec', 'git-core'),
    };
  }
  return { gitBin: path.join('bin', 'git'), execDir: path.join('libexec', 'git-core') };
}

function assertLayout(destDir, target) {
  const { gitBin, execDir } = bundlePaths(target);
  const gitBinAbs = path.join(destDir, gitBin);
  if (!fs.existsSync(gitBinAbs)) {
    throw new Error(`expected git binary not found after extract: ${gitBinAbs}`);
  }
  const execDirAbs = path.join(destDir, execDir);
  if (!fs.existsSync(execDirAbs)) {
    throw new Error(`expected libexec/git-core not found after extract: ${execDirAbs}`);
  }
}

async function fetchTarget(target, manifest) {
  const entry = manifest.platforms[target];
  if (!entry) {
    throw new Error(
      `no manifest entry for target "${target}". Available: ${Object.keys(manifest.platforms).join(', ')}`,
    );
  }
  const destDir = path.join(OUTPUT_DIR, target);
  const markerPath = path.join(destDir, '.dugite-version');
  if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8').trim() === manifest.version) {
    console.log(`[download-git] ${target}: already at ${manifest.version}, skipping`);
    assertLayout(destDir, target);
    return;
  }

  const tarballName = `${target}-${path.basename(entry.url)}`;
  const tarballPath = path.join(CACHE_DIR, tarballName);

  if (!fs.existsSync(tarballPath)) {
    console.log(`[download-git] ${target}: downloading ${entry.url}`);
    await downloadFile(entry.url, tarballPath);
  } else {
    console.log(`[download-git] ${target}: tarball cached at ${tarballPath}`);
  }

  const actual = sha256Of(tarballPath);
  if (entry.sha256 === PLACEHOLDER_SHA) {
    console.warn(
      `[download-git] ${target}: WARNING — manifest sha256 is the placeholder. ` +
        `Actual: ${actual}. Update scripts/git-bundle-manifest.json with this value to ` +
        `enable verification.`,
    );
  } else if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
    fs.unlinkSync(tarballPath);
    throw new Error(
      `[download-git] ${target}: sha256 mismatch.\n  expected: ${entry.sha256}\n  actual:   ${actual}\n` +
        `Re-download or update the manifest.`,
    );
  } else {
    console.log(`[download-git] ${target}: sha256 verified`);
  }

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  extractTarGz(tarballPath, destDir);
  assertLayout(destDir, target);
  fs.writeFileSync(markerPath, manifest.version);
  console.log(`[download-git] ${target}: ready at ${destDir}`);
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = loadManifest();

  let targets;
  if (args.includes('--all')) {
    targets = Object.keys(manifest.platforms);
  } else if (args.length > 0 && !args[0].startsWith('--')) {
    targets = [args[0]];
  } else {
    targets = [currentTarget()];
  }

  for (const target of targets) {
    await fetchTarget(target, manifest);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
