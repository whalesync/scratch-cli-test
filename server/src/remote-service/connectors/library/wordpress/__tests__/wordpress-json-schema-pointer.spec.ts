import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, idPath } from '../../../types';
import { getForeignKeyOptions, isForeignKey, isReadonlyField } from '../wordpress-json-schema';

// Regression for DEV-10126: WordPress meta keys / ACF field keys interpolated
// into JSON Pointer paths must be RFC 6901-escaped — separately for top-level
// fields and for nested ACF fields under `/properties/acf/properties/`.
describe('wordpress JSON Pointer escaping (RFC 6901)', () => {
  const fieldWithSlash = 'meta/key';
  const fieldWithTilde = 'meta~key';
  const fkOptions = { linkedTableId: 'wp_other' };

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
        acf: Type.Object({
          [fieldWithSlash]: Type.String({
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions,
          }),
        }),
      }),
      idColumnRemoteId: idPath('id'),
    };
  }

  it('isReadonlyField handles top-level field names containing `/`', () => {
    expect(isReadonlyField(fieldWithSlash, buildSpec())).toBe(true);
  });

  it('isReadonlyField handles top-level field names containing `~`', () => {
    expect(isReadonlyField(fieldWithTilde, buildSpec())).toBe(true);
  });

  it('isReadonlyField handles ACF field names containing `/`', () => {
    expect(isReadonlyField(fieldWithSlash, buildSpec(), true)).toBe(true);
  });

  it('isForeignKey handles top-level field names containing `/`', () => {
    expect(isForeignKey(fieldWithSlash, buildSpec())).toBe(true);
  });

  it('isForeignKey handles ACF field names containing `/`', () => {
    expect(isForeignKey(fieldWithSlash, buildSpec(), true)).toBe(true);
  });

  it('getForeignKeyOptions handles ACF field names containing `/`', () => {
    expect(getForeignKeyOptions(fieldWithSlash, buildSpec(), true)).toEqual(fkOptions);
  });
});
