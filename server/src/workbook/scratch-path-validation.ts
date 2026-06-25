import { BadRequestException } from '@nestjs/common';

/**
 * Shared validation for user-supplied scratch folder/file names and paths (DEV-10424).
 *
 * Scratch names become BOTH git paths and (on desktop) real on-disk paths, so we fail fast at the
 * boundary on anything unsafe or non-portable. These functions are pure/synchronous so every create
 * endpoint can reuse them — web, desktop, and the CLI all route folder/file creates through the
 * server, making this the single enforcement point.
 *
 * This module covers SYNTAX: emptiness, traversal, reserved names, dotfiles, cross-OS-illegal
 * characters, length, and the per-file size cap. UNIQUENESS and collisions with existing
 * connector-folder paths require DB context and are enforced by the calling service.
 */

/** Generous per-file ceiling for text content; blocks accidental repo bloat (e.g. a runaway AI loop). */
export const SCRATCH_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Max length of a single path segment in UTF-8 bytes (matches the common 255-byte filesystem limit). */
const MAX_SEGMENT_LENGTH_BYTES = 255;

/** Windows reserved device names (case-insensitive, with or without an extension). */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

// Characters illegal on Windows/macOS filesystems plus control chars. Forward slash is the path
// separator (handled separately). Spaces and hyphens are allowed INSIDE a name; only a trailing
// space is rejected, below.
// eslint-disable-next-line no-control-regex
const ILLEGAL_SEGMENT_CHARS = /[<>:"\\|?*\u0000-\u001f]/;

/**
 * Validate a single path segment (one folder or file name, no slashes). Throws a 400 with a
 * user-facing message on the first violation.
 */
export function validateScratchSegmentName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new BadRequestException('Name cannot be empty.');
  }
  if (name === '.' || name === '..') {
    throw new BadRequestException('Path traversal is not allowed.');
  }
  // Measure UTF-8 bytes, not UTF-16 code units: a multi-byte name (CJK/emoji) can be well under 255
  // characters yet exceed the 255-byte filesystem limit, failing on a desktop `git clone` to APFS/ext4.
  if (Buffer.byteLength(name, 'utf8') > MAX_SEGMENT_LENGTH_BYTES) {
    throw new BadRequestException(`Name is too long (max ${MAX_SEGMENT_LENGTH_BYTES} bytes).`);
  }
  if (name.includes('/')) {
    throw new BadRequestException('Name cannot contain a slash.');
  }
  if (name.startsWith('.')) {
    // Reserved internal files (.git, .scratch, .gitkeep) plus any dotfile, which the listing layer
    // hides — allowing one would make the user's file silently invisible.
    throw new BadRequestException('Name cannot start with a dot.');
  }
  if (ILLEGAL_SEGMENT_CHARS.test(name)) {
    throw new BadRequestException('Name contains characters that are not allowed.');
  }
  if (/[. ]$/.test(name)) {
    // Windows strips trailing dots/spaces, which would silently rename the file.
    throw new BadRequestException('Name cannot end with a space or a period.');
  }
  const stem = name.split('.')[0].toLowerCase();
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(stem)) {
    throw new BadRequestException(`"${name}" is a reserved name on some systems.`);
  }
}

/**
 * Validate a relative scratch path (e.g. "Notes/Drafts/post.md") and return its normalized
 * segments. Rejects absolute paths, traversal, and empty/reserved segments.
 */
export function validateScratchRelativePath(relativePath: string): string[] {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    throw new BadRequestException('Path cannot be empty.');
  }
  if (relativePath.startsWith('/')) {
    throw new BadRequestException('Path must be relative (no leading slash).');
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    validateScratchSegmentName(segment);
  }
  return segments;
}

/** Reject content larger than the per-file size cap. */
export function validateScratchFileSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > SCRATCH_MAX_FILE_BYTES) {
    throw new BadRequestException(`File is too large (${bytes} bytes; max ${SCRATCH_MAX_FILE_BYTES} bytes).`);
  }
}
