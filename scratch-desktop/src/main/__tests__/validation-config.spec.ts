import { describe, expect, it } from 'vitest';
import type { ValidatorConfig, ValidatorConfigEntry } from '../../shared/validation-types';
import { computeFoldersNeedingAutoSeededValidators } from '../validation-config';

function makeConfig(connection: string, folderPath: string, entries: ValidatorConfigEntry[]): ValidatorConfig {
  return {
    connection,
    folderPath,
    configFilePath: `.scratch/connections/scratch/${connection}/${folderPath ? `${folderPath}/` : ''}validation.json`,
    entries,
  };
}

describe('computeFoldersNeedingAutoSeededValidators', () => {
  it('seeds every auto-applied validator into a leaf folder that has no validation.json yet', () => {
    const result = computeFoldersNeedingAutoSeededValidators(['pipedrive/Deals', 'pipedrive/Notes'], []);

    expect(result.map((f) => `${f.connectionDirName}/${f.folderPath}`)).toEqual(['pipedrive/Deals', 'pipedrive/Notes']);
    for (const folder of result) {
      expect(folder.entriesToWrite.map((e) => e.validator)).toEqual(['enforce_schema', 'pseudo_ref_format']);
    }
  });

  it('preserves existing user validators and appends the auto-seeded ones last', () => {
    const existing = [makeConfig('pipedrive', 'Deals', [{ validator: 'required', field: 'title' }])];

    const result = computeFoldersNeedingAutoSeededValidators(['pipedrive/Deals'], existing);

    expect(result).toHaveLength(1);
    expect(result[0].entriesToWrite.map((e) => e.validator)).toEqual([
      'required',
      'enforce_schema',
      'pseudo_ref_format',
    ]);
  });

  it('skips folders that already have every auto-seeded validator (idempotent)', () => {
    const existing = [
      makeConfig('pipedrive', 'Deals', [{ validator: 'enforce_schema' }, { validator: 'pseudo_ref_format' }]),
    ];

    const result = computeFoldersNeedingAutoSeededValidators(['pipedrive/Deals', 'pipedrive/Notes'], existing);

    expect(result.map((f) => `${f.connectionDirName}/${f.folderPath}`)).toEqual(['pipedrive/Notes']);
  });

  // A workspace seeded before DEV-11238 has enforce_schema but not pseudo_ref_format. It must get
  // ONLY the missing one, without a duplicate enforce_schema entry.
  it('tops up a folder seeded by an older build with only the missing validator', () => {
    const existing = [makeConfig('pipedrive', 'Deals', [{ validator: 'enforce_schema' }])];

    const result = computeFoldersNeedingAutoSeededValidators(['pipedrive/Deals'], existing);

    expect(result).toHaveLength(1);
    expect(result[0].entriesToWrite.map((e) => e.validator)).toEqual(['enforce_schema', 'pseudo_ref_format']);
  });

  it('handles connection-root and nested leaf-folder names', () => {
    const result = computeFoldersNeedingAutoSeededValidators(['pipedrive', 'notion/db/sub'], []);

    expect(result[0]).toMatchObject({ connectionDirName: 'pipedrive', folderPath: '' });
    expect(result[1]).toMatchObject({ connectionDirName: 'notion', folderPath: 'db/sub' });
  });

  it('returns nothing when every folder is already seeded', () => {
    const existing = [
      makeConfig('pipedrive', 'Deals', [{ validator: 'enforce_schema' }, { validator: 'pseudo_ref_format' }]),
      makeConfig('pipedrive', 'Notes', [{ validator: 'enforce_schema' }, { validator: 'pseudo_ref_format' }]),
    ];

    const result = computeFoldersNeedingAutoSeededValidators(['pipedrive/Deals', 'pipedrive/Notes'], existing);

    expect(result).toEqual([]);
  });
});
