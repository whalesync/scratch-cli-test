import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, idPath } from '../../../types';
import { getForeignKeyOptions, isForeignKey, isReadonlyField } from '../airtable-json-schema';

// Regression for DEV-10126. Airtable field names are user-typed and frequently
// contain `/` (e.g. `Date/heure de création`). Per RFC 6901 §3 these must be
// escaped before being interpolated into a JSON Pointer — otherwise the
// readonly / FK lookups walk the wrong sub-tree and silently return false.
describe('airtable JSON Pointer escaping (RFC 6901)', () => {
  const fieldWithSlash = 'Date/heure de création';
  const fieldWithTilde = 'priority~note';
  const fkOptions = { linkedTableId: 'tblOther' };

  function buildSpec(): BaseJsonTableSpec {
    return {
      id: { wsId: 't', remoteId: ['t'] },
      slug: 't',
      name: 't',
      schema: Type.Object({
        fields: Type.Object({
          [fieldWithSlash]: Type.String({
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions,
          }),
          [fieldWithTilde]: Type.String({ [X_SCRATCH_READONLY]: true }),
        }),
      }),
      idColumnRemoteId: idPath('id'),
    };
  }

  it('isReadonlyField handles field names containing `/`', () => {
    expect(isReadonlyField(fieldWithSlash, buildSpec())).toBe(true);
  });

  it('isReadonlyField handles field names containing `~`', () => {
    expect(isReadonlyField(fieldWithTilde, buildSpec())).toBe(true);
  });

  it('isForeignKey handles field names containing `/`', () => {
    expect(isForeignKey(fieldWithSlash, buildSpec())).toBe(true);
  });

  it('getForeignKeyOptions handles field names containing `/`', () => {
    expect(getForeignKeyOptions(fieldWithSlash, buildSpec())).toEqual(fkOptions);
  });
});
