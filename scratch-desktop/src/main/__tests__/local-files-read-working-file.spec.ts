import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkingFileObject } from '../local-files';

/**
 * Guards the DEV-9981 fix in `readWorkingFileObject`: a present-but-corrupt working
 * file must fail with a clear error rather than an opaque `Unexpected end of JSON
 * input` — and must NOT degrade to `{}`, because the only caller writes the returned
 * object straight back to disk (returning `{}` would overwrite and destroy the record).
 */
describe('readWorkingFileObject', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scratch-working-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the parsed object for a valid JSON object file', async () => {
    const filePath = join(dir, 'record.json');
    writeFileSync(filePath, JSON.stringify({ id: '1', title: 'Hi' }));
    await expect(readWorkingFileObject(filePath)).resolves.toEqual({ id: '1', title: 'Hi' });
  });

  it('returns {} when the file does not exist', async () => {
    await expect(readWorkingFileObject(join(dir, 'missing.json'))).resolves.toEqual({});
  });

  it('returns {} for valid JSON that is not a top-level object', async () => {
    const filePath = join(dir, 'array.json');
    writeFileSync(filePath, JSON.stringify([1, 2, 3]));
    await expect(readWorkingFileObject(filePath)).resolves.toEqual({});
  });

  it('throws a descriptive error (not {}) for a truncated/corrupt file', async () => {
    const filePath = join(dir, 'corrupt.json');
    writeFileSync(filePath, '{"id":"1","title":"Hi'); // truncated mid-write
    await expect(readWorkingFileObject(filePath)).rejects.toThrow(/invalid JSON/);
  });

  it('throws for an empty (zero-byte) file rather than silently returning {}', async () => {
    const filePath = join(dir, 'empty.json');
    writeFileSync(filePath, '');
    await expect(readWorkingFileObject(filePath)).rejects.toThrow(/invalid JSON/);
  });
});
