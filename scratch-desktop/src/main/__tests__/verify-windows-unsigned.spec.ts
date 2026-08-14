import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Unit test for the PE-signature parser in scripts/verify-windows-unsigned.cjs
 * (DEV-11010 / Oneleet SCR-015).
 *
 * The release build ships the Windows .exe UNSIGNED (the Apple Developer ID CSC_LINK must not
 * leak into `electron-builder --win`, or electron-updater rejects every Windows update). The
 * packaging gate proves that by reading the Attribute Certificate Table out of each shipped .exe:
 * a non-empty Security data directory (Size > 0) means the file is Authenticode-signed. This test
 * drives that parser with synthetic PE buffers so the gate's core decision is covered without
 * needing a real Windows build.
 */

interface VerifyWindowsUnsignedModule {
  readPeSecurityDirectory: (buffer: Buffer) => { virtualAddress: number; size: number };
  isPortableExecutableSigned: (filePath: string) => boolean;
}

// verify-windows-unsigned.cjs is CommonJS because the release build scripts require it at
// packaging time, where TypeScript isn't available. `yarn test` runs vitest from the
// scratch-desktop package dir, so resolve from cwd (same pattern as verify-fuses.spec.ts).
const desktopPackageDir = process.cwd();
const loadCommonJs = createRequire(path.join(desktopPackageDir, 'vitest.config.mts'));
const { readPeSecurityDirectory, isPortableExecutableSigned } = loadCommonJs(
  path.join(desktopPackageDir, 'scripts', 'verify-windows-unsigned.cjs'),
) as VerifyWindowsUnsignedModule;

const PE_OPTIONAL_HEADER_MAGIC_PE32 = 0x10b;
const PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b;

/**
 * Build a minimal-but-well-formed PE image with a controllable Security data directory
 * (IMAGE_DIRECTORY_ENTRY_SECURITY, index 4). Only the fields the parser reads are populated.
 */
function makePortableExecutable({
  optionalHeaderMagic = PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS,
  numberOfRvaAndSizes = 16,
  securityTableVirtualAddress = 0,
  securityTableSize = 0,
}: {
  optionalHeaderMagic?: number;
  numberOfRvaAndSizes?: number;
  securityTableVirtualAddress?: number;
  securityTableSize?: number;
} = {}): Buffer {
  const peHeaderOffset = 0x80;
  const optionalHeaderOffset = peHeaderOffset + 24;
  const buffer = Buffer.alloc(0x400, 0);
  buffer.writeUInt16LE(0x5a4d, 0); // 'MZ'
  buffer.writeUInt32LE(peHeaderOffset, 0x3c); // e_lfanew
  buffer.writeUInt32LE(0x00004550, peHeaderOffset); // 'PE\0\0'
  buffer.writeUInt16LE(optionalHeaderMagic, optionalHeaderOffset);

  const isPe32 = optionalHeaderMagic === PE_OPTIONAL_HEADER_MAGIC_PE32;
  const numberOfRvaAndSizesOffset = optionalHeaderOffset + (isPe32 ? 92 : 108);
  const dataDirectoriesOffset = optionalHeaderOffset + (isPe32 ? 96 : 112);
  buffer.writeUInt32LE(numberOfRvaAndSizes, numberOfRvaAndSizesOffset);

  const securityEntryOffset = dataDirectoriesOffset + 4 * 8;
  buffer.writeUInt32LE(securityTableVirtualAddress, securityEntryOffset);
  buffer.writeUInt32LE(securityTableSize, securityEntryOffset + 4);
  return buffer;
}

describe('readPeSecurityDirectory', () => {
  it('reports an empty security directory for an unsigned PE32+ image', () => {
    expect(readPeSecurityDirectory(makePortableExecutable({ securityTableSize: 0 }))).toEqual({
      virtualAddress: 0,
      size: 0,
    });
  });

  it('reports the certificate table for a signed PE32+ image', () => {
    expect(
      readPeSecurityDirectory(
        makePortableExecutable({ securityTableVirtualAddress: 0x9000, securityTableSize: 0x1800 }),
      ),
    ).toEqual({ virtualAddress: 0x9000, size: 0x1800 });
  });

  it('handles the 32-bit PE32 optional-header layout (typical for the NSIS installer)', () => {
    expect(
      readPeSecurityDirectory(
        makePortableExecutable({
          optionalHeaderMagic: PE_OPTIONAL_HEADER_MAGIC_PE32,
          securityTableVirtualAddress: 0x1234,
          securityTableSize: 0x56,
        }),
      ),
    ).toEqual({ virtualAddress: 0x1234, size: 0x56 });
  });

  it('treats an image with fewer data directories than the security slot as unsigned', () => {
    expect(readPeSecurityDirectory(makePortableExecutable({ numberOfRvaAndSizes: 4 }))).toEqual({
      virtualAddress: 0,
      size: 0,
    });
  });

  it('throws on a buffer that is not a PE image', () => {
    expect(() => readPeSecurityDirectory(Buffer.from('this is not an executable'))).toThrow(/not a PE image/);
  });

  it('throws on an unknown optional-header magic', () => {
    expect(() => readPeSecurityDirectory(makePortableExecutable({ optionalHeaderMagic: 0x1234 }))).toThrow(
      /unknown PE optional header magic/,
    );
  });
});

describe('isPortableExecutableSigned', () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'verify-windows-unsigned-'));

  it('returns false for an unsigned .exe on disk', () => {
    const unsignedExecutablePath = path.join(scratchDir, 'unsigned.exe');
    writeFileSync(unsignedExecutablePath, makePortableExecutable({ securityTableSize: 0 }));
    expect(isPortableExecutableSigned(unsignedExecutablePath)).toBe(false);
  });

  it('returns true for a signed .exe on disk', () => {
    const signedExecutablePath = path.join(scratchDir, 'signed.exe');
    writeFileSync(
      signedExecutablePath,
      makePortableExecutable({ securityTableVirtualAddress: 0x9000, securityTableSize: 0x1800 }),
    );
    expect(isPortableExecutableSigned(signedExecutablePath)).toBe(true);
  });
});
