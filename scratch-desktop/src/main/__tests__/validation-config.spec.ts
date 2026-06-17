import { describe, expect, it } from 'vitest';
import type { ValidatorConfig, ValidatorConfigEntry } from '../../shared/validation-types';
import { computeFoldersNeedingSchemaValidatorSeed } from '../validation-config';

function makeConfig(connection: string, folderPath: string, entries: ValidatorConfigEntry[]): ValidatorConfig {
  return {
    connection,
    folderPath,
    configFilePath: `.scratch/connections/scratch/${connection}/${folderPath ? `${folderPath}/` : ''}validation.json`,
    entries,
  };
}

describe('computeFoldersNeedingSchemaValidatorSeed', () => {
  it('seeds enforce_schema into every leaf folder that has no validation.json yet', () => {
    const result = computeFoldersNeedingSchemaValidatorSeed(['pipedrive/Deals', 'pipedrive/Notes'], []);

    expect(result.map((f) => `${f.connectionDirName}/${f.folderPath}`)).toEqual(['pipedrive/Deals', 'pipedrive/Notes']);
    for (const folder of result) {
      expect(folder.entriesToWrite).toHaveLength(1);
      expect(folder.entriesToWrite[0].validator).toBe('enforce_schema');
    }
  });

  it('preserves existing user validators and appends enforce_schema last', () => {
    const existing = [makeConfig('pipedrive', 'Deals', [{ validator: 'required', field: 'title' }])];

    const result = computeFoldersNeedingSchemaValidatorSeed(['pipedrive/Deals'], existing);

    expect(result).toHaveLength(1);
    expect(result[0].entriesToWrite.map((e) => e.validator)).toEqual(['required', 'enforce_schema']);
  });

  it('skips folders that already have an enforce_schema entry (idempotent)', () => {
    const existing = [makeConfig('pipedrive', 'Deals', [{ validator: 'enforce_schema' }])];

    const result = computeFoldersNeedingSchemaValidatorSeed(['pipedrive/Deals', 'pipedrive/Notes'], existing);

    expect(result.map((f) => `${f.connectionDirName}/${f.folderPath}`)).toEqual(['pipedrive/Notes']);
  });

  it('handles connection-root and nested leaf-folder names', () => {
    const result = computeFoldersNeedingSchemaValidatorSeed(['pipedrive', 'notion/db/sub'], []);

    expect(result[0]).toMatchObject({ connectionDirName: 'pipedrive', folderPath: '' });
    expect(result[1]).toMatchObject({ connectionDirName: 'notion', folderPath: 'db/sub' });
  });

  it('returns nothing when every folder is already seeded', () => {
    const existing = [
      makeConfig('pipedrive', 'Deals', [{ validator: 'enforce_schema' }]),
      makeConfig('pipedrive', 'Notes', [{ validator: 'enforce_schema' }]),
    ];

    const result = computeFoldersNeedingSchemaValidatorSeed(['pipedrive/Deals', 'pipedrive/Notes'], existing);

    expect(result).toEqual([]);
  });
});
