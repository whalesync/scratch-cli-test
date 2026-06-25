import { BadRequestException } from '@nestjs/common';
import {
  SCRATCH_MAX_FILE_BYTES,
  validateScratchFileSize,
  validateScratchRelativePath,
  validateScratchSegmentName,
} from '../scratch-path-validation';

describe('validateScratchSegmentName', () => {
  it.each([
    'Notes',
    'post.md',
    'My Folder',
    'file-name_1.csv',
    '2026 Q1 status',
    'a'.repeat(255),
    'résumé.txt',
    'tracker (final)',
  ])('accepts valid name %p', (name) => {
    expect(() => validateScratchSegmentName(name)).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace-only'],
    ['.', 'dot (traversal)'],
    ['..', 'dot-dot (traversal)'],
    ['.env', 'leading dot / dotfile'],
    ['.git', 'reserved dotfile'],
    ['.gitkeep', 'placeholder name'],
    ['a/b', 'embedded slash'],
    ['a<b', 'illegal char <'],
    ['a:b', 'illegal char :'],
    ['a"b', 'illegal char "'],
    ['a|b', 'illegal char |'],
    ['a?b', 'illegal char ?'],
    ['a*b', 'illegal char *'],
    ['a\\b', 'illegal char backslash'],
    ['a\u0001b', 'embedded control char'],
    ['name ', 'trailing space'],
    ['name.', 'trailing period'],
    ['CON', 'windows reserved CON'],
    ['con.txt', 'windows reserved with extension'],
    ['NUL', 'windows reserved NUL'],
    ['lpt1', 'windows reserved LPT1'],
    ['a'.repeat(256), 'too long'],
    // 100 CJK chars = 100 UTF-16 code units (passes a naive `.length` check) but 300 UTF-8 bytes,
    // which exceeds the 255-byte filesystem limit and would fail a desktop `git clone` (DEV-10424).
    ['中'.repeat(100), 'multi-byte name exceeding 255 UTF-8 bytes'],
  ])('rejects %p (%s)', (name) => {
    expect(() => validateScratchSegmentName(name)).toThrow(BadRequestException);
  });
});

describe('validateScratchRelativePath', () => {
  it('accepts a nested relative path and returns its segments', () => {
    expect(validateScratchRelativePath('Notes/Drafts/post.md')).toEqual(['Notes', 'Drafts', 'post.md']);
  });

  it.each([
    ['', 'empty'],
    ['/Notes', 'absolute path'],
    ['Notes/../secret', 'traversal segment'],
    ['Notes//post.md', 'empty middle segment'],
    ['Notes/.hidden/post.md', 'dotfile segment'],
  ])('rejects %p (%s)', (path) => {
    expect(() => validateScratchRelativePath(path)).toThrow(BadRequestException);
  });
});

describe('validateScratchFileSize', () => {
  it('accepts content within the cap', () => {
    expect(() => validateScratchFileSize('hello world')).not.toThrow();
    expect(() => validateScratchFileSize('')).not.toThrow();
  });

  it('rejects content over the cap', () => {
    const tooBig = 'a'.repeat(SCRATCH_MAX_FILE_BYTES + 1);
    expect(() => validateScratchFileSize(tooBig)).toThrow(BadRequestException);
  });

  it('counts bytes, not characters (multi-byte UTF-8)', () => {
    // A 4-byte emoji repeated just past the byte cap must be rejected even though the character
    // count is a quarter of the limit.
    const emoji = '😀';
    const count = Math.floor(SCRATCH_MAX_FILE_BYTES / 4) + 1;
    expect(() => validateScratchFileSize(emoji.repeat(count))).toThrow(BadRequestException);
  });
});
