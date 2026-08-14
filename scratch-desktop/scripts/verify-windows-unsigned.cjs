#!/usr/bin/env node
/**
 * Post-packaging gate: fail if any shipped Windows .exe carries an Authenticode
 * signature (DEV-11010 / Oneleet SCR-015).
 *
 * Usage (from scratch-desktop/):
 *   node scripts/verify-windows-unsigned.cjs
 *
 * Why this exists: electron-builder resolves the Windows signing certificate as
 * WIN_CSC_LINK and *falls back to the cross-platform CSC_LINK*, which in our pipeline
 * holds the Apple Developer ID .p12 (the mac signing cert). If that cert is ambient when
 * `electron-builder --win` runs, the .exe gets Authenticode-signed with an Apple cert
 * whose CA chain is not trusted on Windows. app-builder-lib then bakes that Apple CN into
 * app-update.yml as the expected publisherName, and electron-updater rejects every future
 * update with ERR_UPDATER_INVALID_SIGNATURE — Windows auto-update dies (the pen-test finding).
 *
 * Until real Authenticode signing lands (see
 * docs/plans/2026-05-30-sign-windows-desktop-builds/), the Windows build ships intentionally
 * UNSIGNED: the build scripts strip every *CSC* var, and this gate proves the shipped
 * artifacts actually carry no signature so a leaked cert can never regress auto-update again.
 *
 * When SSL.com signing lands, flip this gate to assert the .exe IS signed by the expected
 * Whalesync publisher (this is the natural home for that check).
 *
 * Called by scripts/package.sh (windows) and scripts/build-win.cjs. To inspect a file by hand
 * on any OS: `osslsigncode verify <file>` (or PowerShell `Get-AuthenticodeSignature` on Windows).
 */

const fs = require('fs');
const path = require('path');

const desktopPackageDir = path.resolve(__dirname, '..');
const distDir = path.join(desktopPackageDir, 'dist');

// Index of the Attribute Certificate Table in the PE optional header's data directory. A
// non-empty entry here (Size > 0) means the file carries an embedded Authenticode signature;
// an unsigned PE has this entry zeroed. This is the same field signtool/osslsigncode key off.
const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;
const PE_OPTIONAL_HEADER_MAGIC_PE32 = 0x10b;
const PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b;

/**
 * Read the Security data directory (VirtualAddress + Size) out of a PE/COFF (.exe) buffer.
 * Pure parsing, no filesystem — the unit test drives this with synthetic buffers. Throws with a
 * clear message if the buffer is not a well-formed PE (better to fail loudly than to pass a file
 * we could not actually inspect).
 */
function readPeSecurityDirectory(buffer) {
  // DOS header: must start with 'MZ'; e_lfanew (offset to the PE header) lives at 0x3C.
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('not a PE image (missing MZ signature)');
  }
  const peHeaderOffset = buffer.readUInt32LE(0x3c);
  // PE signature 'PE\0\0' followed by the 20-byte COFF file header, then the optional header.
  if (peHeaderOffset + 24 > buffer.length || buffer.readUInt32LE(peHeaderOffset) !== 0x00004550) {
    throw new Error('not a PE image (missing PE\\0\\0 signature)');
  }
  const optionalHeaderOffset = peHeaderOffset + 24;
  if (optionalHeaderOffset + 2 > buffer.length) {
    throw new Error('truncated PE optional header');
  }
  const optionalHeaderMagic = buffer.readUInt16LE(optionalHeaderOffset);

  // The data-directory array sits at a magic-dependent offset within the optional header, right
  // after the 4-byte NumberOfRvaAndSizes count. PE32 and PE32+ differ only by the size of a few
  // fields before that point.
  let numberOfRvaAndSizesOffset;
  let dataDirectoriesOffset;
  if (optionalHeaderMagic === PE_OPTIONAL_HEADER_MAGIC_PE32) {
    numberOfRvaAndSizesOffset = optionalHeaderOffset + 92;
    dataDirectoriesOffset = optionalHeaderOffset + 96;
  } else if (optionalHeaderMagic === PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS) {
    numberOfRvaAndSizesOffset = optionalHeaderOffset + 108;
    dataDirectoriesOffset = optionalHeaderOffset + 112;
  } else {
    throw new Error(`unknown PE optional header magic 0x${optionalHeaderMagic.toString(16)}`);
  }

  if (numberOfRvaAndSizesOffset + 4 > buffer.length) {
    throw new Error('truncated PE optional header (no NumberOfRvaAndSizes)');
  }
  const numberOfRvaAndSizes = buffer.readUInt32LE(numberOfRvaAndSizesOffset);
  // If the image declares fewer data directories than the security slot, there is no certificate
  // table — the file is unsigned.
  if (numberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_SECURITY) {
    return { virtualAddress: 0, size: 0 };
  }

  const securityEntryOffset = dataDirectoriesOffset + IMAGE_DIRECTORY_ENTRY_SECURITY * 8;
  if (securityEntryOffset + 8 > buffer.length) {
    throw new Error('truncated PE data directory (no security entry)');
  }
  return {
    virtualAddress: buffer.readUInt32LE(securityEntryOffset),
    size: buffer.readUInt32LE(securityEntryOffset + 4),
  };
}

