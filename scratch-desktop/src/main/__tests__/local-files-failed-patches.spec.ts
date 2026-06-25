import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonPointerToFieldKey, readFailedRecordDetailsByFile } from '../local-files';

/**
 * Unit tests for the desktop side of the publish redesign (DEV-10048): reading
 * `failed-patches.json` and turning its entries into the grid's per-field /
 * record-level "failed to publish" annotation.
 */

describe('jsonPointerToFieldKey', () => {
  it('strips the leading slash and joins segments with dots', () => {
    expect(jsonPointerToFieldKey('/Organization')).toBe('Organization');
    expect(jsonPointerToFieldKey('/properties/city')).toBe('properties.city');
  });

  it('decodes JSON Pointer escapes (~1 → /, ~0 → ~)', () => {
    expect(jsonPointerToFieldKey('/a~1b')).toBe('a/b');
    expect(jsonPointerToFieldKey('/a~0b')).toBe('a~b');
  });
});

describe('readFailedRecordDetailsByFile', () => {
  const conn = 'conn1';
  const folderRel = 'Articles';
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'scratch-failed-patches-'));
  });
  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  const folderPath = () => join(workspacePath, conn, folderRel);

  function writeFailedPatches(patches: unknown[]) {
    const dir = join(workspacePath, '.scratch', 'connections', conn);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'failed-patches.json'), JSON.stringify({ version: 1, patches }));
  }

  it('returns an empty map when there is no failed-patches.json (the clean case)', async () => {
    const result = await readFailedRecordDetailsByFile(workspacePath, folderPath());
    expect(result.size).toBe(0);
  });

  it('indexes this folder’s entries by filename with per-field and record-level errors', async () => {
    writeFailedPatches([
      {
        path: 'Articles/bobby.json',
        kind: 'update',
        patch: [{ op: 'add', path: '/Organization', value: null }],
        error: 'Organization cannot be null',
        fieldErrors: { '/Organization': 'Organization cannot be null' },
      },
      {
        path: 'Articles/carol.json',
        kind: 'update',
        patch: [],
        error: 'rejected by service',
      },
    ]);

    const result = await readFailedRecordDetailsByFile(workspacePath, folderPath());

    expect(result.get('bobby.json')).toEqual({
      fields: { Organization: 'Organization cannot be null' },
      recordError: 'Organization cannot be null',
    });
    // Record-level error only (no fieldErrors) → empty fields map.
    expect(result.get('carol.json')).toEqual({ fields: {}, recordError: 'rejected by service' });
  });

  it('excludes entries that belong to a different folder', async () => {
    writeFailedPatches([
      { path: 'Articles/in-folder.json', kind: 'update', patch: [], error: 'e' },
      { path: 'Other/out-of-folder.json', kind: 'update', patch: [], error: 'e' },
    ]);

    const result = await readFailedRecordDetailsByFile(workspacePath, folderPath());

    expect(Array.from(result.keys())).toEqual(['in-folder.json']);
  });

  it('converts nested fieldErrors JSON Pointers to dot-path keys', async () => {
    writeFailedPatches([
      {
        path: 'Articles/nested.json',
        kind: 'update',
        patch: [],
        fieldErrors: { '/properties/city': 'bad city' },
      },
    ]);

    const result = await readFailedRecordDetailsByFile(workspacePath, folderPath());

    expect(result.get('nested.json')?.fields).toEqual({ 'properties.city': 'bad city' });
  });

  it('returns an empty map when failed-patches.json is malformed JSON', async () => {
    const dir = join(workspacePath, '.scratch', 'connections', conn);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'failed-patches.json'), '{ not valid json');

    const result = await readFailedRecordDetailsByFile(workspacePath, folderPath());

    expect(result.size).toBe(0);
  });
});
