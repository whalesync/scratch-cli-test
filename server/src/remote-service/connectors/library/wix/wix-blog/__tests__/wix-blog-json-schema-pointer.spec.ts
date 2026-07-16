import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../../types';
import { getForeignKeyOptions, isForeignKey, isReadonlyField } from '../wix-blog-json-schema';

// Regression for DEV-10126: Wix blog field names interpolated into JSON
// Pointer paths must be RFC 6901-escaped.
describe('wix-blog JSON Pointer escaping (RFC 6901)', () => {
  const fieldWithSlash = 'category/sub';
  const fieldWithTilde = 'note~final';
  const fkOptions = { linkedTableId: 'wix_other' };

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
      idPath: dotPath('_id'),
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

  // Regression for DEV-10805: isForeignKey used to compare the boolean result
  // of ValuePointer.Has against `undefined`, so it always returned true.
  it('isForeignKey returns false for a non-foreign-key field', () => {
    expect(isForeignKey(fieldWithTilde, buildSpec())).toBe(false);
  });

  it('getForeignKeyOptions handles field names containing `/`', () => {
    expect(getForeignKeyOptions(fieldWithSlash, buildSpec())).toEqual(fkOptions);
  });
});