/** True if the PE file at `filePath` carries an embedded Authenticode signature. */
function isPortableExecutableSigned(filePath) {
  const { size } = readPeSecurityDirectory(fs.readFileSync(filePath));
  return size > 0;
}

/**
 * Collect the Windows executables whose signature we care about: the NSIS installer(s) that land
 * directly in dist/ (what users download and what electron-updater verifies) and the top-level
 * .exe files in each `dist/win-unpacked` output directory (the app binary + any staged helper such
 * as scratchmd.exe — the ones electron-builder's own signtool step would sign, and whose CN
 * app-builder-lib copies into app-update.yml's publisherName).
 *
 * Deliberately non-recursive under win-unpacked: the bundled dugite git tree under `resources`
 * ships third-party binaries that electron-builder never signs, so descending into it would only
 * invite false positives.
 */
function findShippedWindowsExecutables() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`verify-windows-unsigned: no dist/ directory at ${distDir} — run electron-builder first.`);
  }
  const executablePaths = [];

  // Top-level installers, e.g. dist/Scratch-1.2.3-x64.exe (or "Scratch (Test)-…" for test builds).
  for (const entryName of fs.readdirSync(distDir)) {
    if (entryName.toLowerCase().endsWith('.exe')) {
      executablePaths.push(path.join(distDir, entryName));
    }
  }

  // App binary (+ root-level helpers) under each dist/win-unpacked*/ directory.
  const winUnpackedDirs = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('win-unpacked'));
  for (const winUnpackedDir of winUnpackedDirs) {
    const winUnpackedPath = path.join(distDir, winUnpackedDir.name);
    for (const entry of fs.readdirSync(winUnpackedPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
        executablePaths.push(path.join(winUnpackedPath, entry.name));
      }
    }
  }

  return executablePaths;
}

function main() {
  const executablePaths = findShippedWindowsExecutables();
  if (executablePaths.length === 0) {
    throw new Error(
      `verify-windows-unsigned: found no Windows .exe under ${distDir} (or dist/win-unpacked*/) — ` +
        'did electron-builder --win run?',
    );
  }

  const signedExecutablePaths = [];
  for (const executablePath of executablePaths) {
    const signed = isPortableExecutableSigned(executablePath);
    console.log(`  ${signed ? 'FAIL' : 'OK  '} ${path.relative(desktopPackageDir, executablePath)}`);
    if (signed) {
      signedExecutablePaths.push(executablePath);
    }
  }

  if (signedExecutablePaths.length > 0) {
    console.error(
      `\nverify-windows-unsigned: ${signedExecutablePaths.length} Windows executable(s) are Authenticode-signed, ` +
        'but the Windows build must ship UNSIGNED until real signing lands (DEV-11010 / SCR-015):',
    );
    for (const signedExecutablePath of signedExecutablePaths) {
      console.error(`  - ${path.relative(desktopPackageDir, signedExecutablePath)}`);
    }
    console.error(
      '\nMost likely cause: an ambient CSC_LINK/CSC_KEY_PASSWORD (the Apple Developer ID cert) leaked into\n' +
        '`electron-builder --win`. Ensure the Windows build strips CSC_LINK/CSC_KEY_PASSWORD/WIN_CSC_LINK/\n' +
        'WIN_CSC_KEY_PASSWORD (see scripts/package.sh and scripts/build-win.cjs).',
    );
    process.exit(1);
  }

  console.log(`verify-windows-unsigned: all ${executablePaths.length} Windows executable(s) are unsigned, as expected.`);
}

// Only auto-run when invoked directly; when required by a unit test we just want the exported
// helpers, not main()'s process.exit.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`verify-windows-unsigned: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { readPeSecurityDirectory, isPortableExecutableSigned, findShippedWindowsExecutables };
