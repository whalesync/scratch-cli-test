import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../types';
import { getForeignKeyOptions, isForeignKey, isReadonlyField } from '../audienceful-json-schema';

// Regression for DEV-10126: Audienceful custom property names interpolated
// into JSON Pointer paths must be RFC 6901-escaped.
describe('audienceful JSON Pointer escaping (RFC 6901)', () => {
  const fieldWithSlash = 'tag/group';
  const fieldWithTilde = 'tag~group';
  const fkOptions = { linkedTableId: 'aud_other' };

  function buildSpec(): BaseJsonTableSpec {
    return {
      id: { wsId: 't', remoteId: ['t'] },
      slug: 't',
      name: 't',
      schema: Type.Object({
        [fieldWithSlash]: Type.String({
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions,
        }),
        [fieldWithTilde]: Type.String({ [X_SCRATCH_READONLY]: true }),
      }),
      idPath: dotPath('uid'),
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
